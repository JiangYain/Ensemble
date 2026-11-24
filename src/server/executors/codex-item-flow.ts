import { isoNow } from "@shared/format";
import { sliceTail } from "@shared/safe-slice";
import type { PlanEntry, RunId } from "@shared/types";
import { toolEnd, toolStart, usageOf, type TokenBase } from "./codex-items";
import { arr, asRecord, num, outputPreview, str, type Json } from "./common";
import type { ExecutorDraft } from "./types";

/**
 * Codex 一个回合里的“内容流”：条目（助手文字、推理摘要、工具）、计划与用量这几路通知到 Ensemble 统一事件的转换。
 * 与 codex-questions.ts 是同一个写法：带自己状态的协作者，由 `CodexSession` 持有，在它的 `onNotification` 里转调。
 * 它自己持有三张表（每个会话各一份，不是模块级的）：
 * - `tools`：进行中的工具调用（标题、累计输出、输出节流用的尾部刷新定时器）；
 * - `reasoning`：进行中的推理摘要（开始时间、最后一段的序号、有没有出过字）；
 * - `agentPhase`：助手文字块的阶段（commentary / final），增量与完成事件靠它补上 phase。
 * 回合结束时这三张表由会话经 `runEnded` 一起清空；会话关闭时经 `clearTimers` 清掉还没触发的定时器；
 * 授权类请求的诊断要说明“批准的是什么”，经 `titleOf` 取工具的标题。
 *
 * 会话那一侧的东西（事件盖章与发出、当前运行、当前回合的判断、工作目录、纠偏回显、诊断）都经 `CodexItemFlowDeps` 取，
 * 而且每次用到才取、不缓存：运行开始与结束时会话会换掉当前运行，这里复制一份就会读到过期的。
 * 条目的形状与行为依据见 codex.ts 顶部的说明（Codex 0.151.0 / Windows 11 实测）和 codex-items.ts。
 */

/** 助手文字块：记下它的阶段，回合结束时会话对没给阶段的块补判（见 codex.ts 的 `finishRun`）。 */
export interface AgentText {
  itemId: string;
  phase: "commentary" | "final" | undefined;
}

/** 内容流从当前运行里读写的那一部分；会话里的 `RunState` 还有别的字段（回合编号、取消、末次错误……），那些只归会话管。 */
export interface ItemRun {
  usageBase: TokenBase | undefined;
  agentTexts: AgentText[];
}

export interface CodexItemFlowDeps {
  /** 发事件；不给 runId 时归到当前运行名下，会话关闭后丢弃（都由会话的 `emit` 负责）。 */
  emit(draft: ExecutorDraft, runId?: RunId): void;
  /** 通知里的 turnId 与当前运行不符（别的回合的残余事件）时为 false。 */
  isCurrentTurn(params: Json): boolean;
  /** 当前运行；每次取最新的。 */
  run(): ItemRun | undefined;
  /** 会话的工作目录：工具里的路径据此写成相对路径。 */
  cwd(): string;
  /** 用户消息被写进线程：它是不是某条纠偏的回显，由持有纠偏记录的会话判断。 */
  userMessage(item: Json): void;
  /** 上下文被压缩：由会话记成一条诊断。 */
  contextCompacted(params: Json): void;
}

const OUTPUT_THROTTLE_MS = 250;
const OUTPUT_BUFFER_CHARS = 64_000;

interface ToolTrack {
  title: string;
  output: string;
  lastEmitAt: number;
  flushTimer: NodeJS.Timeout | undefined;
}

interface ReasoningTrack {
  startedAt: number;
  lastIndex: number;
  hadText: boolean;
}

const PLAN_STATUS: Record<string, PlanEntry["status"]> = { inProgress: "in_progress", completed: "completed", pending: "pending" };

export class CodexItemFlow {
  private readonly tools = new Map<string, ToolTrack>();
  private readonly reasoning = new Map<string, ReasoningTrack>();
  private readonly agentPhase = new Map<string, "commentary" | "final" | undefined>();

  constructor(private readonly deps: CodexItemFlowDeps) {}

  /** 某个工具调用正在显示的标题。 */
  titleOf(itemId: string): string | undefined {
    return this.tools.get(itemId)?.title;
  }

  /** 会话关闭：清掉还没触发的输出尾部刷新定时器。 */
  clearTimers(): void {
    for (const track of this.tools.values()) clearTimeout(track.flushTimer);
  }

