import { describe, expect, it, vi } from "vitest";
import { testMeta } from "@shared/testing";
import type { RunId } from "@shared/types";
import { silentLogger } from "../logger";
import { OpenCodeClient, type OpenCodeEvent } from "./opencode-api";
import { OpenCodeEventSession, newRun, terminalOf, type RunState } from "./opencode-events";
import { formTitle } from "./opencode-questions";
import type { ExecutorDraft, OpenInput, SteerOutcome } from "./types";

/**
 * OpenCode 的表单里“不是提问”的那一类（`metadata.kind` 不是 `question`）：它们仍按老办法处理——撤回表单、这一轮以失败收尾。
 * 老办法的原因文字引用表单标题；标题是执行端写的，可能带着密钥形状的内容，所以引用之前要先脱敏。
 * 这句话有两个去处：诊断（`opencode.question_unanswered`）与运行失败的错误（`run.blocked`，运行以它收尾）。
 * 只用桩出来的 HTTP 与事件通道，不起任何进程；提问表单的转交与撤回见 opencode-questions.test.ts。
 */

const RUN: RunId = "run_1";
const FORM_ID = "frm_1";
const CODE = "opencode.question_unanswered";

/** 只带事件分派的会话：没有进程、没有网络；`deliver` 就是真实环境里事件流做的事。 */
class DispatchOnly extends OpenCodeEventSession {
  constructor(input: OpenInput, client: OpenCodeClient) {
    super(input);
    this.rpc = client;
    this.sessionId = "ses_1";
  }

  startRun(): Promise<void> {
    return Promise.resolve();
  }

