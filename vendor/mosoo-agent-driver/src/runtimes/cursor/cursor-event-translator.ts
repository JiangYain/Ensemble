// ENSEMBLE ADDED — 本文件由 Ensemble 新增（Cursor SDK 后端），不属于上游 mosoo-agent-driver。详见 VENDORING.md。
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import type { RunId } from "../../protocol/id";
import type { RunError } from "../../runtime-command";
import { createThoughtContentEvents } from "../thought-content";
import { failureFromText, isAuthFailure, sdkFailure, toRunError } from "./cursor-errors";
import {
  DELETE_TOOLS,
  EDIT_TOOLS,
  MUTATING_TOOLS,
  READ_ONLY_SET,
  argsSize,
  exitCodeOf,
  fileChangeOf,
  isMcpTool,
  isShellCommandInput,
  mcpOf,
  pathOf,
  planEntriesOf,
  readTokenUsage,
  resultBody,
  resultText,
  toolTitle,
  zeroTotals,
} from "./cursor-tool-format";
import type { CursorTokenTotals } from "./cursor-tool-format";
import type { Json } from "./cursor-values";
import {
  arr,
  asRecord,
  clipMiddle,
  isString,
  normalizeText,
  num,
  oneLine,
  str,
  stringifyForDisplay,
} from "./cursor-values";

/** 每条工具输出 / diff 在事件里最多搬运这么多字符；更长的在中间省略并如实标注。 */
const MAX_EVENT_TEXT_CHARS = 256 * 1_024;
const TOOL_UPDATE_THROTTLE_MS = 250;
const MAX_TASK_NOTES = 40;

type Phase = "commentary" | "final";
type EventDelivery = "best_effort" | "lossless";

/** 一个会话内跨运行共享的“只记一次”备注。 */
export interface CursorSessionNotes {
  /** Cursor 实际使用的模型；与请求不同（例如 auto 被服务端换成具体模型）时才需要更新。 */
  modelId: string | undefined;
  toolsNoted: boolean;
}

export interface CursorTurnOptions {
  readonly cwd: string;
  /** 测试用：换成确定性的文件存在性判断。 */
  readonly fileExists?: (absolutePath: string) => boolean;
  readonly now?: () => number;
  readonly notes: CursorSessionNotes;
  /** 只读会话：看到变更类工具就说明 SDK 的工具白名单没有生效。 */
  readonly readOnly: boolean;
  readonly runId: RunId;
}

export interface TranslatedMessage {
  readonly events: DriverEventInput[];
  /** 流里的 user 回显（已归一化）：可能就是某条纠偏生效的证据，由后端对照判断。 */
  readonly userEcho?: string;
  /** 只读会话里出现了变更类工具：后端应取消这次运行，并以“被策略拦截”收场。 */
  readonly violation?: string;
}

export interface TurnFinish {
  /** 终态之前需要先送出的收尾事件（关闭推理 / 回答、取消未完成的工具、最终用量）。 */
  readonly events: DriverEventInput[];
  readonly error?: RunError;
  readonly finalMessageId?: string;
  readonly outcome: "cancelled" | "completed" | "failed";
}

interface ToolTrack {
  done: boolean;
  existedBefore: boolean | undefined;
  kind: "mcp" | "tool";
  lastEmitAt: number;
  name: string;
  path: string | undefined;
  signature: string;
  startedAt: string;
}

interface OpenAssistant {
  id: string;
  open: boolean;
  text: string;
}

interface OpenReasoning {
  id: string;
  startedAt: number;
  text: string;
}

function usagePayload(totals: CursorTokenTotals): Record<string, number | string> {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cachedReadTokens: totals.cacheRead,
    ...(totals.reasoning > 0 ? { thoughtTokens: totals.reasoning } : {}),
    totalTokens: totals.total,
    source: "cursor",
  };
}

/**
 * 把一次运行里 Cursor SDK 的消息流翻译成 Driver 的统一事件。
 *
 * 事件映射依据 @cursor/sdk 1.3.1 的类型定义与打包源码（不是猜测）：
 * - `assistant` 与 `thinking` 消息是增量（text-delta / thinking-delta）；推理结束用 `text: ""` + `thinking_duration_ms` 表示；
 * - `tool_call` 对应 tool-call-started / partial-tool-call / tool-call-completed：开始与增量都是 running，
 *   完成时才带 result，`status: "error"` 表示失败；
 * - 只要 result 的形状认得出就转成文本，认不出就原样给 JSON，不做猜测。
 *
 * 翻译器只负责“这条 SDK 消息对应哪些事件”，不做 IO；取消、纠偏与终态由后端负责。
 */