  /**
   * 回合结束，清空这个回合留下的三张表。
   * 被我们中断的运行里没来得及结束的工具：Codex 不再为它们上报结束事件，这里明确记为“已取消”（`interrupted` 由会话判断）。
   * 逐个工具先清定时器、再按条件发“已取消”，最后三张表一起清空——次序与原来在 `finishRun` 里一样。
   */
  runEnded(runId: RunId, interrupted: boolean): void {
    for (const [callId, track] of this.tools) {
      clearTimeout(track.flushTimer);
      if (interrupted) this.deps.emit({ kind: "tool.updated", data: { callId, status: "cancelled", endedAt: isoNow() } }, runId);
    }
    this.tools.clear();
    this.reasoning.clear();
    this.agentPhase.clear();
  }

  // ── 条目 ──

  onItemStarted(params: Json): void {
    if (!this.deps.isCurrentTurn(params)) return;
    const item = asRecord(params["item"]);
    const type = str(item?.["type"]);
    if (!item || !type) return;
    switch (type) {
      case "userMessage":
        return this.deps.userMessage(item);
      case "agentMessage":
        return this.onAgentStart(item);
      case "reasoning": {
        const id = str(item["id"]);
        if (id) this.reasoning.set(id, { startedAt: Date.now(), lastIndex: -1, hadText: false });
        return;
      }
      case "contextCompaction":
        return;
      default:
        return this.onToolStart(item);
    }
  }

  onItemCompleted(params: Json): void {
    if (!this.deps.isCurrentTurn(params)) return;
    const item = asRecord(params["item"]);
    const type = str(item?.["type"]);
    if (!item || !type) return;
    switch (type) {
      case "userMessage":
        return this.deps.userMessage(item);
      case "agentMessage":
        return this.onAgentCompleted(item);
      case "reasoning":
        return this.onReasoningCompleted(item);
      case "contextCompaction":
        return this.deps.contextCompacted(params);
      default:
        return this.onToolEnd(item);
    }
  }

  // ── 助手文字 ──

  private static phaseOf(raw: unknown): "commentary" | "final" | undefined {
    if (raw === "final_answer") return "final";
    if (raw === "commentary") return "commentary";
    return undefined;
  }

  private onAgentStart(item: Json): void {
    const id = str(item["id"]);
    const run = this.deps.run();
    if (!id || !run) return;
    const phase = CodexItemFlow.phaseOf(item["phase"]);
    this.agentPhase.set(id, phase);
    run.agentTexts.push({ itemId: id, phase });
  }

  onAgentDelta(params: Json): void {
    if (!this.deps.isCurrentTurn(params)) return;
    const itemId = str(params["itemId"]);
    const text = str(params["delta"]);
    if (!itemId || !text) return;
    const phase = this.agentPhase.get(itemId);
    this.deps.emit({ kind: "assistant.delta", data: { itemId, text, ...(phase ? { phase } : {}) } });
  }

  private onAgentCompleted(item: Json): void {
    const itemId = str(item["id"]);
    if (!itemId) return;
    const phase = CodexItemFlow.phaseOf(item["phase"]) ?? this.agentPhase.get(itemId);
    const text = str(item["text"]);
    const entry = this.deps.run()?.agentTexts.find((candidate) => candidate.itemId === itemId);
    if (entry && phase) entry.phase = phase;
    this.deps.emit({ kind: "assistant.completed", data: { itemId, ...(text !== undefined ? { text } : {}), ...(phase ? { phase } : {}) } });
  }

  // ── 推理摘要 ──

  onReasoningDelta(params: Json): void {
    if (!this.deps.isCurrentTurn(params)) return;
    const itemId = str(params["itemId"]);
    const delta = str(params["delta"]);
    if (!itemId || !delta) return;
    let track = this.reasoning.get(itemId);
    if (!track) {
      track = { startedAt: Date.now(), lastIndex: -1, hadText: false };
      this.reasoning.set(itemId, track);
    }
    const index = num(params["summaryIndex"]) ?? num(params["contentIndex"]) ?? 0;
    // 不同的摘要段之间留一个空行。
    const separator = track.hadText && index > track.lastIndex ? "\n\n" : "";
    track.lastIndex = Math.max(track.lastIndex, index);
    track.hadText = true;
    this.deps.emit({ kind: "reasoning.delta", data: { itemId, text: `${separator}${delta}` } });
  }

