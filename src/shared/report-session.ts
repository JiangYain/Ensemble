/**
 * 一个会话在报告里的片段：概览、委派原文与上下文、过程（按运行分组的关键步骤）、改动文件、最终结果、用量。
 *
 * 只消费 report-facts 的 prepareReportSession 整理好的事实，不读事件、不改事实：字符预算放不下时，ReportBuilder 会把同一个会话
 * 按五档逐级收紧、反复调用 formatSession，每一档都用同一份事实，重复的只有“怎么写”（转义、截断、拼接），没有“回放日志、分类、汇总”。
 * 措辞来自 report-labels，Markdown 原语与截断提示来自 report-markdown；会话之间的先后、预算怎么分在 report.ts。
 * 过程里逐条的步骤（工具、提问、补充消息、诊断、助手文字）与不属于任何运行的散落条目怎么写，在 report-steps.ts（它不导入本文件）；
 * 本文件写其余各节（概览、委派与上下文、各次运行的抬头与回答、改动文件、最终结果、用量），并把整个片段拼起来。
 */

import { formatDuration, msBetween } from "./format";
import { parentIdsOf } from "./lineage";
import { byText } from "./report-facts";
import type { PreparedSession, RunFacts, SessionHistory, UsageFacts } from "./report-facts";
import { CHANGE_ORDER, HARNESS_NAMES, PHASE_KEYS, RUN_STATUS_KEYS } from "./report-labels";
import type { ReportLabelKey } from "./report-labels";
import { code, costCell, DASH, durationCell, esc, heading, inlineText, num, oneLine, pushAll, quote, tableLines, tokenCell, utc } from "./report-markdown";
import type { Ctx } from "./report-markdown";
import { REPORT_LIMITS } from "./report-options";
import type { Trim } from "./report-options";
import { actorText, changeText, looseLines, skippedLine, stepLines } from "./report-steps";
import type { ContextItem, Run, RunStatus, SessionPhase, SessionSummary } from "./types";

// ───────────────────────── 枚举值与会话字段的措辞 ─────────────────────────

export function phaseText(c: Ctx, phase: SessionPhase): string {
  const key = PHASE_KEYS[phase];
  return key ? c.t(key) : esc(phase);
}

function runStatusText(c: Ctx, status: RunStatus): string {
  const key = RUN_STATUS_KEYS[status];
  return key ? c.t(key) : esc(status);
}

export function harnessText(c: Ctx, summary: SessionSummary): string {
  const name = HARNESS_NAMES[summary.harness] ?? summary.harness;
  return esc(summary.runtime === "fixture" ? `${name} (${c.t("simulated")})` : name);
}

function modelText(c: Ctx, summary: SessionSummary): string {
  const model = summary.model;
  const main = model?.resolved ?? model?.requested;
  if (!model || !main) return c.t("notSpecified");
  let text = code(main);
  if (model.requested && model.resolved && model.requested !== model.resolved) {
    text += ` (${c.t("requested")}: ${code(model.requested)})`;
  }
  if (model.provider) text += ` — ${esc(model.provider)}`;
  return text;
}

function accessText(c: Ctx, summary: SessionSummary): string {
  const access = c.t(summary.access === "read_only" ? "accReadOnly" : "accFull");
  const enforcement = summary.accessEnforcement;
  if (!enforcement) return access;
  const level = c.t(enforcement.level === "enforced" ? "enfEnforced" : enforcement.level === "advisory" ? "enfAdvisory" : "enfNone");
  return `${access} (${level}: ${esc(enforcement.mechanism)})`;
}

function originText(c: Ctx, summary: SessionSummary): string {
  const origin = summary.origin;
  return `${esc(origin.hostLabel)} (${c.t(origin.kind === "agent" ? "actAgent" : "actUser")})`;
}

function workspaceText(c: Ctx, summary: SessionSummary): string {
  const origin = summary.origin;
  const source = origin.workspaceSource;
  const key = source === "host-record" ? "wsHostRecord" : source === "mcp-roots" ? "wsMcpRoots" : source === "delegate-cwd" ? "wsDelegateCwd" : undefined;
  return `${code(origin.workspace ?? "")}${key ? ` (${c.t(key)})` : ""}`;
}

