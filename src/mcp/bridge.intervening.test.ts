import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import { until } from "../server/testing";
import { closeTestBridges, setupBridge as setup } from "./bridge.fixtures";

/**
 * 会话在跑的时候，主 Agent 与用户怎样介入、又怎样被告知：纠偏与中断后的补充消息、用户的直接干预带回主 Agent 并只送给发起它的宿主会话、
 * Full Access 与只读两个访问级别，以及服务给出的“值得留意”（`status` 的 attention 行与 `wait` 的提前返回）。原先与其余桥测试同在 bridge.test.ts 里。
 */

afterEach(closeTestBridges);

describe("intervening", () => {
  it("steers a running session and reports delivery honestly", async () => {
    const { call, service } = await setup();
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:hold] work", cwd: tmpdir() });
    const id = delegated.data?.["sessionId"] as string;
    await until(() => service.hub.summary(id)?.phase === "running", 6000);

    const sent = await call("send", { sessionId: id, text: "Skip the slow part." });
    expect(sent.isError).toBe(false);
    expect(sent.data?.["kind"]).toBe("steer");
    expect(sent.text).toMatch(/correction/);
    // 只有执行端确认过才能说“已生效”；其余阶段不得用这个措辞。
    if (sent.data?.["stage"] !== "applied") expect(sent.text).not.toContain("confirmed applied");
    await until(() => service.hub.summary(id)?.phase === "done", 6000);
  });

  it("interrupts a run without closing the session, then accepts a follow-up", async () => {
    const { call, service } = await setup();
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:long] keep going", cwd: tmpdir() });
    const id = delegated.data?.["sessionId"] as string;
    await until(() => service.hub.summary(id)?.phase === "running", 6000);

    const cancelled = await call("cancel", { sessionId: id });
    expect(cancelled.text).toContain("Requested interruption of the current run");
    await until(() => service.hub.summary(id)?.phase === "cancelled", 6000);

    const followUp = await call("send", { sessionId: id, text: "[fixture:quick] try a different approach" });
    expect(followUp.data?.["kind"]).toBe("follow_up");
    await until(() => service.hub.summary(id)?.runCount === 2 && service.hub.summary(id)?.phase === "done", 6000);

    const again = await call("cancel", { sessionId: id });
    expect(again.text).toContain("Nothing was running");
  });

  it("carries the user's direct interventions back to the main agent on its next call", async () => {
    const { call, service } = await setup();
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:hold] work", cwd: tmpdir() });
    const id = delegated.data?.["sessionId"] as string;
    await until(() => service.hub.summary(id)?.phase === "running", 6000);

    const response = await fetch(`${service.url}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
      body: JSON.stringify({ text: "Use tabs, not spaces." }),
    });
    expect(response.status).toBe(200);

    const status = await call("status");
    expect(status.text).toContain("While you were away, the user acted directly");
    expect(status.text).toContain("Use tabs, not spaces.");
    expect(status.data?.["notices"]).toHaveLength(1);

    // 只送达一次。
    const next = await call("status");
    expect(next.text).not.toContain("While you were away");
    await until(() => service.hub.summary(id)?.phase === "done", 6000);
  });

  it("delivers each intervention only to the host session that delegated the work", async () => {
    const { call, service } = await setup({ clientName: "codex-mcp-client" });
    const first = (await call("delegate", { harness: "pi", task: "[fixture:hold] one", cwd: tmpdir() }, { session_id: "thr-one" })).data?.["sessionId"] as string;
    const second = (await call("delegate", { harness: "pi", task: "[fixture:hold] two", cwd: tmpdir() }, { session_id: "thr-two" })).data?.["sessionId"] as string;
    await until(() => service.hub.summary(first)?.phase === "running" && service.hub.summary(second)?.phase === "running", 6000);

    for (const [id, text] of [[second, "Correction for two."], [first, "Correction for one."]] as const) {
      const response = await fetch(`${service.url}/api/sessions/${id}/messages`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      expect(response.status).toBe(200);
    }

    const a = await call("status", { scope: "mine" }, { session_id: "thr-one" });
    expect(a.data?.["sessions"]).toEqual([expect.objectContaining({ id: first })]);
    expect(a.data?.["notices"]).toEqual([expect.objectContaining({ sessionId: first, text: "Correction for one." })]);
    const anonymous = await call("status", { scope: "mine" });
    expect(anonymous.data?.["sessions"]).toEqual([]);
    expect(anonymous.data?.["notices"]).toBeUndefined();
    const b = await call("status", { scope: "mine" }, { session_id: "thr-two" });
    expect(b.data?.["sessions"]).toEqual([expect.objectContaining({ id: second })]);
    expect(b.data?.["notices"]).toEqual([expect.objectContaining({ sessionId: second, text: "Correction for two." })]);
    await until(() => service.hub.summary(first)?.phase === "done" && service.hub.summary(second)?.phase === "done", 6000);
  });

  it("delegates with Full Access by default and returns from wait the moment the user intervenes", async () => {
    const { call, service } = await setup();
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:hold] work", cwd: tmpdir() });
    const id = delegated.data?.["sessionId"] as string;
    expect(delegated.text).toContain("access: full");
    expect(service.hub.summary(id)?.access).toBe("full");
    await until(() => service.hub.summary(id)?.phase === "running", 6000);

    // 会话停在 hold 上等纠正，而不是在等任何人的授权；wait 应当一直等到用户介入。
    const waiting = call("wait", { timeoutSeconds: 10 });
    await fetch(`${service.url}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
      body: JSON.stringify({ text: "Use tabs, not spaces." }),
    });
    const woke = await waiting;
    expect(woke.data?.["reason"]).toBe("notice");
    expect(woke.text).toContain("Use tabs, not spaces.");
    expect(woke.text).not.toMatch(/approv|permission/i);

    let settled = await call("wait", { timeoutSeconds: 10 });
    if (settled.data?.["reason"] === "notice") settled = await call("wait", { timeoutSeconds: 10 });
    expect(settled.data?.["reason"]).toBe("settled");
  });

  it("can restrict a delegation to read-only, and lists exactly the two access levels", async () => {
    const { call, service } = await setup();
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] look around", cwd: tmpdir(), access: "read_only" });
    const id = delegated.data?.["sessionId"] as string;
    expect(service.hub.summary(id)?.access).toBe("read_only");
    expect(delegated.text).toContain("access: read_only");

    const harnesses = await call("harnesses");
    expect(harnesses.text).toContain("read_only:");
    expect(harnesses.text).toContain("full:");
    expect(harnesses.text).not.toContain("workspace_write");
  });
});