  private onReasoningCompleted(item: Json): void {
    const itemId = str(item["id"]);
    if (!itemId) return;
    const track = this.reasoning.get(itemId);
    this.reasoning.delete(itemId);
    let hadText = track?.hadText === true;
    if (!hadText) {
      // 没有流式增量时，用完成时携带的文本补上。
      const text = [...(arr(item["summary"]) ?? []), ...(arr(item["content"]) ?? [])]
        .map((entry) => str(entry))
        .filter((entry): entry is string => !!entry)
        .join("\n\n");
      if (text) {
        this.deps.emit({ kind: "reasoning.delta", data: { itemId, text } });
        hadText = true;
      }
    }
    // 摘要和正文都为空（用户配置关闭了摘要）时不制造空的“思考”条目。
    if (hadText) this.deps.emit({ kind: "reasoning.completed", data: { itemId, ...(track ? { durationMs: Date.now() - track.startedAt } : {}) } });
  }

  // ── 工具 ──

  private onToolStart(item: Json): void {
    const update = toolStart(item, this.deps.cwd());
    if (!update) return;
    this.tools.set(update.callId, {
      title: update.title ?? "",
      output: "",
      lastEmitAt: 0,
      flushTimer: undefined,
    });
    this.deps.emit({ kind: "tool.updated", data: update });
  }

  onOutputDelta(params: Json): void {
    if (!this.deps.isCurrentTurn(params)) return;
    const itemId = str(params["itemId"]);
    const delta = str(params["delta"]);
    const track = itemId ? this.tools.get(itemId) : undefined;
    if (!itemId || !delta || !track) return;
    track.output = sliceTail(track.output + delta, OUTPUT_BUFFER_CHARS);

    const flush = (): void => {
      track.flushTimer = undefined;
      track.lastEmitAt = Date.now();
      this.deps.emit({ kind: "tool.updated", data: { callId: itemId, output: outputPreview(track.output) } });
    };
    const sinceLast = Date.now() - track.lastEmitAt;
    if (sinceLast >= OUTPUT_THROTTLE_MS) {
      clearTimeout(track.flushTimer);
      flush();
    } else if (!track.flushTimer) {
      // 节流窗口内的输出不能丢：安排一次尾部刷新，否则输出停顿后最后一段会一直看不到。
      track.flushTimer = setTimeout(flush, OUTPUT_THROTTLE_MS - sinceLast);
      track.flushTimer.unref?.();
    }
  }

  onToolProgress(params: Json): void {
    if (!this.deps.isCurrentTurn(params)) return;
    const itemId = str(params["itemId"]);
    const message = str(params["message"]);
    if (!itemId || !message || !this.tools.has(itemId)) return;
    this.deps.emit({ kind: "tool.updated", data: { callId: itemId, output: outputPreview(message) } });
  }

  private onToolEnd(item: Json): void {
    const cwd = this.deps.cwd();
    const end = toolEnd(item, cwd);
    if (!end) return;
    const callId = end.update.callId;
    const track = this.tools.get(callId);
    if (track) clearTimeout(track.flushTimer);
    if (!track) {
      // 没见过开始事件（例如接管时已在进行中）：先补一条开始，保证条目完整。
      const start = toolStart(item, cwd);
      if (start) this.deps.emit({ kind: "tool.updated", data: start });
    }
    this.tools.delete(callId);
    const update = { ...end.update };
    if (!update.output && track?.output) update.output = outputPreview(track.output);
    this.deps.emit({ kind: "tool.updated", data: update });
    if (end.files.length > 0) this.deps.emit({ kind: "file.changed", data: { callId, files: end.files } });
  }

  // ── 计划与用量 ──

  onPlan(params: Json): void {
    if (!this.deps.isCurrentTurn(params)) return;
    const entries = (arr(params["plan"]) ?? []).flatMap((raw): PlanEntry[] => {
      const step = asRecord(raw);
      const text = str(step?.["step"]);
      return step && text ? [{ text, status: PLAN_STATUS[str(step["status"]) ?? ""] ?? "pending" }] : [];
    });
    const explanation = str(params["explanation"]);
    this.deps.emit({ kind: "plan.updated", data: { entries, ...(explanation ? { explanation } : {}) } });
  }

  onTokenUsage(params: Json): void {
    const run = this.deps.run();
    if (!run || !this.deps.isCurrentTurn(params)) return;
    const result = usageOf(asRecord(params["tokenUsage"]) ?? {}, run.usageBase);
    if (!result) return;
    run.usageBase = result.base;
    this.deps.emit({ kind: "usage.updated", data: { usage: result.usage } });
  }
}