export class CursorTurnTranslator {
  /** 只读会话里看到变更类工具后记录的原因；终态据此判定为 policy_blocked。 */
  violation: string | undefined;

  readonly #cwd: string;
  readonly #fileExists: (absolutePath: string) => boolean;
  readonly #notes: CursorSessionNotes;
  readonly #now: () => number;
  readonly #readOnly: boolean;
  readonly #runId: RunId;
  readonly #tools = new Map<string, ToolTrack>();
  #assistant: OpenAssistant | undefined;
  #cancelObserved = false;
  #finished = false;
  #initNoted = false;
  #lastTaskNote: string | undefined;
  #reasoning: OpenReasoning | undefined;
  #requestNoted = false;
  #statusError: string | undefined;
  #taskNotes = 0;
  #totals: CursorTokenTotals = zeroTotals();

  constructor(options: CursorTurnOptions) {
    this.#cwd = options.cwd;
    this.#fileExists = options.fileExists ?? existsSync;
    this.#notes = options.notes;
    this.#now = options.now ?? Date.now;
    this.#readOnly = options.readOnly;
    this.#runId = options.runId;
  }

  // ── 单条消息 ──

  translate(raw: unknown): TranslatedMessage {
    const message = asRecord(raw);
    if (!message || this.#finished) return { events: [] };
    switch (str(message["type"])) {
      case "system":
        return { events: this.#onSystem(message) };
      case "user":
        return this.#onUser(message);
      case "assistant":
        return { events: this.#onAssistant(message) };
      case "thinking":
        return { events: this.#onThinking(message) };
      case "tool_call":
        return this.#onToolCall(message);
      case "usage":
        return { events: this.#onUsage(message) };
      case "status":
        return { events: this.#onStatus(message) };
      case "summary":
        return { events: this.#onSummary(message) };
      case "task":
        return { events: this.#onTask(message) };
      case "request":
        return { events: this.#onRequest(message) };
      default:
        return { events: [] };
    }
  }

  /** 流之外的补充说明（例如 SDK 不提供流式事件）。 */
  diagnostic(severity: "error" | "info" | "warn", code: string, message: string): DriverEventInput {
    return this.#diagnostic(severity, code, message);
  }

  // ── 收束 ──

  /**
   * 运行结束（含取消与失败）：产出终态之前的收尾事件，并判定终态。
   * 以 RunResult 为准校正流式增量，因为增量一旦丢了片段，只有这里能补回来。
   */
  finish(input: { cancelRequested: boolean; failure: unknown; result: unknown }): TurnFinish {
    this.#finished = true;
    const result = asRecord(input.result);
    const status = str(result?.["status"]);
    const blocked = this.violation !== undefined;
    // 取消请求与运行结束可能同时发生：SDK 明确说“已完成”时，以事实为准（内核若已认领取消，会改记为取消）。
    const cancelled = !blocked && (status === "cancelled" || (input.cancelRequested && status !== "finished"));
    const failed = blocked || (!cancelled && (status === "error" || (status === undefined && input.failure !== undefined)));
    const ok = !cancelled && !failed;

    const events: DriverEventInput[] = [...this.#completeReasoning(undefined)];
    const finalMessageId = this.#completeAnswer(events, ok, str(result?.["result"]));

    // 取消（或被拦截）时仍在运行的工具，是被取消请求打断的。
    if (cancelled || blocked) {
      for (const [toolCallId, track] of this.#tools) {
        if (track.done) continue;
        track.done = true;
        events.push(
          this.#event("tool.call.updated", {
            toolCallId,
            status: "cancelled",
            name: track.name,
            kind: track.kind,
            endedAt: new Date(this.#now()).toISOString(),
          }),
        );
      }
    }
    this.#tools.clear();

    const finalTotals = readTokenUsage(result?.["usage"]) ?? (this.#totals.reported ? this.#totals : undefined);
    if (finalTotals) events.push(this.#event("usage.updated", usagePayload(finalTotals)));

    if (blocked) {
      return {
        events,
        outcome: "failed",
        error: { code: "policy_blocked", details: {}, message: this.violation ?? "Blocked by the session's access policy.", retryable: false },
      };
    }
    if (cancelled) return { events, outcome: "cancelled" };
    if (failed) return { events, outcome: "failed", error: this.#runError(result, input.failure) };
    return { events, outcome: "completed", ...(finalMessageId ? { finalMessageId } : {}) };
  }

  // ── 事件构造 ──

  #event(kind: DriverEventInput["kind"], payload: Record<string, unknown>, delivery?: EventDelivery): DriverEventInput {
    return {
      kind,
      runId: this.#runId,
      occurredAt: new Date(this.#now()).toISOString(),
      payload,
      ...(delivery ? { delivery } : {}),
    };
  }

  #diagnostic(severity: "error" | "info" | "warn", code: string, message: string): DriverEventInput {
    return {
      ...this.#event("diagnostic.reported", { code, message, severity, source: "cursor" }),
      visibility: "participant",
    };
  }

  // ── 各类消息 ──

  #onSystem(message: Json): DriverEventInput[] {
    if (this.#initNoted) return [];
    this.#initNoted = true;
    const events: DriverEventInput[] = [];
    // Cursor 实际用的模型与我们请求的不同（例如 auto 被服务端换成了具体模型）时，如实更新。
    const modelId = str(asRecord(message["model"])?.["id"]);
    if (modelId && modelId !== this.#notes.modelId) {
      this.#notes.modelId = modelId;
      events.push(this.#event("model.routing.updated", { model: modelId, source: "cursor" }));
    }
    // 工具清单只在会话的第一次运行里记一次；只读会话里它也是白名单是否生效的证据。
    const tools = (arr(message["tools"]) ?? []).filter(isString);
    if (tools.length > 0 && !this.#notes.toolsNoted) {
      this.#notes.toolsNoted = true;
      events.push(this.#diagnostic("info", "cursor.tools", `Tools Cursor offered to the model: ${oneLine(tools.join(", "), 400)}`));
    }
    return events;
  }

  #onUser(message: Json): TranslatedMessage {
    const content = arr(asRecord(message["message"])?.["content"]) ?? [];
    const text = normalizeText(content.map((block) => str(asRecord(block)?.["text"]) ?? "").join(""));
    return text ? { events: [], userEcho: text } : { events: [] };
  }

  #onAssistant(message: Json): DriverEventInput[] {
    const events: DriverEventInput[] = [];
    const content = arr(asRecord(message["message"])?.["content"]) ?? [];
    for (const block of content) {
      const record = asRecord(block);
      if (str(record?.["type"]) !== "text") continue;
      const text = str(record?.["text"]);
      if (!text) continue;
      events.push(...this.#completeReasoning(undefined));
      if (!this.#assistant?.open) {
        this.#assistant = { id: createDriverId(), text: "", open: true };
        events.push(this.#event("message.started", { messageId: this.#assistant.id, role: "agent" }, "best_effort"));
      }
      this.#assistant.text += text;
      events.push(
        this.#event("message.delta", { messageId: this.#assistant.id, role: "agent", contentDelta: text }, "best_effort"),
      );
    }
    return events;
  }

  /** 关闭当前助手文本：全文以 message.added 落定（权威内容），再 message.completed。 */
  #closeAssistant(phase: Phase | undefined): DriverEventInput[] {
    const item = this.#assistant;
    if (!item?.open) return [];
    item.open = false;
    return this.#messageClosure(item.id, item.text, phase);
  }

  #messageClosure(messageId: string, text: string, phase: Phase | undefined): DriverEventInput[] {
    return [
      this.#event("message.added", { messageId, role: "agent", content: text, ...(phase ? { phase } : {}) }),
      this.#event("message.completed", { messageId, role: "agent", ...(phase ? { phase } : {}) }),
    ];
  }

  #onThinking(message: Json): DriverEventInput[] {
    const text = str(message["text"]) ?? "";
    const durationMs = num(message["thinking_duration_ms"]);
    if (text.length === 0 && durationMs === undefined) return [];
    const events: DriverEventInput[] = [...this.#closeAssistant("commentary")];
    if (!this.#reasoning) {
      this.#reasoning = { id: createDriverId(), startedAt: this.#now(), text: "" };
      events.push(this.#event("thought.started", { thoughtId: this.#reasoning.id, role: "agent", channel: "summary" }));
    }
    if (text.length > 0) {
      this.#reasoning.text += text;
      events.push(
        this.#event(
          "thought.delta",
          { thoughtId: this.#reasoning.id, role: "agent", channel: "summary", contentDelta: text },
          "best_effort",
        ),
      );
    }
    // 没有文本、只有时长时也要先建出这一项（上面的 thought.started），否则 thought.completed 无处挂靠。
    if (durationMs !== undefined) events.push(...this.#completeReasoning(durationMs));
    return events;
  }

  /** 推理收尾：先以 thought.updated 落定权威全文（超长时分块），再 thought.completed。 */
  #completeReasoning(durationMs: number | undefined): DriverEventInput[] {
    const item = this.#reasoning;
    if (!item) return [];
    this.#reasoning = undefined;
    const events: DriverEventInput[] = [];
    if (item.text.length > 0) {
      try {
        for (const update of createThoughtContentEvents(item.id, item.text)) {
          events.push({ ...update, runId: this.#runId, occurredAt: new Date(this.#now()).toISOString() });
        }
      } catch {
        // 推理全文超出事件上限时只保留流式增量，不让展示用途的内容拖垮运行。
      }
    }
    events.push(
      this.#event("thought.completed", {
        thoughtId: item.id,
        role: "agent",
        channel: "summary",
        durationMs: durationMs ?? Math.max(0, this.#now() - item.startedAt),
      }),
    );
    return events;
  }

  #onToolCall(message: Json): TranslatedMessage {
    const callId = str(message["call_id"]);
    if (!callId) return { events: [] };
    const name = str(message["name"]) ?? "tool";
    const status = str(message["status"]);
    const rawArgs = message["args"];
    const args = asRecord(rawArgs) ?? {};
    const cwd = this.#cwd;
    const now = this.#now();
    const events: DriverEventInput[] = [];
    let violation: string | undefined;

    let track = this.#tools.get(callId);
    const created = track === undefined;
    if (!track) {
      events.push(...this.#closeAssistant("commentary"), ...this.#completeReasoning(undefined));
      track = {
        name,
        kind: isMcpTool(name) ? "mcp" : "tool",
        path: undefined,
        existedBefore: undefined,
        startedAt: new Date(now).toISOString(),
        lastEmitAt: 0,
        signature: "",
        done: false,
      };
      this.#tools.set(callId, track);
      const blocked = this.#checkAccess(name);
      if (blocked) {
        violation = blocked;
        events.push(this.#diagnostic("error", "cursor.access_violation", blocked));
      }
    }
    if (track.done) return { events };

    const path = pathOf(args);
    if (path && !track.path) {
      track.path = path;
      // 编辑类工具开始时目标文件是否存在，决定“新建”还是“修改”；只有看到 running 事件才可靠。
      if (status !== "completed" && status !== "error" && EDIT_TOOLS.has(name.toLowerCase())) {
        track.existedBefore = this.#fileExists(resolvePath(cwd, path));
      }
    }

    const mcp = track.kind === "mcp" ? mcpOf(args) : undefined;
    const input = rawArgs !== undefined ? this.#inputOf(name, args, rawArgs) : undefined;

    if (status !== "completed" && status !== "error") {
      // 增量事件可能很密（参数一点点流出来），限频并且只在标题或参数有变化时更新。
      if (!created && now - track.lastEmitAt < TOOL_UPDATE_THROTTLE_MS) return withViolation(events, violation);
      const title = toolTitle(name, args, cwd);
      const signature = `${title}\u0000${argsSize(rawArgs)}`;
      if (!created && signature === track.signature) return withViolation(events, violation);
      track.signature = signature;
      track.lastEmitAt = now;
      events.push(
        this.#event("tool.call.updated", {
          toolCallId: callId,
          status: "running",
          name,
          kind: track.kind,
          title,
          ...(input ? { rawInput: input.text, inputFormat: input.format } : {}),
          startedAt: track.startedAt,
          ...(mcp ? { mcp } : {}),
        }),
      );
      return withViolation(events, violation);
    }

    track.done = true;
    const lower = name.toLowerCase();
    const mutating = EDIT_TOOLS.has(lower) || DELETE_TOOLS.has(lower);
    const result = message["result"];
    const truncated = asRecord(message["truncated"]);
    const text = resultText(lower, result, cwd);
    const exitCode = exitCodeOf(result);
    // SDK 的 tool_call.status 只要“调用结束”就是 completed；工具自己的失败写在 result.status === "error" 里。
    const failed =
      status === "error" ||
      asRecord(result)?.["status"] === "error" ||
      (lower === "shell" && exitCode !== undefined && exitCode !== 0) ||
      (lower === "mcp" && resultBody(result)?.["isError"] === true);
    // 这次运行已被要求取消，而工具恰好是在那之后失败的：是被取消打断的，不是工具自己的错。
    const cancelled = failed && this.#cancelObserved;
    const toolStatus = cancelled ? "cancelled" : failed ? "failed" : "completed";
    // 变更类工具的结果 JSON 对读者没有额外信息（文件变更单独展示），认不出形状时不原样倒出来。
    const output = mutating && text === undefined ? undefined : this.#outputOf(result, text, truncated?.["result"] === true);

    events.push(
      this.#event("tool.call.updated", {
        toolCallId: callId,
        status: toolStatus,
        name,
        kind: track.kind,
        title: toolTitle(name, args, cwd),
        ...(input ? { rawInput: input.text, inputFormat: input.format } : {}),
        startedAt: track.startedAt,
        endedAt: new Date(now).toISOString(),
        ...(output ? output : {}),
        ...(failed && !cancelled ? { errorMessage: oneLine(text || "The tool reported an error.", 400) } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(mcp ? { mcp } : {}),
      }),
    );
    if (failed) return withViolation(events, violation);

    if (track.path && mutating) {
      const change = fileChangeOf(lower, track, cwd, result);
      events.push(
        this.#event("file.change.updated", {
          toolCallId: callId,
          status: "completed",
          source: "cursor",
          changes: [
            {
              path: change.path,
              change: change.change,
              ...(change.created !== undefined ? { created: change.created } : {}),
              ...(change.addedLines !== undefined ? { addedLines: change.addedLines } : {}),
              ...(change.removedLines !== undefined ? { removedLines: change.removedLines } : {}),
              ...(change.diff ? { diff: clipMiddle(change.diff, MAX_EVENT_TEXT_CHARS) } : {}),
            },
          ],
        }),
      );
    }
    if (lower === "updatetodos") {
      const entries = planEntriesOf(args, result);
      if (entries) {
        events.push(
          this.#event("plan.updated", {
            source: "cursor",
            entries: entries.map((entry) => ({
              ...(entry.id ? { id: entry.id } : {}),
              content: entry.content,
              priority: "medium",
              status: entry.status,
            })),
          }),
        );
      }
    }
    return withViolation(events, violation);
  }

  /** 工具输入的展示文本：shell 直接给命令；其余给缩进过的 JSON；字符串原样。 */
  #inputOf(name: string, args: Json, raw: unknown): { format: "json" | "text"; text: string } | undefined {
    const command = isShellCommandInput(name, args);
    const shown = command !== undefined ? { text: command, format: "text" as const } : stringifyForDisplay(raw);
    return shown.text.length > 0 ? { text: clipMiddle(shown.text, MAX_EVENT_TEXT_CHARS), format: shown.format } : undefined;
  }

  #outputOf(
    result: unknown,
    text: string | undefined,
    truncatedBySdk: boolean,
  ): { outputChars: number; outputFormat: "json" | "text"; outputTruncated: boolean; rawOutput: string } | undefined {
    if (result === undefined || result === null) return undefined;
    const shown = text === undefined ? stringifyForDisplay(result) : { text, format: "text" as const };
    if (shown.text.length === 0) return undefined;
    return {
      rawOutput: clipMiddle(shown.text, MAX_EVENT_TEXT_CHARS),
      outputFormat: shown.format,
      outputChars: shown.text.length,
      outputTruncated: truncatedBySdk || shown.text.length > MAX_EVENT_TEXT_CHARS,
    };
  }

  /** 后端在收到取消请求后调用：此后失败的工具应记为“被取消打断”。 */
  markCancelObserved(): void {
    this.#cancelObserved = true;
  }

  /** 只读会话里出现了变更类工具：说明 SDK 的工具白名单没有按文档生效，必须明说并尽力中止。 */
  #checkAccess(name: string): string | undefined {
    if (!this.#readOnly || this.violation) return undefined;
    const lower = name.toLowerCase();
    if (READ_ONLY_SET.has(lower) || !MUTATING_TOOLS.has(lower)) return undefined;
    const message = `Cursor used the "${name}" tool in a read-only session, so the SDK tool allowlist was not enforced. Ensemble stopped the run.`;
    this.violation = message;
    this.#cancelObserved = true;
    return message;
  }

  #onUsage(message: Json): DriverEventInput[] {
    const turn = readTokenUsage(message["usage"]);
    if (!turn) return [];
    const totals = this.#totals;
    totals.input += turn.input;
    totals.output += turn.output;
    totals.cacheRead += turn.cacheRead;
    totals.reasoning += turn.reasoning;
    totals.total += turn.total;
    totals.reported = true;
    return [this.#event("usage.updated", usagePayload(totals))];
  }

  #onStatus(message: Json): DriverEventInput[] {
    const status = str(message["status"]);
    const text = str(message["message"]);
    if (status === "ERROR" && text) this.#statusError = text;
    if (status === "EXPIRED") {
      return [this.#diagnostic("warn", "cursor.expired", `The Cursor run expired${text ? `: ${oneLine(text, 200)}` : "."}`)];
    }
    return [];
  }

  #onSummary(message: Json): DriverEventInput[] {
    const status = str(message["status"]);
    if (status === "running") {
      return [this.#diagnostic("info", "cursor.summary", "Cursor is compacting the conversation to free up context.")];
    }
    if (status === "error") {
      return [this.#diagnostic("warn", "cursor.summary_failed", "Cursor could not compact the conversation; it was left unchanged.")];
    }
    return [];
  }

  #onTask(message: Json): DriverEventInput[] {
    const text = str(message["text"]);
    if (!text || text === this.#lastTaskNote || this.#taskNotes >= MAX_TASK_NOTES) return [];
    this.#lastTaskNote = text;
    this.#taskNotes += 1;
    return [this.#diagnostic("info", "cursor.task", oneLine(text, 300))];
  }

  #onRequest(message: Json): DriverEventInput[] {
    const requestId = str(message["request_id"]);
    if (!requestId || this.#requestNoted) return [];
    this.#requestNoted = true;
    return [this.#diagnostic("info", "cursor.request", `Cursor request id: ${requestId}`)];
  }

  // ── 最终回答 ──

  /**
   * 运行成功时，最后一段文本就是最终回答；以 RunResult.result 为准校正（流式增量一旦丢了片段，这里能补回来）。
   * 返回最终回答的 messageId（没有可展示的最终文本时为 undefined）。
   */
  #completeAnswer(events: DriverEventInput[], ok: boolean, finalText: string | undefined): string | undefined {
    const last = this.#assistant;
    const wanted = finalText?.trim() ? finalText : undefined;
    if (!ok) {
      events.push(...this.#closeAssistant(undefined));
      return undefined;
    }
    if (!wanted) {
      events.push(...this.#closeAssistant("final"));
      return last && last.text.length > 0 ? last.id : undefined;
    }
    if (last && normalizeText(last.text) === normalizeText(wanted)) {
      // 已经收尾为过程说明的最后一段文本也可能就是最终回答：晋升为 final。
      last.open = false;
      events.push(...this.#messageClosure(last.id, last.text, "final"));
      return last.id;
    }
    if (last?.open) {
      last.open = false;
      events.push(...this.#messageClosure(last.id, wanted, "final"));
      return last.id;
    }
    const id = createDriverId();
    events.push(...this.#messageClosure(id, wanted, "final"));
    return id;
  }

  #runError(result: Json | undefined, failure: unknown): RunError {
    const resultError = asRecord(result?.["error"]);
    const message = str(resultError?.["message"]);
    const code = str(resultError?.["code"]);
    if (message) {
      const info = failureFromText(message, code ? `Cursor error code: ${code}` : undefined);
      return toRunError(failure !== undefined && isAuthFailure(failure) ? { ...info, code: "auth_failed" } : info);
    }
    if (failure !== undefined) return toRunError(sdkFailure(failure, "Cursor reported an error."));
    return toRunError(failureFromText(this.#statusError ?? "Cursor reported an error."));
  }
}

function withViolation(events: DriverEventInput[], violation: string | undefined): TranslatedMessage {
  return violation ? { events, violation } : { events };
}
