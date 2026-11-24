import { describe, expect, it, vi } from "vitest";
import type { AccessLevel } from "@shared/types";
import { CodexQuestions } from "./codex-questions";
import { answerServerRequest, noticeOf, type DiagnosticLevel, type ServerRequestContext } from "./codex-side-channel";

const notice = (method: string, params: Record<string, unknown>, seen = new Set<string>()) => noticeOf(method, params, seen);

describe("noticeOf", () => {
  it("keeps real warnings at warn but downgrades the experimental-features reminder to info", () => {
    expect(notice("warning", { message: "Something   odd\nhappened" })).toEqual({ level: "warn", code: "codex.warning", message: "Something odd happened" });
    expect(notice("warning", { message: "Under-development features enabled: x, y" })?.level).toBe("info");
    expect(notice("warning", {})).toBeUndefined();
  });

  it("joins a summary and its details into one line", () => {
    expect(notice("configWarning", { summary: "Bad config", details: "line 3" })).toEqual({
      level: "warn",
      code: "codex.config_warning",
      message: "Bad config — line 3",
    });
    expect(notice("deprecationNotice", { summary: "Old flag" })).toEqual({ level: "info", code: "codex.deprecation", message: "Old flag" });
  });

  it("maps guardian warnings and context compaction", () => {
    expect(notice("guardianWarning", { message: "Blocked" })).toEqual({ level: "warn", code: "codex.guardian_warning", message: "Blocked" });
    expect(notice("thread/compacted", {})).toMatchObject({ level: "info", code: "codex.compacted" });
  });

  it("says which model the request was rerouted from and to, and why", () => {
    expect(notice("model/rerouted", { fromModel: "a", toModel: "b", reason: "capacity" })?.message).toBe('Codex rerouted the request from "a" to "b" (capacity).');
    expect(notice("model/rerouted", {})?.message).toBe('Codex rerouted the request from "?" to "?" (unspecified reason).');
  });

  it("lists at most three world-writable sample paths and counts the rest", () => {
    const message = notice("windows/worldWritableWarning", { samplePaths: ["C:/a", "C:/b", "C:/c", "C:/d"], extraCount: 5 })?.message;
    expect(message).toContain("(e.g. C:/a, C:/b, C:/c, +5 more)");
    expect(message).not.toContain("C:/d");
    expect(notice("windows/worldWritableWarning", {})?.message).toBe(
      "Codex's Windows sandbox cannot fully protect world-writable directories; writes there may not be blocked.",
    );
  });

  it("reports a failed MCP server once, without repeating Codex's own prefix", () => {
    const seen = new Set<string>();
    const params = { status: "failed", name: "docs", error: "MCP client for `docs` failed to start: MCP startup failed: spawn ENOENT" };
    expect(notice("mcpServer/startupStatus/updated", params, seen)?.message).toBe('MCP server "docs" failed to start: MCP startup failed: spawn ENOENT');
    expect(notice("mcpServer/startupStatus/updated", params, seen)).toBeUndefined();
    expect(notice("mcpServer/startupStatus/updated", { status: "ready", name: "other" }, seen)).toBeUndefined();
    expect(notice("mcpServer/startupStatus/updated", { status: "failed", name: "bare" }, seen)?.message).toBe('MCP server "bare" failed to start.');
  });

  it("ignores notifications that are not diagnostics", () => {
    expect(notice("turn/started", {})).toBeUndefined();
  });
});