function conversationText(c: Ctx, summary: SessionSummary): string | undefined {
  const origin = summary.origin;
  const parts: string[] = [];
  if (origin.hostTitle) parts.push(`“${esc(origin.hostTitle)}”`);
  if (origin.sessionRef) {
    parts.push(`${code(origin.sessionRef.id)}${origin.sessionRef.source === "declared" ? ` (${c.t("declaredByAgent")})` : ""}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function titleText(c: Ctx, title: string): string {
  return oneLine(title) === "" ? c.t("untitled") : inlineText(c, title, 120);
}

// ───────────────────────── 一个会话的片段 ─────────────────────────

function contextLines(items: readonly ContextItem[], c: Ctx, trim: Trim): string[] {
  const out: string[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "file": {
        const note = item.note ? ` — ${inlineText(c, item.note, trim.inline)}` : "";
        out.push(`- ${c.t("ctxFile")}: ${code(item.path)}${note}`);
        break;
      }
      case "url": {
        const title = item.title ? ` — ${inlineText(c, item.title, trim.inline)}` : "";
        out.push(`- ${c.t("ctxUrl")}: ${code(item.url)}${title}`);
        break;
      }
      case "text": {
        const title = item.title ? `: ${inlineText(c, item.title, trim.inline)}` : "";
        out.push(`- ${c.t("ctxText")}${title} — ${c.t("chars", { n: num(item.text.length) })}`, "");
        pushAll(out, quote(c, item.text, trim.block, { indent: "  " }));
        out.push("");
        break;
      }
      case "snippet": {
        const where = item.path ? code(item.path) : c.t("ctxNoPath");
        const range =
          item.startLine !== undefined && item.endLine !== undefined
            ? ` · ${c.t("ctxLines", { a: item.startLine, b: item.endLine })}`
            : item.startLine !== undefined
              ? ` · ${c.t("ctxFromLine", { a: item.startLine })}`
              : "";
        const language = item.language ? ` · ${esc(item.language)}` : "";
        out.push(`- ${c.t("ctxSnippet")}: ${where}${range}${language} — ${c.t("chars", { n: num(item.text.length) })}`, "");
        pushAll(out, quote(c, item.text, trim.block, { indent: "  " }));
        out.push("");
        break;
      }
      case "session": {
        // 引用了另一个会话的产出：这里只写“引用了谁、当时取走了什么”这一行事实（取样时冻结在会话记录里，不是现在再去读的）。
        // 交出去的正文不在报告里：“委派”一节引用的只是发起方写的原文（task.text），不含展开后的完整提示。
        // 正文留在会话自己冻结的提示里（网页聚焦页“传入的上下文”可以展开看到）；报告同时包含上游会话时，它的最终回答在上游自己的那一节。
        const sample = item.sample;
        const head = `- ${c.t("ctxSession")}: ${code(item.sessionId)}${sample ? ` “${inlineText(c, sample.title, trim.inline)}”` : ""}`;
        if (!sample) {
          out.push(`${head} — ${c.t("ctxSessionNoSample")}`);
          break;
        }
        const facts: string[] = [];
        // 被截断的部分必须说出来：只写“交出去了多少”会让读者以为那就是全部。
        if (sample.result) {
          const result = sample.result;
          facts.push(
            !result.found
              ? c.t("ctxSessionNoResult")
              : result.sentChars < result.chars
                ? c.t("ctxSessionResultCut", { n: num(result.sentChars), total: num(result.chars) })
                : c.t("ctxSessionResult", { n: num(result.sentChars) }),
          );
        }
        if (sample.files) {
          const files = sample.files;
          facts.push(files.sent < files.total ? c.t("ctxSessionFilesCut", { n: num(files.sent), total: num(files.total) }) : c.t("ctxSessionFiles", { n: num(files.sent) }));
        }
        if (sample.error) {
          const error = sample.error;
          facts.push(!error.found ? c.t("ctxSessionNoError") : c.t(error.truncated ? "ctxSessionErrorCut" : "ctxSessionError", { code: code(error.code) }));
        }
        facts.push(c.t("ctxSessionSampled", { at: utc(sample.at), phase: phaseText(c, sample.phase) }));
        out.push(`${head} — ${facts.join(" · ")}`);
        break;
      }
      default:
        // 编译期穷尽检查：新增了上下文类型而忘了这里，类型检查会在下一行报错。
        // 运行时仍然宽容：更新版本写下的记录里可能有这里不认识的类型，不展开，只如实说有这么一条。
        item satisfies never;
        out.push(`- ${c.t("ctxOther")}`);
        break;
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function overviewLines(s: SessionSummary, c: Ctx, runTimeMs: number | undefined): string[] {
  const rows: string[][] = [];
  const add = (key: ReportLabelKey, value: string): void => {
    rows.push([c.t(key), value]);
  };
  add("fSession", code(s.id));
  add("fStatus", phaseText(c, s.phase));
  add("fHarness", harnessText(c, s));
  add("fModel", modelText(c, s));
  if (s.effort) add("fEffort", code(s.effort));
  add("fAccess", accessText(c, s));
  add("fCwd", code(s.cwd));
  add("fOrigin", originText(c, s));
  if (s.origin.workspace) add("fOriginWorkspace", workspaceText(c, s));
  const conversation = conversationText(c, s);
  if (conversation) add("fOriginConversation", conversation);
  if (s.nativeRef) add("fNative", `${code(s.nativeRef.id)} (${esc(s.nativeRef.kind)})`);
  if (s.parentSessionId) add("fParent", code(s.parentSessionId));
  // 汇聚节点：fParent 是第一个上级，其余的在这一行写出（id 与标题，不展开）；任务树里它只在一个上级之下出现一次。
  const others = parentIdsOf(s).slice(1);
  if (others.length > 0) {
    add(
      "fAlsoFollows",
      others
        .map((id) => {
          const title = c.titles.get(id);
          return title === undefined ? code(id) : `${titleText(c, title)} (${code(id)})`;
        })
        .join(c.sep),
    );
  }
  if (!c.tree && s.childIds.length > 0) add("fChildren", `${s.childIds.length} (${c.t("childrenNotIncluded")})`);
  add("fCreated", utc(s.createdAt));
  if (s.endedAt) add("fEnded", utc(s.endedAt));
  add("fActivity", utc(s.updatedAt));
  add("fRunTime", durationCell(runTimeMs));
  add("fRuns", String(s.runCount));
  return tableLines([c.t("colField"), c.t("colValue")], rows);
}

function trimNote(c: Ctx, trim: Trim, limit: number): string {
  const outputs = c.detail === "full" && trim.output <= 0 ? c.t("trimNoOutputs") : "";
  return c.t("trimNote", {
    limit: num(limit),
    runs: num(trim.runs),
    steps: num(trim.steps),
    text: num(trim.text),
    block: num(trim.block),
    files: num(trim.files),
    outputs,
  });
}

/** “运行 n — 状态 · 时长”：运行小节的标题，也是被收紧时更早的运行只留的那一行。 */
function runTitle(c: Ctx, run: Run): string {
  const duration = run.startedAt && run.endedAt ? formatDuration(msBetween(run.startedAt, run.endedAt)) : undefined;
  return `${c.t("run", { n: run.index })} — ${runStatusText(c, run.status)}${duration ? ` · ${duration}` : ""}`;
}

function runLines(history: SessionHistory, facts: RunFacts, isResult: boolean, c: Ctx, trim: Trim, section: number): string[] {
  const { run, answer, steps, skipped, plan } = facts;
  const out: string[] = [];
  out.push(heading(section + 1, runTitle(c, run)), "");

  const header = [`${c.t("rTrigger")}: ${c.t(run.trigger === "task" ? "rTriggerTask" : "rTriggerFollowUp")}`, `${c.t("rQueued")}: ${utc(run.queuedAt)}`];
  if (run.startedAt) header.push(`${c.t("rStarted")}: ${utc(run.startedAt)}`);
  if (run.endedAt) header.push(`${c.t("rEnded")}: ${utc(run.endedAt)}`);
  if (run.stopReason) header.push(`${c.t("rStop")}: ${code(run.stopReason)}`);
  out.push(header.join(" · "), "");

  if (run.status === "failed" && run.error) {
    out.push(`${c.t("rError")}: ${code(run.error.code)} — ${inlineText(c, run.error.message, trim.inline)}`, "");
    if (c.detail === "full" && run.error.detail) {
      out.push(`${c.t("rDetail")}:`, "");
      pushAll(out, quote(c, run.error.detail, trim.block));
      out.push("");
    }
  }
  if (run.status === "cancelled") {
    const cancel = history.cancels.get(run.id);
    if (cancel) {
      const note = cancel.note ? `: ${inlineText(c, cancel.note, trim.inline)}` : "";
      out.push(`${c.t("rCancelBy", { who: actorText(c, cancel.by) })}${note}`, "");
    } else {
      out.push(c.t("rCancelUnknown"), "");
    }
  }

  if (steps.length > 0) {
    // 步骤太多时取开头与结尾各一半：失败的命令通常出现在最后，只留开头会漏掉它。
    const cap = trim.steps;
    const headCount = steps.length > cap ? Math.ceil(cap / 2) : steps.length;
    const tailCount = steps.length > cap ? Math.floor(cap / 2) : 0;
    const hidden = steps.length - headCount - tailCount;
    const lines: string[] = [];
    for (const step of steps.slice(0, headCount)) pushAll(lines, stepLines(step, c, trim));
    if (hidden > 0) lines.push(`- ${c.t("stepMore", { n: num(hidden) })}`);
    if (tailCount > 0) {
      for (const step of steps.slice(steps.length - tailCount)) pushAll(lines, stepLines(step, c, trim));
    }
    pushAll(out, lines);
    out.push("");
  }
  const skippedText = skippedLine(c, skipped);
  if (skippedText) out.push(skippedText, "");

  if (plan && plan.entries.length > 0) {
    out.push(c.t("planFinal"), "");
    const shown = plan.entries.slice(0, REPORT_LIMITS.planEntries);
    for (const entry of shown) {
      const mark = entry.status === "completed" ? "x" : " ";
      const progress = entry.status === "in_progress" ? ` ${c.t("planInProgress")}` : "";
      out.push(`- [${mark}] ${inlineText(c, entry.text, trim.inline)}${progress}`);
    }
    if (plan.entries.length > shown.length) out.push(`- ${c.t("planMore", { n: num(plan.entries.length - shown.length) })}`);
    out.push("");
  }

  // 最后一次已开始的运行的回答放在“最终结果”里；更早的运行的回答放在各自的运行下面。
  if (!isResult && answer) {
    out.push(c.t(run.status === "completed" && answer.final ? "runAnswer" : "runLastMessage"), "");
    pushAll(out, quote(c, answer.item.text, trim.text));
    out.push("");
  }
  return out;
}

function filesLines(history: SessionHistory, c: Ctx, trim: Trim, section: number): string[] {
  const out = [heading(section, c.t("files")), ""];
  if (history.files.size === 0) {
    out.push(c.t("noFiles"), "");
    return out;
  }
  out.push(c.t("filesIntro"), "");
  const paths = history.filePaths;
  for (const path of paths.slice(0, trim.files)) {
    const kinds = history.files.get(path) ?? new Map<string, number>();
    const parts: string[] = [];
    for (const kind of CHANGE_ORDER) {
      const count = kinds.get(kind);
      if (count) parts.push(count > 1 ? `${changeText(c, kind)} ×${count}` : changeText(c, kind));
    }
    // 将来新增的变更类型：按原文列在后面。
    for (const [kind, count] of [...kinds.entries()].sort((a, b) => byText(a[0], b[0]))) {
      if (!(CHANGE_ORDER as readonly string[]).includes(kind)) parts.push(count > 1 ? `${esc(kind)} ×${count}` : esc(kind));
    }
    out.push(`- ${code(path)} — ${parts.join(c.sep)}`);
  }
  if (paths.length > trim.files) out.push(`- ${c.t("filesMore", { n: num(paths.length - trim.files) })}`);
  out.push("");
  return out;
}

function resultLines(runs: readonly RunFacts[], resultRun: RunFacts | undefined, c: Ctx, trim: Trim, section: number): string[] {
  const out = [heading(section, c.t("result")), ""];
  if (!resultRun) {
    out.push(c.t("resultNoRun"), "");
  } else {
    const run = resultRun.run;
    const n = run.index;
    const answer = resultRun.answer;
    const pushLast = (): void => {
      if (!answer) {
        out.push(c.t("noAnswer"), "");
        return;
      }
      out.push(c.t("resultLast", { n }), "");
      pushAll(out, quote(c, answer.item.text, trim.text));
      out.push("");
    };
    switch (run.status) {
      case "completed": {
        if (answer?.final) {
          out.push(c.t("resultAnswer", { n }), "");
          pushAll(out, quote(c, answer.item.text, trim.text));
          out.push("");
        } else {
          pushLast();
        }
        break;
      }
      case "failed": {
        const error = run.error;
        const text = error ? `${code(error.code)} ${inlineText(c, error.message, trim.inline)}` : DASH;
        out.push(c.t("resultFailed", { n, error: text }), "");
        pushLast();
        break;
      }
      case "cancelled": {
        out.push(c.t("resultCancelled", { n }), "");
        pushLast();
        break;
      }
      default: {
        // starting / running：还没有最终回答，已有的最新一条如实标明“不是最终回答”。
        out.push(c.t("resultActive", { n, status: runStatusText(c, run.status) }), "");
        if (answer) {
          out.push(c.t("resultLast", { n }), "");
          pushAll(out, quote(c, answer.item.text, trim.text));
          out.push("");
        }
        break;
      }
    }
  }
  for (const facts of runs) {
    if (facts.run.status === "queued") out.push(c.t("resultQueued", { n: facts.run.index }), "");
  }
  return out;
}

function usageLines(usage: UsageFacts, c: Ctx, section: number): string[] {
  const out = [heading(section, c.t("usage")), ""];
  const entries = usage.entries;
  if (entries.length === 0) {
    out.push(c.t("noUsageRuns"), "");
    return out;
  }
  const header = [c.t("uRun"), c.t("uInput"), c.t("uOutput"), c.t("uCached"), c.t("uReasoning"), c.t("uCost"), c.t("uDuration")];
  const rows = entries.map(({ run, row }) => [
    c.t("run", { n: run.index }),
    tokenCell(c, row.input, false),
    tokenCell(c, row.output, false),
    tokenCell(c, row.cached, false),
    tokenCell(c, row.reasoning, false),
    costCell(c, row.cost, false),
    durationCell(row.ms),
  ]);
  let anyPartial = false;
  if (entries.length > 1) {
    const { total, partial } = usage;
    anyPartial = [...partial].some((key) => key !== "ms");
    rows.push([
      c.t("uTotal"),
      tokenCell(c, total.input, partial.has("input")),
      tokenCell(c, total.output, partial.has("output")),
      tokenCell(c, total.cached, partial.has("cached")),
      tokenCell(c, total.reasoning, partial.has("reasoning")),
      costCell(c, total.cost, partial.has("cost")),
      durationCell(total.ms),
    ]);
  }
  pushAll(out, tableLines(header, rows, [1, 2, 3, 4, 5, 6]));
  out.push("");
  if (anyPartial) out.push(c.t("uPartial"), "");
  out.push(c.t("uNote"), "");
  return out;
}

/**
 * 一个会话在报告里的完整片段（不含末尾空行）。level 越大引用的上限越紧（见 report-options 的 trimFor），0 = 不缩减。
 * prepared 由 prepareReportSession 一次整理好、各档共用；这里只读它，所以同一份 prepared 可以放心地反复渲染。
 */
export function formatSession(prepared: PreparedSession, c: Ctx, trim: Trim, level: number, limit: number): string {
  const { summary, history } = prepared;
  const out: string[] = [];
  // scope=session：概览是 H2、各分节也是 H2；scope=tree：会话标题是 H3、各分节 H4。
  const top = c.tree ? 3 : 2;
  const section = c.tree ? 4 : 2;
  out.push(heading(top, c.tree ? `${c.number} ${titleText(c, summary.title)}` : c.t("overview")), "");

  if (!history) {
    pushAll(out, overviewLines(summary, c, undefined));
    out.push("", c.t("noHistory"));
    return out.join("\n");
  }

  const { state, runs } = history;
  pushAll(out, overviewLines(summary, c, history.usage.total.ms));
  out.push("");

  // 委派：原文原样引用 + 随任务传入的上下文。
  const task = state.meta.task;
  out.push(heading(section, c.t("delegation")), "", c.t("delegationNote"), "");
  pushAll(out, quote(c, task.text, trim.text));
  out.push("");
  if (task.context.length > 0) {
    out.push(heading(section + 1, c.t("context")), "");
    pushAll(out, contextLines(task.context, c, trim));
    out.push("");
  } else {
    out.push(c.t("noContext"), "");
  }

  // 过程：按运行分组。
  out.push(heading(section, c.t("process")), "");
  if (level > 0) out.push(trimNote(c, trim, limit), "");
  if (runs.length === 0) out.push(c.t("noRuns"), "");
  // 被收紧时，更早的运行只留一行（状态与时长）；最近几次照常完整展开。
  const detailedFrom = Number.isFinite(trim.runs) ? Math.max(0, runs.length - trim.runs) : 0;
  if (detailedFrom > 0) {
    for (const facts of runs.slice(0, detailedFrom)) out.push(`- ${runTitle(c, facts.run)}`);
    out.push("");
  }
  for (const facts of runs.slice(detailedFrom)) {
    pushAll(out, runLines(history, facts, facts === history.resultRun, c, trim, section));
  }
  const loose = looseLines(history.loose, c, trim);
  if (loose.length > 0) {
    out.push(heading(section + 1, c.t("sessionEvents")), "");
    pushAll(out, loose);
    out.push("");
  }

  pushAll(out, filesLines(history, c, trim, section));
  pushAll(out, resultLines(runs, history.resultRun, c, trim, section));
  pushAll(out, usageLines(history.usage, c, section));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
