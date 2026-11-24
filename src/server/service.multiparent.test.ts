/**
 * 汇聚（一个会话跟随多个上级）经 HTTP 的端到端行为：真实的服务、假执行端、临时 home。
 * 只有一个上级的委派与改挂由 service.delegation.test.ts 与 service.relink.test.ts 守着，这里只管 `parentSessionIds` 以及它与老写法的衔接。
 */

import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, SERVICE_FEATURES } from "@shared/constants";
import type { HealthBody, RelinkResponse, SessionDetail } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import type { RunningService } from "./service";
import { api, boot, closeServices, openStream, stopService, tempHome, type Api } from "./service.fixtures";
import { until } from "./testing";

afterEach(closeServices);

interface Created {
  sessionId: string;
  runId: string;
  summary: SessionSummary;
  duplicate?: { ageMs: number };
}

async function delegate(client: Api, task: string, extra: Record<string, unknown> = {}) {
  const response = await client.post("/api/sessions", { harness: "pi", task, cwd: tmpdir(), origin: testOrigin(), ...extra });
  const body = await client.json<Created>(response);
  return { response, body };
}

/** 派一个很快做完的会话，等它结束，返回会话 id；`extra` 可以带上级。 */
async function finished(service: RunningService, client: Api, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { body } = await delegate(client, `[fixture:quick] ${title}`, extra);
  await until(() => service.hub.summary(body.sessionId)?.phase === "done", 6000, `${title} done`);
  return body.sessionId;
}

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };
const errorOf = async (client: Api, response: Response) => (await client.json<ErrorBody>(response)).error;

