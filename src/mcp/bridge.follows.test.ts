import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { explainError } from "./bridge";
import { closeTestBridges, connectTestBridge, setupBridge as setup, type BridgeHarness } from "./bridge.fixtures";
import { ServiceError } from "./client";

/**
 * 一次委派与已有会话的关系：`follows` 把新会话接在另一个会话后面（不改变发起端），以及完全相同的委派只建一个会话（`allowDuplicate` 才放行第二个）。
 * 原先与其余桥测试同在 bridge.test.ts 里。
 */

afterEach(closeTestBridges);

describe("follows", () => {
  const review = { harness: "pi", task: "[fixture:quick] review", title: "Code review", cwd: tmpdir() };

  /** 同一个服务上的另一个桥，模拟“被委派的会话自己又调用了 Ensemble”（环境里带着上级会话）。 */
  async function nestedIn(host: BridgeHarness, parentId: string) {
    const nested = await connectTestBridge(host.service, { clientName: "nested-client", env: { ENSEMBLE_PARENT_SESSION: parentId } });
    return async (args: Record<string, unknown>) => {
      const result = await nested.call<{ sessionId: string }>("delegate", args);
      return { text: result.text, isError: result.isError, id: result.data?.sessionId as string };
    };
  }

  it("is an optional documented parameter that explains it does not change who started the work", async () => {
    const { client } = await setup();
    const delegate = (await client.listTools()).tools.find((tool) => tool.name === "delegate")!;
    const follows = (delegate.inputSchema.properties as Record<string, { description?: string }>)["follows"];
    expect(delegate.inputSchema.required).not.toContain("follows");
    expect(follows?.description).toContain("ses_");
    expect(follows?.description).toMatch(/does not change/i);
    expect(follows?.description).toMatch(/review/i);
  });

  it("sends follows as the parent, keeps the origin, and says so in the reply", async () => {
    const { call, service, sessions } = await setup();
    const reviewed = await call("delegate", review);
    const reviewId = reviewed.data?.["sessionId"] as string;

    // 首尾空白不影响：模型常把 id 连同引号旁的空格一起复制。
    const fix = await call("delegate", { harness: "pi", task: "[fixture:quick] fix R4", cwd: tmpdir(), follows: ` ${reviewId} ` });
    expect(fix.isError).toBe(false);
    const fixId = fix.data?.["sessionId"] as string;

    expect(service.hub.summary(fixId)).toMatchObject({ parentSessionId: reviewId, depth: 1 });
    expect(service.hub.summary(fixId)?.origin.key).toBe(service.hub.summary(reviewId)?.origin.key);
    expect(service.hub.summary(reviewId)?.childIds).toEqual([fixId]);
    expect(fix.text).toContain(`follows session ${reviewId} “Code review”`);
    expect(fix.text).not.toContain("nested under");
    // 干预同步与 status 仍按发起端走：两个会话都还是“我的会话”。
    const status = await call("status");
    expect(status.text).toContain(fixId);
    expect(status.text).toContain(reviewId);
    expect(sessions()).toHaveLength(2);
  });

  it("does not change anything when it is omitted", async () => {
    const { call, service } = await setup();
    const first = await call("delegate", review);
    const second = await call("delegate", { ...review, task: "[fixture:quick] second" });
    expect(second.text).not.toContain("follows session");
    expect(second.text).not.toContain("nested under");
    expect(service.hub.summary(second.data?.["sessionId"] as string)?.parentSessionId).toBeUndefined();
    expect(service.hub.summary(first.data?.["sessionId"] as string)?.childIds).toEqual([]);
  });

  it("takes precedence over the parent the bridge would have inferred, and says what it replaced", async () => {
    const host = await setup();
    const own = await host.call("delegate", { harness: "pi", task: "[fixture:long] my own parent", cwd: tmpdir() });
    const ownId = own.data?.["sessionId"] as string;
    const reviewed = await host.call("delegate", review);
    const reviewId = reviewed.data?.["sessionId"] as string;

    const delegateFromInside = await nestedIn(host, ownId);
    const plain = await delegateFromInside({ harness: "pi", task: "[fixture:quick] plain", cwd: tmpdir() });
    expect(host.service.hub.summary(plain.id)).toMatchObject({ parentSessionId: ownId, depth: 1 });
    expect(plain.text).toContain(`nested under session ${ownId}`);

    const explicit = await delegateFromInside({ harness: "pi", task: "[fixture:quick] explicit", cwd: tmpdir(), follows: reviewId });
    expect(host.service.hub.summary(explicit.id)).toMatchObject({ parentSessionId: reviewId, depth: 1 });
    expect(explicit.text).toContain(`follows session ${reviewId}`);
    expect(explicit.text).toContain(`not nested under session ${ownId}`);
    await host.call("cancel", { sessionId: ownId, stop: true });
  });

  it("names the missing session and points at `status`, without creating anything", async () => {
    const { call, sessions } = await setup();
    const result = await call("delegate", { harness: "pi", task: "[fixture:quick] fix", cwd: tmpdir(), follows: "ses_nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("ses_nope");
    expect(result.text).toContain("`status`");
    expect(result.text).toContain("`follows`");
    expect(result.text).not.toContain("invalid_request");
    expect(sessions()).toHaveLength(0);
  });

  it("explains how to get out of the depth limit when a chain of follow-ups is already too deep", async () => {
    const { call, sessions } = await setup();
    let previous: string | undefined;
    for (const name of ["a", "b", "c"]) {
      const result = await call("delegate", { harness: "pi", task: `[fixture:quick] ${name}`, cwd: tmpdir(), ...(previous ? { follows: previous } : {}) });
      expect(result.isError, name).toBe(false);
      previous = result.data?.["sessionId"] as string;
    }
    const tooDeep = await call("delegate", { harness: "pi", task: "[fixture:quick] d", cwd: tmpdir(), follows: previous });
    expect(tooDeep.isError).toBe(true);
    expect(tooDeep.text).toContain("depth 3");
    expect(tooDeep.text).toContain("Follow an earlier session");
    expect(tooDeep.text).toContain("omit `follows`");
    expect(tooDeep.text).not.toContain("Do the work yourself");
    expect(sessions()).toHaveLength(3);
  });

  it("keeps the old advice for a depth error that has nothing to do with follows", () => {
    const plain = explainError(new ServiceError("depth_exceeded", "Delegation depth 3 exceeds the limit of 2.", 422));
    expect(plain).toContain("Do the work yourself");
    const viaFollows = explainError(new ServiceError("depth_exceeded", "Delegation depth 3 exceeds the limit of 2.", 422, { via: "follows" }));
    expect(viaFollows).toContain("Follow an earlier session");
  });
});

describe("delegating the same thing twice", () => {
  const job = { harness: "pi", task: "[fixture:hold] Review the parser", cwd: tmpdir() };

  it("tells the main agent nothing new was started, and hands back the session that exists", async () => {
    const { call, sessions } = await setup();
    const first = await call("delegate", job);
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/^Delegated to /);
    expect(Object.keys(first.data ?? {}).sort()).toEqual(["harness", "panelUrl", "phase", "runId", "sessionId"]);

    const second = await call("delegate", { ...job, title: "Another label" });
    expect(second.isError).toBe(false);
    expect(second.text).toMatch(/^Not delegated again: an identical delegation was created (just now|\d+ s ago) as session /);
    expect(second.text).toContain(`as session ${first.data?.["sessionId"]} (phase `);
    expect(second.text).toContain("Nothing new was started");
    expect(second.text).toContain("Do not call `delegate` for it again");
    expect(second.text).toContain("Pass `allowDuplicate: true` only if you really want a second identical session.");
    expect(second.text).not.toContain("Delegated to");
    // 依赖结构化结果的调用方照常拿到真实存在的那个会话。
    expect(second.data).toMatchObject({
      sessionId: first.data?.["sessionId"],
      runId: first.data?.["runId"],
      panelUrl: first.data?.["panelUrl"],
      harness: "pi",
      duplicate: true,
    });
    expect(typeof second.data?.["duplicateAgeSeconds"]).toBe("number");
    expect(sessions()).toHaveLength(1);
  });

  it("starts a second identical session when allowDuplicate is true, and says it did", async () => {
    const { call, sessions } = await setup();
    const first = await call("delegate", job);
    const second = await call("delegate", { ...job, allowDuplicate: true });
    expect(second.text).toMatch(/^Delegated to /);
    expect(second.data).not.toHaveProperty("duplicate");
    expect(second.data?.["sessionId"]).not.toBe(first.data?.["sessionId"]);
    expect(sessions()).toHaveLength(2);
  });

  it("answers two identical calls made at the same time with one session", async () => {
    const { call, sessions } = await setup();
    const results = await Promise.all([call("delegate", job), call("delegate", job)]);
    expect(results.filter((result) => result.text.startsWith("Delegated to "))).toHaveLength(1);
    expect(results.filter((result) => result.text.startsWith("Not delegated again"))).toHaveLength(1);
    expect(new Set(results.map((result) => result.data?.["sessionId"])).size).toBe(1);
    expect(sessions()).toHaveLength(1);
  });

  it("does not mix up two different conversations that ask for the same thing", async () => {
    const { call, sessions } = await setup();
    const one = await call("delegate", job, { session_id: "thr-one" });
    const two = await call("delegate", job, { session_id: "thr-two" });
    expect(two.text).toMatch(/^Delegated to /);
    expect(two.data?.["sessionId"]).not.toBe(one.data?.["sessionId"]);
    expect(sessions()).toHaveLength(2);
  });

  it("documents allowDuplicate as an optional boolean that is for deliberate repeats only", async () => {
    const { client } = await setup();
    const delegate = (await client.listTools()).tools.find((tool) => tool.name === "delegate")!;
    const property = (delegate.inputSchema.properties as Record<string, { type?: string; description?: string }>)["allowDuplicate"];
    expect(property?.type).toBe("boolean");
    expect(property?.description).toContain("on purpose");
    expect(delegate.inputSchema.required).not.toContain("allowDuplicate");
    expect(delegate.description).toContain("within two minutes");
  });
});
