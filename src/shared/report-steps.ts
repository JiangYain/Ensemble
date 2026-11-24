/**
 * 一个会话片段里“过程”的行：运行里逐条列出的步骤（工具调用、执行端的提问、补充消息、诊断、助手文字）、没有逐条列出的类别计数，
 * 以及不属于任何运行的散落条目与会话级的状态变化。
 *
 * 和 report-session 一样只消费 report-facts 整理好的事实，不读事件、不改事实；引用的转义与截断来自 report-markdown，措辞来自 report-labels。
 * 依赖方向是单向的：本文件不导入 report-session.ts。两边都要用的措辞（changeText、actorText）放在这里、由 report-session 导入，不在两处各写一份；
 * 这些行怎么嵌进整个会话片段（概览、委派、各次运行、文件、结果、用量）在 report-session.ts。
 */

import { formatDuration } from "./format";
import { byText } from "./report-facts";
import type { LooseEntry, SessionNote, Skipped, Step } from "./report-facts";
import { CHANGE_KEYS, QUESTION_EXPIRY_KEYS, QUEUE_REASON_KEYS, TOOL_STATUS_KEYS } from "./report-labels";
import type { ReportLabelKey } from "./report-labels";
import { clock, code, commandInline, esc, inlineCode, inlineText, languageOf, num, oneLine, pushAll, quote } from "./report-markdown";
import type { Ctx } from "./report-markdown";
import type { Trim } from "./report-options";
import type { Actor, DeliveryState, QuestionItem, ToolItem } from "./types";

// ───────────────────────── 两边共用的措辞 ─────────────────────────

export function changeText(c: Ctx, change: string): string {
  const key = (CHANGE_KEYS as Readonly<Record<string, ReportLabelKey | undefined>>)[change];
  return key ? c.t(key) : esc(change);
}

function actorKindText(c: Ctx, kind: Actor["kind"]): string {
  return c.t(kind === "user" ? "actUser" : kind === "agent" ? "actAgent" : "actSystem");
}

export function actorText(c: Ctx, actor: Actor | undefined): string {
  return actor ? `${esc(actor.label)} (${actorKindText(c, actor.kind)})` : c.t("unknownParty");
}

// ───────────────────────── 过程里的步骤 ─────────────────────────

function deliveryText(c: Ctx, delivery: DeliveryState): string {
  switch (delivery.stage) {
    case "recorded":
      return c.t("dRecorded");
    case "queued": {
      const base = c.t(delivery.queuedBy === "harness" ? "dQueuedHarness" : "dQueuedEnsemble");
      if (!delivery.reason) return base;
      const key = QUEUE_REASON_KEYS[delivery.reason];
      return `${base} (${key ? c.t(key) : esc(delivery.reason)})`;
    }
    case "handed_off":
      return c.t("dHandedOff");
    case "applied":
      return c.t("dApplied");
    case "failed": {
      const error = delivery.error;
      return error ? `${c.t("dFailed")}: ${code(error.code)} ${inlineText(c, error.message, 160)}` : c.t("dFailed");
    }
    case "cancelled":
      return c.t("dCancelled");
  }
}

function toolKind(tool: ToolItem): "command" | "file" | "mcp" | "other" {
  if (tool.mcp || tool.category === "mcp") return "mcp";
  if (tool.category === "shell") return "command";
  if (tool.category === "write" || tool.category === "edit" || (tool.files?.length ?? 0) > 0) return "file";
  return "other";
}

