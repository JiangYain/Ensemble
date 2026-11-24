import type { AssistantItem, RunId, TimelineItem } from "./types";

/**
 * 一组时间线条目里“回答”的那一条：最后一条非空的 `final`；一条 `final` 都没有时，退回最后一条非空的助手文字
 * （可能是标成过程说明的 `commentary`，也可能没有标记）。给了 `runId` 就只在那一次运行的条目里挑。
 *
 * 返回时间线上的原条目，文字不做任何改动——报告要原文引用，MCP 的文字视图自己去首尾空白、自己决定怎么称呼它
 * （要不要说“这不是最终回答”看返回条目的 `phase`）。只看条目的类型、运行、阶段与文字，不依赖条目 id 的写法。
 */
export function preferredAssistant(items: readonly TimelineItem[], runId?: RunId): AssistantItem | undefined {
  let lastFinal: AssistantItem | undefined;
  let lastAny: AssistantItem | undefined;
  for (const item of items) {
    if (item.type !== "assistant" || item.text.trim() === "") continue;
    if (runId !== undefined && item.runId !== runId) continue;
    lastAny = item;
    if (item.phase === "final") lastFinal = item;
  }
  return lastFinal ?? lastAny;
}
