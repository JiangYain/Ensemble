import type { AgentDriverRuntimeEvent } from "@mosoo/agent-driver";
import { LIMITS } from "@shared/constants";
import type { EventKind, EventPayload, ToolUpdate } from "@shared/events";
import { makePreview } from "@shared/format";
import type { ErrorInfo, FileChange, PlanEntry, Preview, RunId, ToolStatus, Usage } from "@shared/types";
import { arr, asRecord, categorizeTool, normalizeText, num, str } from "../executors/common";
import type { ExecutorDraft } from "../executors/types";

type DataOf<K extends EventKind> = Extract<EventPayload, { kind: K }>["data"];

const TOOL_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed", "cancelled"]);
const PLAN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Driver 的 RunError（code / message / retryable / details）还原成 Ensemble 的 ErrorInfo。 */
export function errorInfoFromPayload(raw: unknown): ErrorInfo {
  const error = asRecord(raw);
  const detail = str(asRecord(error?.["details"])?.["detail"]);
  return {
    code: str(error?.["code"]) ?? "run_failed",
    message: str(error?.["message"]) ?? "The Cursor run failed.",
    ...(detail ? { detail } : {}),
    ...(error?.["retryable"] === true ? { retryable: true } : {}),
  };
}

function previewOf(text: string, limit: number, format: unknown, originalChars?: number, sdkTruncated?: boolean): Preview {
  const hint = format === "json" || format === "text" || format === "diff" ? format : undefined;
  const preview = makePreview(text, limit, hint);
  const chars = originalChars !== undefined && originalChars > (preview.chars ?? 0) ? originalChars : preview.chars;
  const truncated = preview.truncated || sdkTruncated === true;
  return { ...preview, ...(chars !== undefined ? { chars } : {}), truncated };
}

/**
 * 把 Driver 内核吐出的统一事件翻译成 Ensemble 的执行端事件。
 *
 * 一个实例对应一次运行：条目编号（a1、r2……）按首次出现的顺序分配，编号写法和 Ensemble 一直以来的一致；
 * 它只在这一次运行之内唯一——投影里的条目键另带 runId，见 `projection-timeline.ts` 的 `itemKey`。
 * 只翻译执行端真实上报的事件；运行状态以外的事件（心跳、恢复指针等）由会话自己处理。
 */
export class RunEventMapper {
  readonly #answers = new Map<string, string>();
  readonly #items = new Map<string, string>();
  readonly #runId: RunId;
  #seq = 0;

  constructor(runId: RunId) {
    this.#runId = runId;
  }

  map(event: AgentDriverRuntimeEvent): ExecutorDraft[] {
    const payload = asRecord(event.payload);
    if (!payload) return [];
    switch (event.kind) {
      case "message.started":
        this.#itemOf(str(payload["messageId"]), "a");
        return [];
      case "message.delta":
        return this.#onMessageDelta(payload);
      case "message.added":
        return this.#onMessageAdded(payload);
      case "thought.started":
        return this.#onThoughtStarted(payload);
      case "thought.delta":
        return this.#onThoughtDelta(payload);
      case "thought.completed":
        return this.#onThoughtCompleted(payload);
      case "tool.call.updated":
        return this.#onTool(payload);
      case "file.change.updated":
        return this.#onFileChange(payload);
      case "plan.updated":
        return this.#onPlan(payload);
      case "usage.updated":
        return this.#onUsage(payload);
      case "model.routing.updated":
        return this.#onModel(payload);
      case "diagnostic.reported":
        return this.#onDiagnostic(payload);
      default:
        // message.completed / thought.updated 是权威全文的落定，已经在 message.added 处理；其余事件与时间线无关。
        return [];
    }
  }

  #draft<K extends EventKind>(kind: K, data: DataOf<K>): ExecutorDraft {
    return { kind, data, runId: this.#runId } as ExecutorDraft;
  }

