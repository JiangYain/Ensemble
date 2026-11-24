/**
 * 经真实本地 HTTP 改挂会话的上级（POST /api/sessions/:id/parent）：三份摘要推给页面、重启后仍在、令牌与来源防护、请求体校验、稳定的错误码。
 * 中枢与管理器这一层的改挂分别在 hub.relink.test.ts 与 manager.relink.test.ts。
 * 服务的安全、静态托管与生命周期在 service.test.ts；委派在 service.delegation.test.ts；执行端模型设置在 service.models.test.ts。
 */

import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import type { SessionDetail } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import type { RunningService } from "./service";
import { api, boot, closeServices, openStream, stopService, tempHome, type Api } from "./service.fixtures";
import { delegate } from "./service.http.fixtures";
import { until } from "./testing";

afterEach(closeServices);

describe("relinking a session over http", () => {
  async function finished(service: RunningService, client: Api, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const { body } = await delegate(client, `[fixture:quick] ${title}`, { origin: testOrigin(), ...extra });
    await until(() => service.hub.summary(body.sessionId)?.phase === "done", 6000, `${title} done`);
    return body.sessionId;
  }
  const parentOf = (service: RunningService, id: string) => service.hub.summary(id)?.parentSessionId;
  type RelinkBody = { changed: boolean; depthUpdated: string[]; summary: { parentSessionId?: string; depth: number } };

  it("moves a session between parents and pushes all three summaries to the page", async () => {
    const service = await boot();
    const client = api(service);
    const [review, other, fix] = [await finished(service, client, "review"), await finished(service, client, "other"), await finished(service, client, "fix")];
    const stream = await openStream(service);
    try {
      await until(() => stream.frames.some((frame) => frame.message.type === "snapshot"));
      const summaries = (id: string) => stream.frames.flatMap(({ message }) => (message.type === "summary" && message.summary.id === id ? [message.summary] : []));

      const first = await client.post(`/api/sessions/${fix}/parent`, { parentSessionId: review });
      expect(first.status).toBe(200);
      expect(await client.json<RelinkBody>(first)).toMatchObject({ changed: true, depthUpdated: [], summary: { parentSessionId: review, depth: 1 } });
      await until(() => summaries(review).at(-1)?.childIds.includes(fix) === true);
      expect(summaries(fix).at(-1)).toMatchObject({ parentSessionId: review, depth: 1 });

      // 从 review 挪到 other：旧上级、新上级和被改的会话三份摘要都要更新。
      await client.post(`/api/sessions/${fix}/parent`, { parentSessionId: other }, { "x-ensemble-client": "mcp" });
      await until(() => summaries(other).at(-1)?.childIds.includes(fix) === true);
      await until(() => summaries(review).at(-1)?.childIds.length === 0);
      expect(summaries(fix).at(-1)).toMatchObject({ parentSessionId: other });
      const events = stream.frames.flatMap(({ message }) => (message.type === "events" && message.sessionId === fix ? message.events : []));
      expect(events.filter((event) => event.kind === "session.relinked").map((event) => event.source)).toEqual(["user", "origin"]);

      const cleared = await client.post(`/api/sessions/${fix}/parent`, { parentSessionId: null });
      expect(await client.json<RelinkBody>(cleared)).toMatchObject({ changed: true, summary: { depth: 0 } });
      await until(() => summaries(other).at(-1)?.childIds.length === 0);
      expect("parentSessionId" in summaries(fix).at(-1)!).toBe(false);

      const same = await client.json<RelinkBody>(await client.post(`/api/sessions/${fix}/parent`, { parentSessionId: null }));
      expect(same.changed).toBe(false);
    } finally {
      stream.close();
    }
  });

  it("keeps the new parent after a restart", async () => {
    const home = tempHome();
    const first = await boot({ home });
    const client = api(first);
    const review = await finished(first, client, "review");
    const fix = await finished(first, client, "fix");
    await client.post(`/api/sessions/${fix}/parent`, { parentSessionId: review });
    await stopService(first);

    const second = await boot({ home });
    expect(parentOf(second, fix)).toBe(review);
    expect(second.hub.summary(review)?.childIds).toEqual([fix]);
    const detail = await api(second).json<SessionDetail>(await api(second).get(`/api/sessions/${fix}`));
    expect(detail.summary).toMatchObject({ parentSessionId: review, depth: 1 });
    expect(detail.events.some((event) => event.kind === "session.relinked")).toBe(true);
  });

  it("requires the token and refuses foreign origins and Host headers, changing nothing", async () => {
    const service = await boot();
    const client = api(service);
    const review = await finished(service, client, "review");
    const fix = await finished(service, client, "fix");
    const path = `/api/sessions/${fix}/parent`;
    const body = JSON.stringify({ parentSessionId: review });

    const anonymous = await fetch(`${service.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ error: { code: "invalid_token" } });
    const wrong = await fetch(`${service.url}${path}`, { method: "POST", headers: { [TOKEN_HEADER]: "nope", "content-type": "application/json" }, body });
    expect(wrong.status).toBe(403);
    const foreign = await client.post(path, { parentSessionId: review }, { origin: "https://evil.example.com" });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: "forbidden" } });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: service.port, path, method: "POST", headers: { host: "evil.example.com", [TOKEN_HEADER]: service.token, "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(status).toBe(403);
    expect(parentOf(service, fix)).toBeUndefined();

    const sameOrigin = await client.post(path, { parentSessionId: review }, { origin: service.url });
    expect(sameOrigin.status).toBe(200);
    expect(parentOf(service, fix)).toBe(review);
  });

  it("validates the body: the key is required, null is the only way to clear, an empty string is not null", async () => {
    const service = await boot();
    const client = api(service);
    const review = await finished(service, client, "review");
    const fix = await finished(service, client, "fix", { parentSessionId: review });
    const path = `/api/sessions/${fix}/parent`;
    const errorOf = async (response: Response) => (await client.json<{ error: { code: string; message: string } }>(response)).error;

    for (const bad of [{}, { parentSessionId: "" }, { parentSessionId: 7 }, { parentSessionId: false }, { parentSessionId: "x".repeat(101) }]) {
      const response = await client.post(path, bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect((await errorOf(response)).code).toBe("invalid_request");
    }
    expect((await errorOf(await client.post(path, { parentSessionId: "" }))).message).toContain("Use null");
    const notJson = await fetch(`${service.url}${path}`, { method: "POST", headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" }, body: "{nope" });
    expect(notJson.status).toBe(400);
    expect(parentOf(service, fix)).toBe(review);
  });

  it("answers with stable codes: not_found, invalid_request, conflict and depth_exceeded", async () => {
    const service = await boot();
    const client = api(service);
    const top = await finished(service, client, "top");
    const middle = await finished(service, client, "middle", { parentSessionId: top });
    const bottom = await finished(service, client, "bottom", { parentSessionId: middle });
    const loose = await finished(service, client, "loose");
    const errorOf = async (response: Response) => (await client.json<{ error: { code: string; message: string } }>(response)).error;

    const noSession = await client.post("/api/sessions/ses_missing/parent", { parentSessionId: top });
    expect(noSession.status).toBe(404);
    expect((await errorOf(noSession)).message).toContain("ses_missing");
    const noParent = await client.post(`/api/sessions/${loose}/parent`, { parentSessionId: "ses_nope" });
    expect(noParent.status).toBe(404);
    expect((await errorOf(noParent)).message).toContain("ses_nope");
    const self = await client.post(`/api/sessions/${loose}/parent`, { parentSessionId: loose });
    expect([self.status, (await errorOf(self)).code]).toEqual([400, "invalid_request"]);
    const loop = await client.post(`/api/sessions/${top}/parent`, { parentSessionId: bottom });
    expect([loop.status, (await errorOf(loop)).code]).toEqual([409, "conflict"]);
    const tooDeep = await client.post(`/api/sessions/${loose}/parent`, { parentSessionId: bottom });
    expect(tooDeep.status).toBe(422);
    expect(await errorOf(tooDeep)).toMatchObject({ code: "depth_exceeded", message: expect.stringContaining("limit of 2") });
    const missingGet = await client.get(`/api/sessions/${loose}/parent`);
    expect(missingGet.status).toBe(404);
    expect(parentOf(service, loose)).toBeUndefined();
  });
});
