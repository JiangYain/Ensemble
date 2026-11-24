import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../server/testing";
import { closeTestBridges, setupBridge as setup } from "./bridge.fixtures";

/**
 * `read` 的细分视角与批量读取经桥走一遍（参数解析与各视角的排版另有 read*.test.ts 逐项覆盖）：工具说明里的新参数、commands / errors / files 三个视角、
 * runIndex、afterSeq 游标、sessionIds 批量读取，以及 `wait` 在多个会话结束后对批量读取的提示。原先与其余桥测试同在 bridge.test.ts 里。
 */

afterEach(closeTestBridges);

describe("reading in finer detail", () => {
  /** 不带标签的任务走模拟执行端的完整场景：两次编辑、一次失败的 `npm test`、一次通过的 `npm test`、最终回答与用量。 */
  async function finished() {
    const harness = await setup();
    const delegated = await harness.call("delegate", { harness: "pi", task: "Split the parser into two layers", cwd: tmpdir() });
    const id = delegated.data?.["sessionId"] as string;
    await until(() => harness.service.hub.summary(id)?.phase === "done", 12_000);
    return { ...harness, id };
  }

  it("offers the new views without making any parameter required", async () => {
    const { client } = await setup();
    const read = (await client.listTools()).tools.find((tool) => tool.name === "read")!;
    expect(read.inputSchema.required ?? []).toEqual([]);
    const properties = read.inputSchema.properties as Record<string, { enum?: string[]; type?: string; maxItems?: number }>;
    expect(properties["view"]?.enum).toEqual(["result", "transcript", "files", "errors", "commands", "report"]);
    expect(properties["runIndex"]?.type).toMatch(/integer|number/);
    expect(properties["afterSeq"]?.type).toMatch(/integer|number/);
    expect(properties["sessionIds"]?.type).toBe("array");
    expect(properties["sessionIds"]?.maxItems).toBe(20);
    expect(read.description).toContain("cursor: #N");
    expect(read.description).toContain("sessionIds");
  });

  it("ends a read with a cursor, repeats it in the structured result, and puts the same number in status", async () => {
    const { call, id, service } = await finished();
    const seq = service.hub.summary(id)!.seq;
    const result = await call("read", { sessionId: id });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Final answer:");
    expect(result.text.split("\n").at(-1)).toBe(`cursor: #${seq} — pass afterSeq=${seq} to read only what happens after this`);
    expect(result.data?.["seq"]).toBe(seq);
    expect(result.data?.["view"]).toBe("result");

    const status = await call("status");
    expect((status.data?.["sessions"] as { id: string; seq: number }[]).find((session) => session.id === id)?.seq).toBe(seq);
  });

  it("lists the shell commands a session ran, with their exit codes", async () => {
    const { call, id } = await finished();
    const { text, isError } = await call("read", { sessionId: id, view: "commands" });
    expect(isError).toBe(false);
    expect(text).toContain("Shell commands: 2 in total — 1 ok, 1 failed.");
    expect(text).toMatch(/1\. failed \(exit 1\) · (<1s|\d+s) · npm test/);
    expect(text).toContain("FAIL src/parser/index.test.ts");
    expect(text).toMatch(/2\. ok · (<1s|\d+s) · npm test/);
  });

  it("shows only what failed, with the run and the event number", async () => {
    const { call, id } = await finished();
    const { text } = await call("read", { sessionId: id, view: "errors" });
    expect(text).toContain("Errors (1), newest first");
    expect(text).toMatch(/run 1 · #\d+ · \d\d:\d\d:\d\dZ — tool failed: shell `npm test` \(exit 1/);
    expect(text).toContain("parse › handles empty input");
  });

  it("lists the changed files once each, with the edits added up", async () => {
    const { call, id } = await finished();
    const { text } = await call("read", { sessionId: id, view: "files" });
    expect(text).toContain("Files changed (2)");
    expect(text).toContain("created src/parser/tokenizer.ts +68 −0 (2 edits)");
    expect(text).toContain("modified src/parser/index.ts +12 −41");
  });

  it("narrows a read to one run, and refuses a run that does not exist", async () => {
    const { call, id } = await finished();
    const one = await call("read", { sessionId: id, view: "commands", runIndex: 1 });
    expect(one.isError).toBe(false);
    expect(one.text).toContain("Run 1 of 1 · completed");
    expect(one.data?.["runIndex"]).toBe(1);

    const bad = await call("read", { sessionId: id, runIndex: 2 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("runIndex 2 is out of range");
    expect(bad.text).toContain("has 1 run (valid: 1)");
  });

  it("reads only what is new after a cursor, says when there is nothing new, and refuses a cursor from the future", async () => {
    const { call, id, service } = await finished();
    const cursor = (await call("read", { sessionId: id })).data?.["seq"] as number;

    const quiet = await call("read", { sessionId: id, afterSeq: cursor });
    expect(quiet.isError).toBe(false);
    expect(quiet.text.split("\n")).toHaveLength(2);
    expect(quiet.text).toContain(`No new events since #${cursor}.`);

    await call("send", { sessionId: id, text: "[fixture:quick] one more thing" });
    await until(() => service.hub.summary(id)?.runCount === 2 && service.hub.summary(id)?.phase === "done", 12_000);
    const fresh = await call("read", { sessionId: id, view: "transcript", afterSeq: cursor });
    expect(fresh.isError).toBe(false);
    expect(fresh.text).toContain(`Since #${cursor} —`);
    expect(fresh.text).toContain("one more thing");
    expect(fresh.text).not.toContain("handles empty input");
    expect(fresh.data?.["seq"]).toBe(service.hub.summary(id)!.seq);

    const beyond = await call("read", { sessionId: id, afterSeq: cursor + 500 });
    expect(beyond.isError).toBe(true);
    expect(beyond.text).toContain("is beyond the latest event");
  });

  it("collects several sessions in one call, and one that cannot be read does not spoil the others", async () => {
    const { call, id, service } = await finished();
    const second = (await call("delegate", { harness: "cursor", task: "[fixture:quick] a small one", cwd: tmpdir() })).data?.["sessionId"] as string;
    await until(() => service.hub.summary(second)?.phase === "done", 12_000);

    const batch = await call("read", { sessionIds: [id, "ses_missing", second, id] });
    expect(batch.isError).toBe(false);
    expect(batch.text).toContain("Read 3 sessions, in the order given");
    expect(batch.text).toContain("1 duplicate or blank id ignored.");
    expect(batch.text).toContain("ses_missing — could not be read: Session ses_missing does not exist.");
    expect(batch.text).toContain("usage (all runs): 12k tokens, cost $0.02");
    expect(batch.text).toContain("usage (all runs): 2.0k tokens, cost <$0.01");
    expect(batch.text.indexOf(id)).toBeLessThan(batch.text.indexOf("ses_missing"));
    expect(batch.text.indexOf("ses_missing")).toBeLessThan(batch.text.indexOf(second));

    expect(batch.data?.["view"]).toBe("batch");
    expect((batch.data?.["sessions"] as { id: string }[]).map((session) => session.id)).toEqual([id, second]);
    expect(batch.data?.["unreadable"]).toEqual([{ id: "ses_missing", reason: "Session ses_missing does not exist." }]);
  });

  it("refuses to mix one session with several, several with a view that needs one, and a read of nothing", async () => {
    const { call, id } = await finished();
    const both = await call("read", { sessionId: id, sessionIds: [id] });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("Pass either `sessionId`");

    const view = await call("read", { sessionIds: [id], view: "errors" });
    expect(view.isError).toBe(true);
    expect(view.text).toContain('cannot be combined with view="errors"');

    const nothing = await call("read", {});
    expect(nothing.isError).toBe(true);
    expect(nothing.text).toContain("Pass `sessionId`");
  });

  it("hints at the batch read once several sessions have finished, without touching the structured result", async () => {
    const { call, service } = await setup();
    const ids: string[] = [];
    for (const name of ["one", "two"]) ids.push((await call("delegate", { harness: "pi", task: `[fixture:quick] ${name}`, cwd: tmpdir() })).data?.["sessionId"] as string);
    await until(() => ids.every((id) => service.hub.summary(id)?.phase === "done"), 12_000);

    const waited = await call("wait", { timeoutSeconds: 10 });
    expect(waited.text).toContain("use `read` with `sessionIds`");
    expect(waited.data?.["reason"]).toBe("settled");
    expect(waited.data?.["sessions"]).toHaveLength(2);

    const alone = await setup();
    const only = (await alone.call("delegate", { harness: "pi", task: "[fixture:quick] solo", cwd: tmpdir() })).data?.["sessionId"] as string;
    await until(() => alone.service.hub.summary(only)?.phase === "done", 12_000);
    expect((await alone.call("wait", { timeoutSeconds: 10 })).text).not.toContain("sessionIds");
  });
});
