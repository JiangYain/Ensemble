/**
 * 经真实本地 HTTP 测服务的基本面：访问令牌、Host / Origin 防护与请求体校验、静态托管、界面语言提示，以及服务的启动锁、陈旧锁恢复和重启后重载会话。
 * 委派、执行端模型设置、改挂上级各自在 service.delegation.test.ts、service.models.test.ts、service.relink.test.ts；
 * 它们共用 service.fixtures.ts 的真服务夹具与 service.http.fixtures.ts 的委派辅助。
 */

import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import type { SessionDetail } from "@shared/protocol";
import { AlreadyRunningError, startService, systemLang } from "./service";
import { api, boot, closeServices, stopService, tempHome } from "./service.fixtures";
import { delegate } from "./service.http.fixtures";
import { silentLogger } from "./logger";
import { until } from "./testing";

afterEach(closeServices);

describe("http security", () => {
  it("serves health without a token but requires it for everything else", async () => {
    const service = await boot();
    const health = await fetch(`${service.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "ensemble", pid: process.pid });

    const unauthorized = await fetch(`${service.url}/api/sessions`);
    expect(unauthorized.status).toBe(403);
    const wrong = await fetch(`${service.url}/api/sessions`, { headers: { [TOKEN_HEADER]: "nope" } });
    expect(wrong.status).toBe(403);
    const ok = await api(service).get("/api/sessions");
    expect(ok.status).toBe(200);
  });

  it("rejects unexpected Host headers (DNS rebinding) and foreign Origins on mutations", async () => {
    const service = await boot();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: service.port, path: "/api/health", headers: { host: "evil.example.com" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);

    const client = api(service);
    const foreign = await client.post("/api/sessions", { harness: "pi", task: "x", cwd: tmpdir() }, { origin: "https://evil.example.com" });
    expect(foreign.status).toBe(403);
    const sameOrigin = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir() }, { origin: service.url });
    expect(sameOrigin.status).toBe(201);
  });

  it("validates request bodies and reports stable error codes", async () => {
    const service = await boot();
    const client = api(service);
    const missing = await client.post("/api/sessions", { harness: "pi" });
    expect(missing.status).toBe(400);
    expect(await client.json<{ error: { code: string } }>(missing)).toMatchObject({ error: { code: "invalid_request" } });

    const badHarness = await client.post("/api/sessions", { harness: "codex", task: "x", cwd: tmpdir() });
    expect(badHarness.status).toBe(422);
    expect(await client.json<{ error: { code: string } }>(badHarness)).toMatchObject({ error: { code: "harness_unavailable" } });

    const notFound = await client.get("/api/sessions/ses_missing");
    expect(notFound.status).toBe(404);
    const unknownRoute = await client.get("/api/nope");
    expect(unknownRoute.status).toBe(404);
  });
});

describe("static hosting", () => {
  it("injects the token into index.html, falls back to it for client routes, and blocks traversal", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "ensemble-web-"));
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(
      join(webRoot, "index.html"),
      '<meta name="ensemble-token" content=""><meta name="ensemble-lang" content=""><div id="root"></div>',
    );
    writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");
    const service = await boot({ webRoot, env: { ENSEMBLE_LANG: "zh-CN" } });

    const index = await fetch(`${service.url}/`);
    const html = await index.text();
    expect(html).toContain(`content="${service.token}"`);
    expect(html).toContain('name="ensemble-lang" content="zh"');
    expect(index.headers.get("cache-control")).toBe("no-store");

    const spa = await fetch(`${service.url}/sessions/ses_123`);
    expect(await spa.text()).toContain(`content="${service.token}"`);

    const asset = await fetch(`${service.url}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${service.url}/assets/missing.js`)).status).toBe(404);

    const traversal = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: service.port, path: "/..%2f..%2fpackage.json" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect([403, 404]).toContain(traversal);
  });
});

describe("interface language hint", () => {
  it("lets ENSEMBLE_LANG override the system locale and ignores unknown values", () => {
    expect(systemLang({ ENSEMBLE_LANG: "zh-CN" })).toBe("zh");
    expect(systemLang({ ENSEMBLE_LANG: "EN" })).toBe("en");
    // 不认识的值回落到系统区域设置：结果只可能是中文、英文或没有提示。
    expect([undefined, "zh", "en"]).toContain(systemLang({ ENSEMBLE_LANG: "klingon" }));
  });
});

describe("service lifecycle", () => {
  it("refuses to start a second service on the same home and shuts down cleanly", async () => {
    const home = tempHome();
    const first = await boot({ home });
    await expect(
      startService({ home, port: 0, executors: [], log: silentLogger, webRoot: null, idleExitMs: 0 }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);

    const shutdown = await api(first).post("/api/shutdown");
    expect(shutdown.status).toBe(200);
    await first.closed;
    const again = await boot({ home });
    expect(again.port).toBeGreaterThan(0);
  });

  it("recovers from a stale lock left by a crashed service", async () => {
    const home = tempHome();
    const paths = (await import("./paths")).pathsFor(home);
    mkdirSync(paths.run, { recursive: true });
    writeFileSync(paths.lockFile, JSON.stringify({ pid: 2_000_000_000, startedAt: new Date().toISOString() }));
    const service = await boot({ home });
    expect(service.port).toBeGreaterThan(0);
  });

  it("reloads the same session on a fallback port and marks its unfinished run as interrupted", async () => {
    const home = tempHome();
    const first = await boot({ home });
    const client = api(first);
    const { body } = await delegate(client, "[fixture:long]");
    await until(() => first.hub.state(body.sessionId)?.status === "running");
    await stopService(first);

    const occupied = createServer();
    occupied.listen(first.port, "127.0.0.1");
    await once(occupied, "listening");
    try {
      const second = await boot({ home, port: first.port });
      expect(second.port).not.toBe(first.port);
      const client = api(second);
      const path = `/api/sessions/${body.sessionId}`;
      const detail = await client.json<SessionDetail>(await client.get(path));
      expect(detail.events.some((event) => event.kind === "run.started" && event.runId === body.runId)).toBe(true);
      const state = second.hub.state(body.sessionId);
      expect(state?.status).toBe("lost");
      expect(state?.runs[0]).toMatchObject({ status: "failed", error: { code: "service_stopped" } });
      const send = await client.post(`${path}/messages`, { text: "are you there?" });
      expect(send.status).toBe(409);
      expect(await send.json()).toMatchObject({ error: { code: "session_not_resumable" } });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
