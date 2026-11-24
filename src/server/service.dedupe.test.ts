import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import type { DelegateResponse } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import { FixtureExecutor } from "./executors/fixture";
import { silentLogger } from "./logger";
import { startService, type RunningService } from "./service";
import { until } from "./testing";

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

async function boot(home = mkdtempSync(join(tmpdir(), "ensemble-home-"))): Promise<RunningService> {
  const service = await startService({
    home,
    port: 0,
    executors: [new FixtureExecutor("pi", { speed: 0 })],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
  });
  running.push(service);
  return service;
}

function post(service: RunningService, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${service.url}/api/sessions`, {
    method: "POST",
    headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const BODY = { harness: "pi", task: "[fixture:quick] Review the parser", cwd: tmpdir() };

async function delegated(response: Response): Promise<DelegateResponse> {
  return (await response.json()) as DelegateResponse;
}

const sessionCount = (service: RunningService): number => service.hub.sessionIds().length;

describe("POST /api/sessions: an identical delegation shortly after the first", () => {
  it("answers 201 for the first and 200 with the existing session for the second", async () => {
    const service = await boot();
    const first = await post(service, BODY);
    expect(first.status).toBe(201);
    const created = await delegated(first);
    expect(created).not.toHaveProperty("duplicate");

    const second = await post(service, BODY);
    expect(second.status).toBe(200);
    const repeated = await delegated(second);
    expect(repeated).toMatchObject({ sessionId: created.sessionId, runId: created.runId, messageId: created.messageId, summary: { id: created.sessionId } });
    expect(repeated.duplicate?.ageMs).toBeGreaterThanOrEqual(0);
    expect(repeated.duplicate?.ageMs).toBeLessThan(10_000);
    expect(sessionCount(service)).toBe(1);
  });

  it("is not defeated by a different title", async () => {
    const service = await boot();
    const created = await delegated(await post(service, { ...BODY, title: "First name" }));
    const second = await post(service, { ...BODY, title: "Second name" });
    expect(second.status).toBe(200);
    expect((await delegated(second)).sessionId).toBe(created.sessionId);
  });

  it("creates a new session when anything that matters differs", async () => {
    const service = await boot();
    await post(service, BODY);
    const other = await post(service, { ...BODY, task: "[fixture:quick] Review the lexer" });
    expect(other.status).toBe(201);
    expect(sessionCount(service)).toBe(2);
  });

  it("tells a console submission and an MCP bridge call apart by origin, not by wording", async () => {
    const service = await boot();
    const console1 = await delegated(await post(service, BODY));
    const bridge = await post(service, { ...BODY, origin: testOrigin() }, { "x-ensemble-client": "mcp" });
    expect(bridge.status).toBe(201);
    expect((await delegated(bridge)).sessionId).not.toBe(console1.sessionId);
    // 同一个桥来源再来一次才是重复。
    const again = await post(service, { ...BODY, origin: testOrigin() }, { "x-ensemble-client": "mcp" });
    expect(again.status).toBe(200);
  });

  it("is lifted by allowDuplicate: true, and only that request creates a second session", async () => {
    const service = await boot();
    const first = await delegated(await post(service, BODY));
    const forced = await post(service, { ...BODY, allowDuplicate: true });
    expect(forced.status).toBe(201);
    const second = await delegated(forced);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second).not.toHaveProperty("duplicate");
    expect(sessionCount(service)).toBe(2);
  });

  it("rejects an allowDuplicate that is not a boolean", async () => {
    const service = await boot();
    const response = await post(service, { ...BODY, allowDuplicate: "yes" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(sessionCount(service)).toBe(0);
  });

  it("creates one session out of eight requests sent at once, and only that one answers 201", async () => {
    const service = await boot();
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(service, BODY)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
    const bodies = await Promise.all(responses.map(delegated));
    expect(new Set(bodies.map((body) => body.sessionId)).size).toBe(1);
    expect(bodies.filter((body) => body.duplicate === undefined)).toHaveLength(1);
    expect(sessionCount(service)).toBe(1);
  });

  it("still recognises a finished session after the service has been restarted", async () => {
    const home = mkdtempSync(join(tmpdir(), "ensemble-home-"));
    const before = await boot(home);
    const created = await delegated(await post(before, BODY));
    await until(() => before.hub.summary(created.sessionId)?.phase === "done", 6000, "done");
    await before.close("restart");

    const after = await boot(home);
    expect(after.hub.sessionIds()).toEqual([created.sessionId]);
    const second = await post(after, BODY);
    expect(second.status).toBe(200);
    expect(await delegated(second)).toMatchObject({ sessionId: created.sessionId, runId: created.runId, duplicate: {} });
    expect(sessionCount(after)).toBe(1);
  });
});
