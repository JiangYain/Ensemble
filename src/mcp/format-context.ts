import { clip, collapseWhitespace } from "@shared/format";
import type { ContextRefReceipt, HandoffErrorFact, HandoffFilesFact, HandoffNoResult, HandoffResultFact } from "@shared/handoff";

/**
 * `delegate` 回执里“这次从别的会话交接了什么”：一行总述，加每个被引用的会话一行。
 * 与 format.ts 一样：写给主模型看的英文、一行一件事、只陈述事实（取到了什么、取自第几次运行、被截断没有），不加评价与建议；纯函数。
 * 单独成文件：format.ts 是各个工具共用的大文件，别的改动也在动它。
 */

const NO_RESULT_TEXT: Record<HandoffNoResult, string> = {
  no_runs: "the session has no runs",
  no_text: "its runs wrote no assistant text",
  no_final: "all its messages were progress notes, none marked final",
};

function resultPhrase(fact: HandoffResultFact, runCount: number): string {
  if (!fact.found) return `result: none (${NO_RESULT_TEXT[fact.reason]})`;
  const what = fact.label === "final" ? "final answer" : "last message, not marked final";
  const size = fact.sentChars < fact.chars ? `first ${fact.sentChars} of ${fact.chars} chars (truncated)` : `${fact.chars} chars`;
  const from = `run ${fact.runIndex} of ${runCount}${fact.latest ? `; run ${fact.latest.runIndex} (${fact.latest.status}) had none` : ""}`;
  return `result: ${what}, ${size}, ${from}`;
}

function filesPhrase(fact: HandoffFilesFact): string {
  if (fact.total === 0) return "files: none reported";
  return fact.sent < fact.total ? `files: ${fact.sent} of ${fact.total} paths listed` : `files: ${fact.total} ${fact.total === 1 ? "path" : "paths"}`;
}

function errorPhrase(fact: HandoffErrorFact): string {
  if (!fact.found) return "error: none recorded";
  const where = fact.runIndex !== undefined ? ` in run ${fact.runIndex}` : " (session-level)";
  return `error: ${fact.code}${where}${fact.truncated ? ", message truncated" : ""}`;
}

/** 没有引用时返回空数组（调用方可以直接展开）。 */
export function renderContextRefs(refs: readonly ContextRefReceipt[]): string[] {
  if (refs.length === 0) return [];
  const many = refs.length > 1;
  return [
    `    context from ${many ? `${refs.length} sessions` : "a session"}, copied verbatim from ${many ? "their" : "its"} own record into the new session's prompt:`,
    ...refs.map((ref) => {
      const parts = [
        ref.result ? resultPhrase(ref.result, ref.runCount) : undefined,
        ref.files ? filesPhrase(ref.files) : undefined,
        ref.error ? errorPhrase(ref.error) : undefined,
      ].filter((part): part is string => part !== undefined);
      return `      ${ref.sessionId} “${clip(collapseWhitespace(ref.title), 60)}” (${ref.harness}; ${ref.phase} when read): ${parts.join("; ")}`;
    }),
  ];
}