describe("delegating with several parents over http", () => {
  it("creates the session under every parent, with the first as the primary one", async () => {
    const service = await boot();
    const client = api(service);
    const a = await finished(service, client, "alpha");
    const b = await finished(service, client, "beta");

    const { response, body } = await delegate(client, "[fixture:quick] merge", { parentSessionIds: [a, b] });

    expect(response.status).toBe(201);
    expect(body.summary).toMatchObject({ parentSessionId: a, parentSessionIds: [a, b], depth: 1 });
    expect(service.hub.summary(a)?.childIds).toEqual([body.sessionId]);
    expect(service.hub.summary(b)?.childIds).toEqual([body.sessionId]);

    const detail = await client.json<SessionDetail>(await client.get(`/api/sessions/${body.sessionId}`));
    expect(detail.summary).toMatchObject({ parentSessionId: a, parentSessionIds: [a, b] });
    const created = detail.events.find((event) => event.kind === "session.created");
    expect(created).toMatchObject({ data: { meta: { parentSessionId: a, parentSessionIds: [a, b] } } });
  });

  it("gives a session with one parent no parentSessionIds, in the summary or in the log", async () => {
    const service = await boot();
    const client = api(service);
    const a = await finished(service, client, "alpha");

    const { body } = await delegate(client, "[fixture:quick] single", { parentSessionId: a });
    // 只有一个元素的 parentSessionIds 与 parentSessionId 是同一个意思，同样不留下集合。
    const { body: viaList } = await delegate(client, "[fixture:quick] single as a list", { parentSessionIds: [a] });

    for (const created of [body, viaList]) {
      expect(created.summary.parentSessionId).toBe(a);
      expect("parentSessionIds" in created.summary).toBe(false);
    }
    const detail = await client.json<SessionDetail>(await client.get(`/api/sessions/${viaList.sessionId}`));
    const meta = detail.events.flatMap((event) => (event.kind === "session.created" ? [event.data.meta] : []))[0]!;
    expect("parentSessionIds" in meta).toBe(false);
  });

  it("accepts the old field next to the list when it is the first entry, and refuses it otherwise", async () => {
    const service = await boot();
    const client = api(service);
    const a = await finished(service, client, "alpha");
    const b = await finished(service, client, "beta");

    const agreeing = await delegate(client, "[fixture:quick] agree", { parentSessionId: a, parentSessionIds: [a, b] });
    expect(agreeing.response.status).toBe(201);
    expect(agreeing.body.summary.parentSessionIds).toEqual([a, b]);

    const count = service.hub.sessionIds().length;
    const conflicting = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] disagree", cwd: tmpdir(), origin: testOrigin(), parentSessionId: b, parentSessionIds: [a, b] });
    expect(conflicting.status).toBe(400);
    expect((await errorOf(client, conflicting)).code).toBe("invalid_request");
    expect(service.hub.sessionIds()).toHaveLength(count);
  });

  it("names every missing parent at once and creates nothing", async () => {
    const service = await boot();
    const client = api(service);
    const a = await finished(service, client, "alpha");
    const count = service.hub.sessionIds().length;

    const response = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] merge", cwd: tmpdir(), origin: testOrigin(), parentSessionIds: [a, "ses_gone1", "ses_gone2"] });

    expect(response.status).toBe(404);
    const error = await errorOf(client, response);
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("ses_gone1");
    expect(error.message).toContain("ses_gone2");
    expect(service.hub.sessionIds()).toHaveLength(count);
  });

  it("answers 400 for a list that is empty, too long, or not a list of strings", async () => {
    const service = await boot();
    const client = api(service);
    const a = await finished(service, client, "alpha");
    const tooMany = Array.from({ length: LIMITS.maxParents + 1 }, (_, index) => `ses_x${index}`);
    const count = service.hub.sessionIds().length;

    for (const bad of [[], tooMany, [1], [""], "ses_a", { 0: a }]) {
      const response = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] bad", cwd: tmpdir(), origin: testOrigin(), parentSessionIds: bad });
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect((await errorOf(client, response)).code).toBe("invalid_request");
    }
    expect(service.hub.sessionIds()).toHaveLength(count);
  });

  it("measures the nesting depth by the longest chain and says which parent is the deepest", async () => {
    const service = await boot();
    const client = api(service);
    const top = await finished(service, client, "top");
    const middle = await finished(service, client, "middle", { parentSessionId: top });
    const bottom = await finished(service, client, "bottom", { parentSessionId: middle });

    // top 的层数是 0，bottom 是 2：把它们都当上级，新会话在第 3 层，超过默认上限 2，即使第一个上级很浅。
    const response = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] too deep", cwd: tmpdir(), origin: testOrigin(), parentSessionIds: [top, bottom] });

    expect(response.status).toBe(422);
    const error = await errorOf(client, response);
    expect(error.code).toBe("depth_exceeded");
    expect(error.message).toContain(bottom);
    expect(error.details).toMatchObject({ depth: 3, maxDepth: 2, parentSessionId: top, parentSessionIds: [top, bottom], deepestParentId: bottom });
  });

  it("compares the parents as a set when it recognises a repeated delegation", async () => {
    const service = await boot();
    const client = api(service);
    const a = await finished(service, client, "alpha");
    const b = await finished(service, client, "beta");

    const first = await delegate(client, "[fixture:quick] merge once", { parentSessionIds: [a, b] });
    expect(first.response.status).toBe(201);

    const reordered = await delegate(client, "[fixture:quick] merge once", { parentSessionIds: [b, a] });
    expect(reordered.response.status).toBe(200);
    expect(reordered.body.sessionId).toBe(first.body.sessionId);
    expect(reordered.body).toHaveProperty("duplicate");

    const fewer = await delegate(client, "[fixture:quick] merge once", { parentSessionIds: [a] });
    expect(fewer.response.status).toBe(201);
    expect(fewer.body.sessionId).not.toBe(first.body.sessionId);
  });

  it("announces the capability, so a bridge can tell an old service from this one", async () => {
    const service = await boot();
    const health = (await (await fetch(`${service.url}/api/health`)).json()) as HealthBody;
    expect(health.features).toContain("multi-parent");
    expect(SERVICE_FEATURES).toContain("multi-parent");
  });
});