describe("things worth a look", () => {
  // 把“静默”缩到 0.7 秒：[fixture:hold] 开始后什么事件都不再发，这是真实的静默，不是手工登记的。
  const QUICK = { limits: { quietMs: 700, longToolMs: 700, longRunMs: 3_600_000, undeliveredMs: 3_600_000, sharedFileWindowMs: 600_000 }, tickMs: 100, settleMs: 50 };

  async function holdingSession() {
    const harness = await setup({ attention: QUICK });
    const id = (await harness.call("delegate", { harness: "pi", task: "[fixture:hold] work", cwd: tmpdir() })).data?.["sessionId"] as string;
    await until(() => harness.service.hub.summary(id)?.phase === "running", 6000);
    return { ...harness, id };
  }

  it("shows what the service noticed under the session, with evidence and no verdict", async () => {
    const { call, service, id } = await holdingSession();
    await until(() => (service.hub.summary(id)?.attention?.length ?? 0) > 0, 6000, "the session to be reported quiet");

    const status = await call("status");
    expect(status.text).toMatch(/attention: no events from Pi \(simulated\) for \d+s \(last event #\d+\) and no tool call is in progress/);
    expect(status.text).toContain("read the transcript");
    expect(status.text).not.toMatch(/stuck|hung|frozen/i);
    expect(status.data?.["sessions"]).toEqual([expect.objectContaining({ id, attention: [expect.objectContaining({ kind: "quiet" })] })]);
  });

  it("makes `wait` return as soon as something new shows up, but not for something it was already told about", async () => {
    const { call, id } = await holdingSession();

    const first = await call("wait", { timeoutSeconds: 20 });
    expect(first.data?.["reason"]).toBe("attention");
    expect(first.data?.["raised"]).toEqual([expect.objectContaining({ sessionId: id, kind: "quiet" })]);
    expect(first.text).toContain(`Session ${id} newly shows something worth a look`);
    expect(first.text).toContain("attention: no events from Pi");

    // 再等一次：同一件事已经存在，所以不会立刻返回；仍然把它连同会话一起带回来。
    const second = await call("wait", { timeoutSeconds: 1 });
    expect(second.data?.["reason"]).toBe("timeout");
    expect(second.data?.["raised"]).toBeUndefined();
    expect(second.text).toContain("attention: no events from Pi");
  });

  it("lets the agent opt out and wait strictly for completion", async () => {
    const { call } = await holdingSession();
    const response = await call("wait", { timeoutSeconds: 2, attention: false });
    expect(response.data?.["reason"]).toBe("timeout");
    expect(response.data?.["raised"]).toBeUndefined();
  });
});