function toolLines(tool: ToolItem, at: string, c: Ctx, trim: Trim): string[] {
  let head = "";
  switch (toolKind(tool)) {
    case "command":
      head = `${c.t("toolCommand")}: ${commandInline(c, tool.title, trim.inline)}`;
      break;
    case "mcp": {
      const label = [tool.mcp?.server, tool.mcp?.tool].filter((part): part is string => typeof part === "string" && part !== "").join(" / ");
      head = `${c.t("toolMcp")}: ${code(label !== "" ? label : tool.title)}`;
      break;
    }
    case "file": {
      const files = tool.files ?? [];
      const shown = files.slice(0, 3).map((file) => `${code(file.path)} (${changeText(c, file.change)})`).join(c.sep);
      const more = files.length > 3 ? ` ${c.t("andMore", { n: files.length - 3 })}` : "";
      const what = files.length > 0 ? `${shown}${more}` : inlineCode(c, tool.title, trim.inline);
      head = `${c.t("toolFile")}: ${what} — ${c.t("toolTool", { name: code(tool.name) })}`;
      break;
    }
    case "other": {
      const title = tool.title !== "" && tool.title !== tool.name ? ` — ${inlineCode(c, tool.title, trim.inline)}` : "";
      head = `${c.t("toolOther")}: ${code(tool.name)}${title}`;
      break;
    }
  }
  const segments = [head];
  if (tool.status !== "completed") {
    const key = TOOL_STATUS_KEYS[tool.status];
    segments.push(key ? c.t(key) : esc(tool.status));
  }
  if (tool.exitCode !== undefined) segments.push(c.t("exitCode", { n: tool.exitCode }));
  if (tool.durationMs !== undefined && tool.durationMs >= 1000) segments.push(formatDuration(tool.durationMs));
  if (tool.error) segments.push(c.t("errText", { text: inlineCode(c, tool.error, trim.inline) }));
  const lines = [`- ${clock(at)} — ${segments.join(" — ")}`];

  if (c.detail === "full") {
    // 标签行前后各留一个空行：否则它会被并进上一行的段落里（列表项里的“续行”）。
    const input = tool.input;
    // 命令行只有一行且已经在上面完整出现时不再重复；其余工具的入参（路径、查询、JSON）照列。
    if (input && input.text.trim() !== "" && trim.block > 0 && (tool.category !== "shell" || oneLine(input.text) !== oneLine(tool.title))) {
      lines.push("", `  ${c.t("toolInput")}:`, "");
      pushAll(lines, quote(c, input.text, trim.block, { indent: "  ", language: languageOf(input) }));
    }
    const output = tool.output;
    if (output && output.text.trim() !== "" && trim.output > 0) {
      lines.push("", `  ${c.t("toolOutput")}:`, "");
      pushAll(lines, quote(c, output.text, trim.output, { indent: "  ", language: languageOf(output), middle: true }));
    }
  }
  return lines;
}

/** 提问的结局一句话：谁在何时回答 / 不回答，或为什么过期；还没有结局就如实说导出时没有回答。 */
function questionStatusText(c: Ctx, item: QuestionItem): string {
  const outcome = item.outcome;
  if (item.status === "open" || !outcome) return c.t("askOpen");
  const time = clock(outcome.at);
  switch (item.status) {
    case "answered":
      return c.t("askAnswered", { who: actorText(c, outcome.by), time });
    case "declined":
      return c.t("askDeclined", { who: actorText(c, outcome.by), time });
    case "expired": {
      const key = outcome.reason ? (QUESTION_EXPIRY_KEYS as Readonly<Record<string, ReportLabelKey | undefined>>)[outcome.reason] : undefined;
      return key ? c.t("askExpired", { time, reason: c.t(key) }) : c.t("askExpiredNoReason", { time });
    }
  }
}