  /** 同一个 Driver id 始终映射到同一个条目 id；第一次见到时按顺序编号。 */
  #itemOf(driverId: string | undefined, prefix: "a" | "r"): string {
    const key = driverId ?? `${prefix}?${this.#seq + 1}`;
    const known = this.#items.get(key);
    if (known) return known;
    const created = `${prefix}${++this.#seq}`;
    this.#items.set(key, created);
    return created;
  }

  // ── 助手文本 ──

  #onMessageDelta(payload: Record<string, unknown>): ExecutorDraft[] {
    const messageId = str(payload["messageId"]);
    const text = str(payload["contentDelta"]);
    if (!text) return [];
    const itemId = this.#itemOf(messageId, "a");
    if (messageId) this.#answers.set(messageId, `${this.#answers.get(messageId) ?? ""}${text}`);
    return [this.#draft("assistant.delta", { itemId, text })];
  }

  /**
   * message.added 带的是这段文本的权威全文：和流式增量拼出来的一致就只收尾；
   * 不一致（增量丢了片段）或之前根本没见过这条消息，就把全文随收尾一起给出。
   */
  #onMessageAdded(payload: Record<string, unknown>): ExecutorDraft[] {
    const messageId = str(payload["messageId"]);
    const content = str(payload["content"]) ?? "";
    const phase = payload["phase"] === "final" || payload["phase"] === "commentary" ? payload["phase"] : undefined;
    const known = messageId !== undefined && this.#items.has(messageId);
    const itemId = this.#itemOf(messageId, "a");
    const streamed = messageId ? (this.#answers.get(messageId) ?? "") : "";
    const matches = known && normalizeText(streamed) === normalizeText(content);
    if (messageId) this.#answers.set(messageId, content);
    return [
      this.#draft("assistant.completed", {
        itemId,
        ...(matches || content.length === 0 ? {} : { text: content }),
        ...(phase ? { phase } : {}),
      }),
    ];
  }

  // ── 推理 ──

  #onThoughtStarted(payload: Record<string, unknown>): ExecutorDraft[] {
    const itemId = this.#itemOf(str(payload["thoughtId"]), "r");
    // 先建出这一项，只有时长没有文本时 reasoning.completed 才有地方挂靠。
    return [this.#draft("reasoning.delta", { itemId, text: "" })];
  }

  #onThoughtDelta(payload: Record<string, unknown>): ExecutorDraft[] {
    const text = str(payload["contentDelta"]);
    if (!text) return [];
    return [this.#draft("reasoning.delta", { itemId: this.#itemOf(str(payload["thoughtId"]), "r"), text })];
  }

  #onThoughtCompleted(payload: Record<string, unknown>): ExecutorDraft[] {
    const durationMs = num(payload["durationMs"]);
    return [
      this.#draft("reasoning.completed", {
        itemId: this.#itemOf(str(payload["thoughtId"]), "r"),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }),
    ];
  }

  // ── 工具、文件、计划 ──

  #onTool(payload: Record<string, unknown>): ExecutorDraft[] {
    const callId = str(payload["toolCallId"]);
    if (!callId) return [];
    const status = str(payload["status"]);
    const name = str(payload["name"]);
    const rawInput = str(payload["rawInput"]);
    const rawOutput = str(payload["rawOutput"]);
    const title = str(payload["title"]);
    const startedAt = str(payload["startedAt"]);
    const endedAt = str(payload["endedAt"]);
    const error = str(payload["errorMessage"]);
    const exitCode = num(payload["exitCode"]);
    const mcpRecord = asRecord(payload["mcp"]);
    const server = str(mcpRecord?.["server"]);
    const tool = str(mcpRecord?.["tool"]);

    const update: ToolUpdate = {
      callId,
      ...(name ? { name, category: categorizeTool(name) } : {}),
      ...(title ? { title } : {}),
      ...(status && TOOL_STATUSES.has(status) ? { status: status as ToolStatus } : {}),
      ...(rawInput !== undefined ? { input: previewOf(rawInput, LIMITS.maxToolInputChars, payload["inputFormat"]) } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(rawOutput !== undefined && rawOutput.length > 0
        ? {
            output: previewOf(
              rawOutput,
              LIMITS.maxToolOutputChars,
              payload["outputFormat"],
              num(payload["outputChars"]),
              payload["outputTruncated"] === true,
            ),
          }
        : {}),
      ...(error ? { error } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(server || tool ? { mcp: { ...(server ? { server } : {}), ...(tool ? { tool } : {}) } } : {}),
    };
    return [this.#draft("tool.updated", update)];
  }

  #onFileChange(payload: Record<string, unknown>): ExecutorDraft[] {
    const files: FileChange[] = [];
    for (const raw of arr(payload["changes"]) ?? []) {
      const change = asRecord(raw);
      const path = str(change?.["path"]);
      const kind = str(change?.["change"]);
      // Driver 只区分 upsert / delete；是否新建靠 created 标记，Ensemble 的时间线要把它们分开展示。
      if (!change || !path || (kind !== "upsert" && kind !== "delete")) continue;
      const added = num(change["addedLines"]);
      const removed = num(change["removedLines"]);
      const diff = str(change["diff"]);
      files.push({
        path,
        change: kind === "delete" ? "deleted" : change["created"] === true ? "created" : "modified",
        ...(added !== undefined ? { addedLines: added } : {}),
        ...(removed !== undefined ? { removedLines: removed } : {}),
        ...(diff ? { diff: { ...makePreview(diff, LIMITS.maxToolInputChars, "diff"), format: "diff" as const } } : {}),
      });
    }
    if (files.length === 0) return [];
    const callId = str(payload["toolCallId"]);
    return [this.#draft("file.changed", { ...(callId ? { callId } : {}), files })];
  }

  #onPlan(payload: Record<string, unknown>): ExecutorDraft[] {
    const entries: PlanEntry[] = [];
    for (const raw of arr(payload["entries"]) ?? []) {
      const entry = asRecord(raw);
      const text = str(entry?.["content"]);
      const status = str(entry?.["status"]);
      if (!entry || !text || !status || !PLAN_STATUSES.has(status)) continue;
      const id = str(entry["id"]);
      entries.push({ ...(id ? { id } : {}), text, status: status as PlanEntry["status"] });
    }
    return entries.length > 0 ? [this.#draft("plan.updated", { entries })] : [];
  }

  // ── 用量、模型、诊断 ──

  #onUsage(payload: Record<string, unknown>): ExecutorDraft[] {
    const reasoning = num(payload["thoughtTokens"]);
    const usage: Usage = {
      inputTokens: num(payload["inputTokens"]) ?? 0,
      outputTokens: num(payload["outputTokens"]) ?? 0,
      cachedTokens: num(payload["cachedReadTokens"]) ?? 0,
      ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
      totalTokens: num(payload["totalTokens"]) ?? 0,
    };
    return [this.#draft("usage.updated", { usage })];
  }

  #onModel(payload: Record<string, unknown>): ExecutorDraft[] {
    const model = str(payload["model"]);
    if (!model) return [];
    return [this.#draft("session.updated", { patch: { model: { resolved: model, label: model } } })];
  }

  #onDiagnostic(payload: Record<string, unknown>): ExecutorDraft[] {
    const code = str(payload["code"]);
    const message = str(payload["message"]);
    const severity = str(payload["severity"]);
    if (!isString(code) || !isString(message)) return [];
    const level = severity === "error" || severity === "warn" || severity === "info" ? severity : "info";
    return [this.#draft("diagnostic", { level, code, message })];
  }
}