describe("answerServerRequest", () => {
  function harness(access: AccessLevel, titles: Record<string, string> = {}, questions?: ServerRequestContext["questions"]) {
    const replies: { id: number | string; kind: "result" | "error"; payload: unknown }[] = [];
    const diagnostics: { level: DiagnosticLevel; code: string; message: string }[] = [];
    const answer = (id: number | string, method: string, params: Record<string, unknown>) =>
      answerServerRequest(
        {
          rpc: {
            respond: (replyId, result) => {
              replies.push({ id: replyId, kind: "result", payload: result });
              return true;
            },
            respondError: (replyId, code, message) => {
              replies.push({ id: replyId, kind: "error", payload: { code, message } });
              return true;
            },
          },
          access,
          diagnostic: (level, code, message) => {
            diagnostics.push({ level, code, message });
          },
          titleOf: (itemId) => titles[itemId],
          ...(questions ? { questions } : {}),
        },
        id,
        method,
        params,
      );
    return { answer, replies, diagnostics };
  }

  it("grants approvals to Full Access sessions and says so on the timeline", () => {
    const { answer, replies, diagnostics } = harness("full");
    answer(1, "item/commandExecution/requestApproval", { command: "npm test" });
    expect(replies).toEqual([{ id: 1, kind: "result", payload: { decision: "accept" } }]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ level: "info", code: "codex.approval_granted", message: expect.stringContaining('("npm test")') }),
    ]);
  });

  it("declines approvals in read-only sessions", () => {
    const { answer, replies, diagnostics } = harness("read_only");
    answer(2, "item/fileChange/requestApproval", { itemId: "i1" });
    expect(replies).toEqual([{ id: 2, kind: "result", payload: { decision: "decline" } }]);
    expect(diagnostics[0]).toMatchObject({ level: "warn", code: "codex.approval_declined" });
  });

  it("describes a file-change approval by the tool title it already shows", () => {
    const { answer, diagnostics } = harness("full", { i1: "src/a.ts" });
    answer(3, "item/fileChange/requestApproval", { itemId: "i1", reason: "ignored when the title is known" });
    expect(diagnostics[0]?.message).toContain('("src/a.ts")');
  });

  it("only passes the requested permissions through when access is full", () => {
    const requested = { network: { enabled: true }, fileSystem: { write: ["/tmp"] } };
    const full = harness("full");
    full.answer(4, "item/permissions/requestApproval", { permissions: requested });
    expect(full.replies[0]?.payload).toEqual({ permissions: requested, scope: "turn" });
    const readOnly = harness("read_only");
    readOnly.answer(5, "item/permissions/requestApproval", { permissions: requested });
    expect(readOnly.replies[0]?.payload).toEqual({ permissions: {}, scope: "turn" });
  });

  it("answers questions with an error instead of an empty answer", () => {
    const { answer, replies, diagnostics } = harness("full");
    answer(6, "item/tool/requestUserInput", { questions: [{ question: "Which one?" }, { question: "Really?" }] });
    expect(replies[0]).toMatchObject({ id: 6, kind: "error", payload: { code: -32000 } });
    expect(diagnostics[0]).toMatchObject({ code: "codex.question_unanswered", message: expect.stringContaining("Which one? / Really?") });
  });

  it("hands a question to the relay when there is one, and then neither answers nor reports it itself", () => {
    const relayed: unknown[] = [];
    const { answer, replies, diagnostics } = harness("full", {}, {
      relay: (id, params) => {
        relayed.push([id, params]);
        return true;
      },
    });
    answer(8, "item/tool/requestUserInput", { questions: [{ id: "q", question: "Which one?" }] });
    expect(relayed).toEqual([[8, { questions: [{ id: "q", question: "Which one?" }] }]]);
    expect(replies).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("falls back to telling Codex a question cannot be relayed when the relay does not take it", () => {
    const { answer, replies, diagnostics } = harness("full", {}, { relay: () => false });
    answer(9, "item/tool/requestUserInput", { questions: [{ question: "Which one?" }] });
    expect(replies[0]).toMatchObject({ id: 9, kind: "error", payload: { code: -32000 } });
    expect(diagnostics[0]).toMatchObject({ code: "codex.question_unanswered" });
  });

  // 退回这条路时，诊断引用的是模型写的字：机密类提问一个字也不能进去，其余的先脱敏再截断。
  describe("the diagnostic for a question that cannot be relayed", () => {
    const LEAD = "Codex asked a question that Ensemble cannot relay: ";
    // 给 Codex 的应答不变：这一句与错误码，改动前后逐字相同。
    const REFUSAL = "Ensemble cannot relay questions to a person. Make a reasonable assumption, state it in your answer, and continue.";
    const refused = (id: number) => [{ id, kind: "error", payload: { code: -32000, message: REFUSAL } }];
    const ONE_SECRET = "1 question asked for a secret value (text not recorded)";
    // 机密类提问：问题、标题、选项里各放着同一个词，哪一处被引用了都看得出来。
    const SECRET = {
      id: "db",
      header: "ZEBRA-SECRET-HOST",
      question: "What is the production database password for ZEBRA-SECRET-HOST?",
      isSecret: true,
      options: [{ label: "ZEBRA-SECRET-HOST", description: "the production database password" }],
    };

    it.each([
      ["nothing is wired up to relay questions", undefined],
      ["the relay does not take it", { relay: () => false }],
    ] as Array<[string, ServerRequestContext["questions"]]>)("never quotes a question that asks for a secret when %s", (_when, relay) => {
      const { answer, replies, diagnostics } = harness("full", {}, relay);
      answer(11, "item/tool/requestUserInput", { questions: [SECRET] });

      expect(replies).toEqual(refused(11));
      // 整条诊断只有固定的字和一个个数，没有任何一个词来自模型。
      expect(diagnostics).toEqual([{ level: "warn", code: "codex.question_unanswered", message: `${LEAD}${ONE_SECRET}` }]);
      expect(JSON.stringify(diagnostics)).not.toContain("ZEBRA");
      expect(JSON.stringify(diagnostics)).not.toContain("production database password");
    });

    it("never lets a secret question without an id into anything that is written, whichever layer ends up answering it", () => {
      // 这里用真的转交而不是桩：缺 id 的机密条目由转交自己拒绝（codex-questions.ts 的 asksForSecret，逐形状的断言在 codex-questions.secret.test.ts），请求到不了上面那条诊断。
      // 这条用例看的是“两边写出去的一切里都没有模型的字，Codex 恰好得到一个应答”，所以不论哪一层拒绝，它都成立。
      const written: string[] = [];
      let relayErrors = 0;
      const relay = new CodexQuestions({
        rpc: () => ({
          respond: (_id, result) => {
            written.push(JSON.stringify(result));
            return true;
          },
          respondError: (_id, _code, message) => {
            relayErrors += 1;
            written.push(message);
            return true;
          },
        }),
        emit: (draft) => {
          written.push(JSON.stringify(draft));
        },
        diagnostic: (_level, _code, message) => {
          written.push(message);
        },
        activeRunId: () => "run_1",
        cancelRequested: () => false,
      });
      const { answer, replies, diagnostics } = harness("full", {}, relay);
      answer(12, "item/tool/requestUserInput", {
        questions: [{ header: SECRET.header, question: SECRET.question, isSecret: true, options: SECRET.options }],
      });

      written.push(JSON.stringify(replies), JSON.stringify(diagnostics));
      expect(written.join("\n")).not.toContain("ZEBRA");
      expect(written.join("\n")).not.toContain("production database password");
      expect(replies.length + relayErrors).toBe(1);
    });

    it("quotes only the ordinary questions, redacted, when secret and ordinary ones arrive together", () => {
      const { answer, diagnostics } = harness("full");
      answer(13, "item/tool/requestUserInput", {
        questions: [
          { id: "scope", question: "Which package should I update?", isSecret: false },
          SECRET,
          // 密钥形状会被改写：opencode-items.test.ts 里 redact 的用例有同样的形状，"key sk-abcdefghijkl end" → "key sk-*** end"。
          { id: "key", question: "Should I use key sk-abcdefghijkl for the deploy?" },
          { question: "Paste the deploy token", isSecret: true },
        ],
      });

      expect(diagnostics).toEqual([
        {
          level: "warn",
          code: "codex.question_unanswered",
          message: `${LEAD}Which package should I update? / Should I use key sk-*** for the deploy? / 2 questions asked for a secret value (text not recorded)`,
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("ZEBRA");
      expect(JSON.stringify(diagnostics)).not.toContain("deploy token");
    });

    it("redacts what it quotes before it shortens it, so a key cut in half is not left readable", () => {
      const { answer, diagnostics } = harness("full");
      // 脱敏之前共 310 字：先截断会停在 "sk-abcde"，只剩 5 个字符，认不出是密钥；先脱敏则变成 297 字，原样放得下。
      answer(14, "item/tool/requestUserInput", { questions: [{ id: "q", question: `${"a".repeat(290)} sk-abcdefghijklmnop` }] });

      expect(diagnostics[0]?.message).toBe(`${LEAD}${"a".repeat(290)} sk-***`);
    });

    it("still quotes ordinary questions as one line, with or without an id, and says so when there is no text", () => {
      const { answer, diagnostics } = harness("full");
      answer(15, "item/tool/requestUserInput", { questions: [{ id: "a", question: "Which\n  package?" }, { question: "Really?" }] });
      answer(16, "item/tool/requestUserInput", { questions: [{ id: "b" }, { id: "c", question: "" }] });

      expect(diagnostics.map((entry) => entry.message)).toEqual([`${LEAD}Which package? / Really?`, `${LEAD}(no text)`]);
    });

    it("keeps what it quotes to 300 characters", () => {
      const { answer, diagnostics } = harness("full");
      answer(17, "item/tool/requestUserInput", { questions: [{ id: "long", question: "w".repeat(500) }] });

      expect(diagnostics[0]?.message).toBe(`${LEAD}${"w".repeat(299)}…`);
    });
  });

  // 授权与提问是两回事：授权请求当场应答，从不交给提问的转交，更不会因此等人。
  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"])(
    "never offers %s to the question relay, in any access level: authorization is answered on the spot",
    (method) => {
      for (const access of ["full", "read_only"] as const) {
        const relay = vi.fn(() => true);
        const { answer, replies } = harness(access, {}, { relay });
        answer(10, method, { command: "npm test", permissions: {} });
        expect(relay).not.toHaveBeenCalled();
        // 同步地、已经有了应答：没有任何“等人”的余地。
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ id: 10, kind: "result" });
      }
    },
  );

  it("cancels MCP elicitations", () => {
    const { answer, replies, diagnostics } = harness("full");
    answer(7, "mcpServer/elicitation/request", { serverName: "docs", message: "Pick a color" });
    expect(replies).toEqual([{ id: 7, kind: "result", payload: { action: "cancel", content: null, _meta: null } }]);
    expect(diagnostics[0]).toMatchObject({ code: "codex.elicitation_cancelled", message: expect.stringContaining('MCP server "docs"') });
  });

  it("rejects requests it does not know", () => {
    const { answer, replies, diagnostics } = harness("full");
    answer("abc", "something/new", {});
    expect(replies).toEqual([{ id: "abc", kind: "error", payload: { code: -32601, message: 'Ensemble does not handle "something/new".' } }]);
    expect(diagnostics[0]).toMatchObject({ level: "info", code: "codex.unsupported_request" });
  });
});
