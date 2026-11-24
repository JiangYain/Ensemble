import { replay, toSummary, type SessionState } from "@shared/projection";
import type { SessionDetail } from "@shared/protocol";
import { EventLog, USER } from "@shared/testing";
import type { Preview } from "@shared/types";
import { readOne, type OneRequest, type ReadOutput } from "./read";

/**
 * 仅供测试使用：read.test.ts 与它按主题分出去的几个文件（read.errors-commands / read.after-seq / read.batch）共用的造数据辅助——
 * 造一份事件日志、把它投影成会话、再按某个视角读出来。最常用的两个局面也在这里：`twoRuns`（两轮运行，含失败、改动的文件和一个没有结束事件的命令）
 * 与 `started`（一轮已开始、还没有任何输出）。只被其中一个文件用到的辅助（`lastSeq`、`finishedSession`、`outcome`）留在那个文件里。
 */

export const cmd = (text: string): Preview => ({ text, truncated: false, format: "text" });
export const out = (text: string): Preview => ({ text, truncated: false, format: "text" });

export interface Built {
  log: EventLog;
  state: SessionState;
  detail: SessionDetail;
}

/** 把日志当前的全部事件投影成会话。再往日志里追加事件后要重新取一次，才看得到“后来”的样子。 */
export function snapshot(log: EventLog): Built {
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return { log, state, detail: { summary: toSummary(state), events: log.events } };
}

export type ReadOptions = Partial<Omit<OneRequest, "kind" | "sessionId">>;

export function read(source: EventLog | Built, options: ReadOptions = {}, now?: number): ReadOutput {
  const built = source instanceof EventLog ? snapshot(source) : source;
  const at = now ?? Date.parse(built.log.now()) + 5_000;
  return readOne(built.detail, built.state, { kind: "one", sessionId: built.detail.summary.id, view: "result", maxChars: 12_000, includeReasoning: false, ...options }, at);
}

/**
 * 两轮运行：第一轮跑通测试并改了 parser；第二轮（追加消息）里构建失败、改了 lexer 与 parser、留下一个没有结束事件的 lint，
 * 还有一条警告与一条仅供参考的提示。
 */
export function twoRuns(): EventLog {
  const log = new EventLog();
  log.created({ title: "Audit the parser" });
  log.message("m1", "task", "Audit the parser");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0, output: out("Tests: 18 passed") });
  log.tool("r1", "c2", "completed", { name: "edit", category: "edit", title: "src/parser.ts" });
  log.push({ kind: "file.changed", data: { callId: "c2", files: [{ path: "src/parser.ts", change: "modified", addedLines: 10, removedLines: 2 }] } }, { runId: "r1" });
  log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "First run: parser audited.", phase: "final" } }, { runId: "r1" });
  log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
  log.push({ kind: "usage.updated", data: { usage: { totalTokens: 1000 } } }, { runId: "r1" });
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "r1" });

  log.message("m2", "follow_up", "Now audit the lexer too", USER);
  log.run("r2", 2, "m2", "follow_up");
  log.startRun("r2");
  log.tool("r2", "c3", "failed", {
    title: "npm run build",
    input: cmd("npm run build"),
    exitCode: 2,
    error: "build exited with code 2",
    output: out("src/lexer.ts(3,1): error TS2304: Cannot find name 'x'.\nsrc/lexer.ts(9,2): error TS2322: Type mismatch."),
  });
  log.tool("r2", "c4", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
  log.tool("r2", "c5", "completed", { name: "edit", category: "edit", title: "src/lexer.ts" });
  log.push(
    {
      kind: "file.changed",
      data: {
        callId: "c5",
        files: [
          { path: "src/lexer.ts", change: "created", addedLines: 30 },
          { path: "src/parser.ts", change: "modified", addedLines: 3, removedLines: 1 },
        ],
      },
    },
    { runId: "r2" },
  );
  log.tool("r2", "c6", "running", { title: "npm run lint", input: cmd("npm run lint") });
  log.push({ kind: "diagnostic", data: { level: "warn", code: "rate_limited", message: "Rate limited; retrying in 2s" } }, { runId: "r2" });
  log.push({ kind: "diagnostic", data: { level: "info", code: "note", message: "only informational" } }, { runId: "r2" });
  log.push({ kind: "assistant.delta", data: { itemId: "a2", text: "Second run: lexer audited.", phase: "final" } }, { runId: "r2" });
  log.push({ kind: "assistant.completed", data: { itemId: "a2", phase: "final" } }, { runId: "r2" });
  log.push({ kind: "usage.updated", data: { usage: { totalTokens: 500 } } }, { runId: "r2" });
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "r2" });
  return log;
}

/** 一轮已经开始、还没有任何输出的会话。 */
export function started(): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Work through the checklist");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  return log;
}