describe("relinking to several parents over http", () => {
  it("replaces the whole set and pushes the moved session and every parent whose children changed", async () => {
    const service = await boot();
    const client = api(service);
    const [review, other, fix] = [await finished(service, client, "review"), await finished(service, client, "other"), await finished(service, client, "fix")];
    const stream = await openStream(service);
    try {
      await until(() => stream.frames.some((frame) => frame.message.type === "snapshot"));
      const summaries = (id: string) => stream.frames.flatMap(({ message }) => (message.type === "summary" && message.summary.id === id ? [message.summary] : []));

      const joined = await client.post(`/api/sessions/${fix}/parent`, { parentSessionIds: [review, other] });
      expect(joined.status).toBe(200);
      expect(await client.json<RelinkResponse>(joined)).toMatchObject({
        changed: true,
        depthUpdated: [],
        summary: { parentSessionId: review, parentSessionIds: [review, other], depth: 1 },
      });
      await until(() => summaries(review).at(-1)?.childIds.includes(fix) === true);
      await until(() => summaries(other).at(-1)?.childIds.includes(fix) === true);
      expect(summaries(fix).at(-1)).toMatchObject({ parentSessionId: review, parentSessionIds: [review, other] });

      // 用老写法改回一个上级：集合清掉，没有留下的上级收到新的摘要。
      const single = await client.post(`/api/sessions/${fix}/parent`, { parentSessionId: other });
      expect(await client.json<RelinkResponse>(single)).toMatchObject({ changed: true, summary: { parentSessionId: other, depth: 1 } });
      await until(() => {
        const last = summaries(fix).at(-1);
        return last !== undefined && last.parentSessionId === other && !("parentSessionIds" in last);
      });
      await until(() => summaries(review).at(-1)?.childIds.length === 0);
      expect(summaries(other).at(-1)?.childIds).toEqual([fix]);
    } finally {
      stream.close();
    }
  });

  it("does nothing for the same list, and treats a new order as a change of the primary parent", async () => {
    const service = await boot();
    const client = api(service);
    const [a, b, fix] = [await finished(service, client, "a"), await finished(service, client, "b"), await finished(service, client, "fix")];
    const path = `/api/sessions/${fix}/parent`;

    await client.post(path, { parentSessionIds: [a, b] });
    const same = await client.json<RelinkResponse>(await client.post(path, { parentSessionIds: [a, b] }));
    expect(same.changed).toBe(false);

    const reordered = await client.json<RelinkResponse>(await client.post(path, { parentSessionIds: [b, a] }));
    expect(reordered.changed).toBe(true);
    expect(reordered.summary).toMatchObject({ parentSessionId: b, parentSessionIds: [b, a] });
  });

  it("answers with stable codes for the new forms and changes nothing when it refuses", async () => {
    const service = await boot();
    const client = api(service);
    const top = await finished(service, client, "top");
    const middle = await finished(service, client, "middle", { parentSessionId: top });
    const bottom = await finished(service, client, "bottom", { parentSessionId: middle });
    const loose = await finished(service, client, "loose");
    const before = () => [top, middle, bottom, loose].map((id) => service.hub.summary(id)?.seq);
    const seqs = before();
    const code = async (id: string, body: unknown) => {
      const response = await client.post(`/api/sessions/${id}/parent`, body);
      return [response.status, (await errorOf(client, response)).code] as const;
    };

    expect(await code(loose, { parentSessionIds: [] })).toEqual([400, "invalid_request"]);
    expect(await code(loose, { parentSessionId: top, parentSessionIds: [middle, top] })).toEqual([400, "invalid_request"]);
    expect(await code(loose, { parentSessionId: null, parentSessionIds: [top] })).toEqual([400, "invalid_request"]);
    expect(await code(loose, { parentSessionIds: [top, loose] })).toEqual([400, "invalid_request"]);
    expect(await code(loose, { parentSessionIds: [top, "ses_nope"] })).toEqual([404, "not_found"]);
    expect(await code(top, { parentSessionIds: [loose, bottom] })).toEqual([409, "conflict"]);
    expect(await code(loose, { parentSessionIds: [top, bottom] })).toEqual([422, "depth_exceeded"]);

    const missing = await client.post(`/api/sessions/${loose}/parent`, { parentSessionIds: ["ses_nope1", top, "ses_nope2"] });
    const message = (await errorOf(client, missing)).message;
    expect(message).toContain("ses_nope1");
    expect(message).toContain("ses_nope2");
    expect(before()).toEqual(seqs);
    expect(service.hub.summary(loose)?.parentSessionId).toBeUndefined();
  });

  it("keeps the join after a restart, with the parents' child lists rebuilt from it", async () => {
    const home = tempHome();
    const first = await boot({ home });
    const client = api(first);
    const a = await finished(first, client, "alpha");
    const b = await finished(first, client, "beta");
    const { body } = await delegate(client, "[fixture:quick] merge", { parentSessionIds: [a, b] });
    await until(() => first.hub.summary(body.sessionId)?.phase === "done", 6000, "merge done");
    await stopService(first);

    const second = await boot({ home });
    expect(second.hub.summary(body.sessionId)).toMatchObject({ parentSessionId: a, parentSessionIds: [a, b], depth: 1 });
    expect(second.hub.summary(a)?.childIds).toEqual([body.sessionId]);
    expect(second.hub.summary(b)?.childIds).toEqual([body.sessionId]);
  });
});