  steer(): Promise<SteerOutcome> {
    return Promise.resolve({ kind: "needs_follow_up", reason: "run_in_progress" });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  /** 开始一次运行：事件盖上它的运行编号，被拦下的原因也记在它名下。 */
  begin(runId: RunId): RunState {
    const run = newRun(runId, "msg_1");
    this.run = run;
    return run;
  }

  deliver(event: OpenCodeEvent): void {
    this.handle(event);
  }
}

function rig() {
  const emitted: ExecutorDraft[] = [];
  // 只用来承接 `request`：构造时不连任何东西，请求被拦下，从不触网。
  const client = new OpenCodeClient(new URL("http://127.0.0.1:1"), "unused");
  const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
  const input: OpenInput = {
    meta: testMeta({ harness: "opencode" }),
    emit: (draft) => {
      emitted.push(draft);
    },
    fatal: () => undefined,
    log: silentLogger,
    signal: new AbortController().signal,
  };
  return { session: new DispatchOnly(input, client), emitted, request };
}

/** 一个不是提问的表单；不给 `title` 就是没有标题。 */
const otherForm = (title?: string): OpenCodeEvent => ({
  type: "form.created",
  data: { form: { id: FORM_ID, sessionID: "ses_1", ...(title !== undefined ? { title } : {}), metadata: { kind: "other" }, fields: [] } },
});

const diagnosticsOf = (emitted: readonly ExecutorDraft[]) => emitted.flatMap((draft) => (draft.kind === "diagnostic" ? [draft.data] : []));

/** 取消这类表单时写下的那句话（诊断与运行失败的原因都是它）。 */
const said = (title: string): string =>
  `OpenCode asked for input ("${title}"). Ensemble cannot answer questions during a delegation, so it was cancelled and the run stopped.`;

describe("a form that is not a question: the title quoted when it is cancelled", () => {
  it.each([
    ["a bearer token", "Paste Bearer abcdefghijklmnop to continue", "Paste Bearer *** to continue", "abcdefghijklmnop"],
    ["an sk- key", "Use the key sk-abcdefghijkl to continue", "Use the key sk-*** to continue", "abcdefghijkl"],
    ["a token assignment", "Log in with token=abcdefghijkl1234 to continue", "Log in with token=*** to continue", "abcdefghijkl1234"],
  ] as Array<[string, string, string, string]>)("replaces %s in the diagnostic and in the reason the run ends with", (_what, title, shown, secret) => {
    const r = rig();
    const run = r.session.begin(RUN);
    r.session.deliver(otherForm(title));

    const message = said(shown);
    expect(diagnosticsOf(r.emitted)).toEqual([{ level: "warn", code: CODE, message }]);
    expect(run.blocked).toEqual({ code: CODE, message });
    // OpenCode 随后因为表单被撤回而中止这次执行：运行以这个原因失败，错误里同样只有脱敏后的标题。
    expect(terminalOf({ kind: "interrupted", reason: undefined }, run)).toEqual({ kind: "failed", error: { code: CODE, message } });
    // 整件事里没有任何一处带着原文：事件、被拦下的原因、发给 OpenCode 的请求。
    expect(JSON.stringify([r.emitted, run.blocked, r.request.mock.calls])).not.toContain(secret);
  });

  it("redacts before it shortens, so a key cut in half by the length limit is not left readable", () => {
    const r = rig();
    const run = r.session.begin(RUN);
    // 脱敏之前共 131 字：先截断（上限 120）会停在 "sk-abcd"，只剩 4 个字符，认不出是密钥；先脱敏则变成 118 字，原样放得下。
    r.session.deliver(otherForm(`${"a".repeat(111)} sk-abcdefghijklmnop`));

    const message = said(`${"a".repeat(111)} sk-***`);
    expect(diagnosticsOf(r.emitted)).toEqual([{ level: "warn", code: CODE, message }]);
    expect(run.blocked).toEqual({ code: CODE, message });
    expect(JSON.stringify([r.emitted, run.blocked])).not.toContain("sk-abc");
  });

  it("quotes the same redacted title when no run is active: there is no run to block, and the diagnostic carries no run id", () => {
    const r = rig();
    r.session.deliver(otherForm("Use the key sk-abcdefghijkl to continue"));

    expect(r.emitted).toEqual([{ kind: "diagnostic", data: { level: "warn", code: CODE, message: said("Use the key sk-*** to continue") } }]);
  });

  it("still cancels the form with a bare DELETE: no note, so OpenCode stops the whole run (the old way, unchanged)", () => {
    const r = rig();
    r.session.begin(RUN);
    r.session.deliver(otherForm("Pick a color"));

    expect(r.request.mock.calls).toEqual([["DELETE", `/api/session/ses_1/form/${FORM_ID}`, undefined, 10_000]]);
  });

  it("leaves the wording as it was for a title that has nothing to redact", () => {
    const r = rig();
    r.session.deliver(otherForm("Pick a color"));

    expect(diagnosticsOf(r.emitted).map((entry) => entry.message)).toEqual([
      'OpenCode asked for input ("Pick a color"). Ensemble cannot answer questions during a delegation, so it was cancelled and the run stopped.',
    ]);
  });

  it.each([
    ["no title", undefined, "a question"],
    ["a title with line breaks and runs of spaces", "  Pick\n a   color ", "Pick a color"],
    ["a title longer than 120 characters", "x".repeat(130), `${"x".repeat(119)}…`],
  ] as Array<[string, string | undefined, string]>)("keeps the title as it was for %s", (_what, title, shown) => {
    const r = rig();
    r.session.deliver(otherForm(title));

    expect(diagnosticsOf(r.emitted).map((entry) => entry.message)).toEqual([said(shown)]);
  });
});

describe("formTitle", () => {
  it("redacts, then folds to one line, then shortens to 120 characters; a form without a text title is 'a question'", () => {
    expect(formTitle({ title: "Use token=abcdefghijkl1234" })).toBe("Use token=***");
    expect(formTitle({ title: "Two\n lines" })).toBe("Two lines");
    expect(formTitle({ title: "y".repeat(121) })).toBe(`${"y".repeat(119)}…`);
    expect(formTitle({})).toBe("a question");
    expect(formTitle({ title: 42 })).toBe("a question");
  });
});
