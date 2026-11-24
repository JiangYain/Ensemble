import { afterEach, describe, expect, it } from "vitest";
import { USER } from "@shared/testing";
import { shutdownTrackedEnvs, until } from "../testing";
import { finished, typedError, userEcho } from "./cursor-fake";
import { WAIT, completed, delegate, messageOf, runOf, runningRun, setup } from "./cursor-test-kit";

afterEach(shutdownTrackedEnvs);

// ───────────────────────── 纠偏 ─────────────────────────

describe("Cursor steering", () => {
  it("reports a steer as applied when Run.steer() settles with complete_delivered", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Skip the slow part", author: USER });
    expect(result.kind).toBe("steer");
    await until(() => messageOf(env, sessionId, result.messageId).delivery.stage === "applied", WAIT, "steer applied");
    const message = messageOf(env, sessionId, result.messageId);
    expect(message.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);
    expect(message.delivery.evidence).toContain("complete_delivered");
    expect(run.steerCalls).toEqual(["Skip the slow part"]);
    run.finish(finished("ok"));
  });

  it("hands off first and reports applied later when the SDK is still waiting to append the message", async () => {
    let release: (outcome: string) => void = () => undefined;
    const { env, fake } = setup({
      configure: (f) => (f.steerImpl = () => new Promise<string>((resolve) => (release = resolve))),
    });
    const { sessionId } = await delegate(env);
    const run = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Also check b.txt", author: USER });
    expect(result.stage).toBe("handed_off");
    expect(messageOf(env, sessionId, result.messageId).delivery.evidence).toContain("pending");

    release("complete_delivered");
    await until(() => messageOf(env, sessionId, result.messageId).delivery.stage === "applied", WAIT, "steer applied");
    expect(messageOf(env, sessionId, result.messageId).delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);
    run.finish(finished("ok"));
  });

  it("takes the user-message echo in the stream as evidence, once", async () => {
    let release: (outcome: string) => void = () => undefined;
    const { env, fake } = setup({
      configure: (f) => (f.steerImpl = () => new Promise<string>((resolve) => (release = resolve))),
    });
    const { sessionId } = await delegate(env);
    const run = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Skip the slow part", author: USER });
    run.push(userEcho("Skip the slow part"));
    await until(() => messageOf(env, sessionId, result.messageId).delivery.stage === "applied", WAIT, "steer applied");
    expect(messageOf(env, sessionId, result.messageId).delivery.evidence).toContain("stream event `user`");

    // 之后 steer() 才结算，不能重复上报。
    release("complete_delivered");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messageOf(env, sessionId, result.messageId).delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);
    run.finish(finished("ok"));
  });

  it("keeps an echo that arrives before steer() has answered", async () => {
    const { env, fake } = setup({
      configure: (f) =>
        (f.steerImpl = (text, run) => {
          run.push(userEcho(text));
          return new Promise<string>(() => undefined);
        }),
    });
    const { sessionId } = await delegate(env);
    const run = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Use the cached copy", author: USER });
    await until(() => messageOf(env, sessionId, result.messageId).delivery.stage === "applied", WAIT, "steer applied");
    const message = messageOf(env, sessionId, result.messageId);
    expect(message.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);
    expect(message.delivery.evidence).toContain("stream event `user`");
    run.finish(finished("ok"));
  });

  it("queues the message as an ordinary follow-up when the SDK reverts the steer", async () => {
    const { env, fake } = setup({ configure: (f) => (f.steerImpl = async () => "revert_to_followup") });
    const { sessionId } = await delegate(env);
    const first = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Also check b.txt", author: USER });
    expect(result.stage).toBe("queued");
    const queued = messageOf(env, sessionId, result.messageId).delivery;
    expect(queued.history.at(-1)).toMatchObject({ stage: "queued", queuedBy: "ensemble", reason: "run_in_progress" });
    expect(queued.evidence).toContain("revert_to_followup");

    first.finish(finished("first done"));
    const second = await runOf(fake, 1);
    expect(fake.sends[1]?.prompt).toBe("Also check b.txt");
    second.finish(finished("second done"));
    await until(completed(env, sessionId, 1), WAIT, "follow-up completed");
  });

  it("reports a late revert as a failed delivery with an actionable message", async () => {
    let release: (outcome: string) => void = () => undefined;
    const { env, fake } = setup({
      configure: (f) => (f.steerImpl = () => new Promise<string>((resolve) => (release = resolve))),
    });
    const { sessionId } = await delegate(env);
    const run = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Change course", author: USER });
    release("revert_to_followup");
    await until(() => messageOf(env, sessionId, result.messageId).delivery.stage === "failed", WAIT, "steer failed");
    expect(messageOf(env, sessionId, result.messageId).delivery.error).toMatchObject({ code: "steer_reverted" });
    run.finish(finished("ok"));
  });

  it("does not leave a pending steer unexplained when the run ends first", async () => {
    const { env, fake } = setup({ configure: (f) => (f.steerImpl = () => new Promise<string>(() => undefined)) });
    const { sessionId } = await delegate(env);
    const run = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Too late", author: USER });
    expect(result.stage).toBe("handed_off");
    run.finish(finished("done anyway"));
    await until(() => messageOf(env, sessionId, result.messageId).delivery.stage === "failed", WAIT, "steer resolved");
    expect(messageOf(env, sessionId, result.messageId).delivery.error).toMatchObject({ code: "run_ended" });
  });

  it("falls back to a follow-up when the SDK build has no steer()", async () => {
    const { env, fake } = setup({ configure: (f) => (f.supportsSteer = false) });
    const { sessionId } = await delegate(env);
    const first = await runningRun(env, fake, sessionId);

    const result = await env.manager.send(sessionId, { text: "Later, please", author: USER });
    expect(result.stage).toBe("queued");
    expect(messageOf(env, sessionId, result.messageId).delivery.evidence).toContain("not available");
    first.finish(finished("done"));
    await runOf(fake, 1);
    expect(fake.sends[1]?.prompt).toBe("Later, please");
  });

  it("treats UnsupportedRunOperationError as a follow-up and any other steer error as a failed delivery", async () => {
    const unsupported = setup({
      configure: (f) =>
        (f.steerImpl = async () => {
          throw typedError("UnsupportedRunOperationError", "steer is not supported");
        }),
    });
    const a = await delegate(unsupported.env);
    const runA = await runningRun(unsupported.env, unsupported.fake, a.sessionId);
    const sentA = await unsupported.env.manager.send(a.sessionId, { text: "Hello", author: USER });
    expect(sentA.stage).toBe("queued");
    runA.finish(finished("done"));

    const broken = setup({
      configure: (f) =>
        (f.steerImpl = async () => {
          throw new Error("socket closed");
        }),
    });
    const b = await delegate(broken.env);
    const runB = await runningRun(broken.env, broken.fake, b.sessionId);
    const sentB = await broken.env.manager.send(b.sessionId, { text: "Hello", author: USER });
    expect(sentB.stage).toBe("failed");
    expect(messageOf(broken.env, b.sessionId, sentB.messageId).delivery.error?.message).toContain("socket closed");
    runB.finish(finished("done"));
  });
});