/** 一次提问的条目：问题原文、可选项、回答（原文）与结局；回复有没有交给执行端按记录如实写明。 */
function questionLines(item: QuestionItem, at: string, c: Ctx, trim: Trim): string[] {
  const outcome = item.outcome;
  const facts = [questionStatusText(c, item)];
  if (outcome?.delivery) facts.push(c.t(outcome.delivery === "handed_off" ? "askHandedOff" : "askNotDelivered"));
  const lines = [`- ${clock(at)} — ${c.t("askTitle")} — ${facts.join(" — ")}`, ""];

  const total = item.prompts.length;
  item.prompts.forEach((prompt, index) => {
    const head = [total > 1 ? c.t("askNumber", { n: index + 1, total }) : "", prompt.header ? inlineText(c, prompt.header, trim.inline) : ""]
      .filter((part) => part !== "")
      .join(" — ");
    if (head !== "") lines.push(`  ${head}:`, "");
    pushAll(lines, quote(c, prompt.text, trim.block, { indent: "  " }));
    lines.push("");
    const options = prompt.options ?? [];
    if (options.length > 0) {
      const shown = options.slice(0, 10).map((option) => inlineCode(c, option.label, 80));
      const more = options.length > shown.length ? ` ${c.t("andMore", { n: options.length - shown.length })}` : "";
      lines.push(`  ${c.t("askOptions")}: ${shown.join(c.sep)}${more}`, "");
    }
    const picks = outcome?.answers?.[index];
    if (picks && picks.length > 0) {
      // 选了某个可选项（短、一行）就用行内代码；自己写的长答案原文引用，不在这里截成一行。
      if (picks.every((pick) => pick.length <= 80 && !pick.includes("\n"))) {
        lines.push(`  ${c.t("askAnswer")}: ${picks.map((pick) => code(pick)).join(c.sep)}`, "");
      } else {
        lines.push(`  ${c.t("askAnswer")}:`, "");
        pushAll(lines, quote(c, picks.join("\n"), trim.block, { indent: "  " }));
        lines.push("");
      }
    }
  });
  if (outcome?.note) {
    lines.push(`  ${c.t("askNote")}:`, "");
    pushAll(lines, quote(c, outcome.note, trim.block, { indent: "  " }));
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function stepLines(step: Step, c: Ctx, trim: Trim): string[] {
  switch (step.kind) {
    case "message": {
      const message = step.message;
      const kind = c.t(message.kind === "steer" ? "kSteer" : "kFollowUp");
      const who = `${esc(message.author.label)} (${actorKindText(c, message.author.kind)})`;
      const lines = [`- ${clock(step.at)} — ${kind} ${c.t("from", { who })} — ${deliveryText(c, message.delivery)}`, ""];
      pushAll(lines, quote(c, message.text, trim.block, { indent: "  " }));
      return lines;
    }
    case "tool":
      return toolLines(step.tool, step.at, c, trim);
    case "diagnostic": {
      const item = step.item;
      return [`- ${clock(step.at)} — ${c.t("diag", { level: item.level })} ${code(item.code)}: ${inlineText(c, item.message, trim.inline)}`];
    }
    case "assistant": {
      const item = step.item;
      const tag = item.phase === "commentary" ? ` ${c.t("asstCommentary")}` : "";
      const lines = [`- ${clock(step.at)} — ${c.t("asstMessage")}${tag}`, ""];
      pushAll(lines, quote(c, item.text, trim.block, { indent: "  " }));
      return lines;
    }
    case "question":
      return questionLines(step.item, step.at, c, trim);
  }
}

/** 一次运行里没有逐条列出的东西，按类别计数——让读者知道“还有什么没看到”。 */
export function skippedLine(c: Ctx, skipped: Skipped): string | undefined {
  const parts: string[] = [];
  let toolTotal = 0;
  for (const count of skipped.tools.values()) toolTotal += count;
  if (toolTotal > 0) {
    const cats = [...skipped.tools.entries()]
      .sort((a, b) => byText(a[0], b[0]))
      .map(([category, count]) => `${category} ${count}`)
      .join(", ");
    parts.push(c.t("nlTools", { n: num(toolTotal), cats }));
  }
  if (skipped.assistant > 0) parts.push(c.t("nlAssistant", { n: num(skipped.assistant) }));
  if (skipped.diagnostics > 0) parts.push(c.t("nlDiag", { n: num(skipped.diagnostics) }));
  if (skipped.reasoning > 0) parts.push(c.t("nlReasoning", { n: num(skipped.reasoning) }));
  if (skipped.other > 0) parts.push(c.t("nlOther", { n: num(skipped.other) }));
  return parts.length === 0 ? undefined : c.t("notListed", { parts: parts.join(c.sep) });
}

function noteLines(note: SessionNote, c: Ctx, trim: Trim): string[] {
  const parts = [c.t("snStatus", { status: code(note.status) })];
  if (note.reason) parts.push(c.t("snReason", { reason: code(note.reason) }));
  if (note.error) parts.push(c.t("errText", { text: `${code(note.error.code)} ${inlineText(c, note.error.message, trim.inline)}` }));
  return [`- ${clock(note.at)} — ${parts.join(" — ")}`];
}

/** 不属于任何运行的东西（已在事实里按时间排好）：没有关联运行的消息、诊断与提问，以及会话级的状态变化（被停止 / 失败 / 失联）。 */
export function looseLines(entries: readonly LooseEntry[], c: Ctx, trim: Trim): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    pushAll(out, entry.kind === "step" ? stepLines(entry.step, c, trim) : noteLines(entry.note, c, trim));
  }
  return out;
}
