import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { ENV } from "@shared/constants";
import { clip, errorMessage, isoNow, tail } from "@shared/format";
import type { AccessEnforcement, AccessLevel, Capabilities, HarnessInfo, MessageId, ModelInfo, RunId } from "@shared/types";
import {
  HarnessStartError,
  arr,
  asRecord,
  categorizeTool,
  errorInfoFromText,
  normalizeText,
  num,
  oneLine,
  outputPreview,
  str,
  textOfContent,
  type Json,
} from "./common";
import {
  ZERO_TOTALS,
  fileChangesOf,
  isThinkingLevel,
  readTotals,
  toModelInfo,
  toolInput,
  toolTitle,
  usageSince,
  type FileToolInfo,
  type Totals,
} from "./pi-items";
import { PiRpc, resolvePiEntry } from "./pi-rpc";
import { runCapture, spawnJsonl } from "./process";
import { ProcessSession, SteerTrack } from "./process-session";
import type { Executor, ExecutorSession, OpenInput, StartRunInput, SteerInput, SteerOutcome } from "./types";

/**
 * Pi 适配器：通过 `pi --mode rpc`（严格 \n 分隔的 JSONL）驱动一个完整的 Pi 会话。
 *
 * 事件映射以真实运行抓到的序列为准（Pi 0.84.x，Windows）：
 * - `message_end(assistant, stopReason=toolUse)` 先于 `tool_execution_start`；同一条助手消息里可以并行发起多个工具；
 * - 纠偏：`response steer` → `queue_update{steering:[原文]}` → 回合边界 → `message_start(user, 原文)`，
 *   最后一条才是“已生效”的证据；
 * - 取消：旧版 Pi 用 stopReason "error" 和 "This operation was aborted" 报告中止；
 *   结合是否确实发过 abort 判断，普通失败和自然完成不受取消请求影响。
 */

/**
 * live = 在真实 Pi 上跑通过（Pi 0.84.4 · Windows 11 · 2026-11-07 · `scripts/smoke.ts pi`，
 * 覆盖：正常完成、运行中纠偏、取消、服务重启后的原生会话恢复、推理文本、只读工具白名单）。
 * 换了 Pi 版本或操作系统后，这些结论需要重新验证。
 */
const PI_CAPABILITIES: Capabilities = {
  steer: { support: "yes", mode: "turn_boundary", verification: "live" },
  followUp: { support: "yes", mode: "after_run", verification: "live" },
  cancel: { support: "yes", verification: "live" },
  resume: { support: "yes", verification: "live" },
  reasoning: { support: "yes", verification: "live" },
  plan: { support: "no" },
  usage: { support: "yes", verification: "live" },
  // 只能从 write / edit 工具调用得知文件变更；bash 里的改动看不到。
  fileEvents: { support: "partial", verification: "live" },
};

const PI_ACCESS: Record<AccessLevel, AccessEnforcement | null> = {
  read_only: { level: "enforced", mechanism: "Pi tool allowlist: read, grep, find, ls (no bash / edit / write)" },
  full: { level: "none", mechanism: "Pi default tools, no sandbox and no approval prompts: edit / write / bash can reach any path the OS user can" },
};

const READ_ONLY_TOOLS = "read,grep,find,ls";
const START_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 25_000;
const TOOL_OUTPUT_THROTTLE_MS = 250;

// ───────────────────────── 执行端 ─────────────────────────

export interface PiExecutorOptions {
  /** 直接指定 Pi 的 JS 入口（测试时指向假 Pi）。 */
  cli?: string;
  env?: NodeJS.ProcessEnv;
}

export class PiExecutor implements Executor {
  readonly id = "pi" as const;
  readonly runtime = "native" as const;
  readonly canResume = true;

  constructor(private readonly options: PiExecutorOptions = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  async probe(): Promise<HarnessInfo> {
    const base = {
      id: "pi" as const,
      displayName: "Pi",
      runtime: "native" as const,
      capabilities: PI_CAPABILITIES,
      access: PI_ACCESS,
      models: [] as ModelInfo[],
    };
    const entry = await resolvePiEntry({ cli: this.options.cli, env: this.env });
    if (!entry) {
      return {
        ...base,
        status: "unavailable",
        setup: {
          code: "pi_not_found",
          message: "The Pi CLI was not found on PATH.",
          command: "npm install -g @earendil-works/pi-coding-agent",
        },
        checkedAt: isoNow(),
      };
    }

    const versionResult = await runCapture(process.execPath, [entry, "--version"], { timeoutMs: 10_000, env: this.env });
    const version = `${versionResult.stdout}\n${versionResult.stderr}`.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];

    const proc = spawnJsonl(process.execPath, [entry, "--mode", "rpc", "--offline", "--no-approve", "--no-session"], {
      cwd: tmpdir(),
      env: this.env,
    });
    const rpc = new PiRpc(proc, () => undefined);
    try {
      const [modelsResponse, stateResponse] = await Promise.all([
        rpc.request("get_available_models", {}, PROBE_TIMEOUT_MS),
        rpc.request("get_state", {}, PROBE_TIMEOUT_MS),
      ]);
      const state = asRecord(asRecord(stateResponse["data"])?.["model"]);
      const defaultId = str(state?.["id"]);
      const defaultProvider = str(state?.["provider"]);
      const defaultKey = defaultId ? (defaultProvider ? `${defaultProvider}/${defaultId}` : defaultId) : undefined;
      const defaultEffort = str(asRecord(stateResponse["data"])?.["thinkingLevel"]);
      const models = (arr(asRecord(modelsResponse["data"])?.["models"]) ?? [])
        .map((raw) => toModelInfo(raw, defaultKey, defaultEffort))
        .filter((model): model is ModelInfo => model !== undefined);

      const info: HarnessInfo = {
        ...base,
        status: models.length > 0 ? "ready" : "needs_setup",
        models,
        ...(defaultKey ? { defaultModel: defaultKey } : {}),
        ...(version ? { version } : {}),
        checkedAt: isoNow(),
      };
      if (models.length === 0) {
        info.setup = {
          code: "pi_no_models",
          message: "Pi has no usable models. Start Pi and sign in with /login, or set a provider API key.",
          command: "pi",
        };
      }
      return info;
    } catch (error) {
      const reason = proc.stderrTail().split(/\r?\n/).find((line) => line.trim().length > 0);
      return {
        ...base,
        status: "unavailable",
        ...(version ? { version } : {}),
        setup: {
          code: "pi_probe_failed",
          message: reason ? `${errorMessage(error)} (${clip(reason.trim(), 200)})` : errorMessage(error),
        },
        checkedAt: isoNow(),
      };
    } finally {
      rpc.failAll(new Error("probe finished"));
      await proc.kill();
    }
  }

  async open(input: OpenInput): Promise<ExecutorSession> {
    const entry = await resolvePiEntry({ cli: this.options.cli, env: this.env });
    if (!entry) {
      throw new HarnessStartError("harness_unavailable", "The Pi CLI was not found on PATH.");
    }
    const session = new PiSession(entry, input, this.env);
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }
}

// ───────────────────────── 会话 ─────────────────────────

interface RunState {
  id: RunId;
  messageId: MessageId;
  started: boolean;
  finishing: boolean;
  abortSent: boolean;
  /** 最近一次 agent_end 里最后一条助手消息的结束原因。 */
  stop?: { reason: string | undefined; error: string | undefined };
}

/** Pi 的纠偏靠比对文本：队列里出现过（listed）又消失（consumed），或者用户消息回显里出现同样的文本。 */
class PiSteer extends SteerTrack {
  /** 在 Pi 的 steering 队列里出现过。 */
  listed = false;
  /** 出现过之后又从队列里消失（说明已被消费）。 */
  consumed = false;

  constructor(readonly text: string) {
    super();
  }
}

function wasAborted(reason: string | undefined, message: string | undefined): boolean {
  return reason === "aborted" || (reason === "error" && /\boperation (?:was )?aborted\b/i.test(message ?? ""));
}

interface Block {
  kind: "text" | "thinking";
  itemId: string;
  startedAt: number;
}

interface AssistantState {
  id: string;
  blocks: Map<number, Block>;
  textItemIds: string[];
  hasToolCalls: boolean;
}

interface ToolTrack extends FileToolInfo {
  lastOutputAt: number;
}

interface ArgBuffer {
  callId: string;
  name: string;
  json: string;
  existedBefore: boolean | undefined;
}

class PiSession extends ProcessSession<PiRpc> {
  private run: RunState | undefined;
  private assistant: AssistantState | undefined;
  private msgSeq = 0;
  private readonly steers = new Map<MessageId, PiSteer>();
  private readonly tools = new Map<string, ToolTrack>();
  private readonly argBuffers = new Map<number, ArgBuffer>();
  private readonly existedByCall = new Map<string, boolean>();

  private totals: Totals = ZERO_TOTALS;
  private baseline: Totals = ZERO_TOTALS;

  constructor(
    private readonly entry: string,
    input: OpenInput,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super(input, "Pi");
  }

  protected activeRunId(): RunId | undefined {
    return this.run?.id;
  }

  // ── 启动 ──

  private buildArgs(): string[] {
    const { meta, resume } = this.input;
    const args = [this.entry, "--mode", "rpc", "--offline", "--no-approve", "--name", clip(meta.title, 80)];
    const sessionRef = resume?.path ?? resume?.id;
    if (sessionRef) args.push("--session", sessionRef);
    if (meta.model?.requested) args.push("--model", meta.model.requested);
    if (meta.effort && isThinkingLevel(meta.effort)) args.push("--thinking", meta.effort);
    if (meta.access === "read_only") args.push("--tools", READ_ONLY_TOOLS);
    return args;
  }

  async start(): Promise<void> {
    const { meta, log, signal } = this.input;
    this.proc = spawnJsonl(process.execPath, this.buildArgs(), {
      cwd: meta.cwd,
      env: {
        ...this.env,
        [ENV.parentSession]: meta.id,
        [ENV.parentDepth]: String(meta.depth),
      },
      onNonJson: (line) => log.debug("pi: non-JSON stdout line", { line: clip(line, 200) }),
    });
    this.rpc = new PiRpc(
      this.proc,
      (event) => this.handle(event),
      (response) => log.debug("pi: unmatched response", { response }),
    );
    this.proc.onExit((info) => this.onExit(info));
    signal.addEventListener("abort", () => void this.close(), { once: true });

    let state: Json | undefined;
    try {
      const [stateResponse, statsResponse] = await Promise.all([
        this.rpc.request("get_state", {}, START_TIMEOUT_MS),
        this.rpc.request("get_session_stats", {}, START_TIMEOUT_MS),
      ]);
      state = asRecord(stateResponse["data"]);
      this.totals = readTotals(statsResponse) ?? this.totals;
    } catch (error) {
      throw this.startError(error);
    }

    const sessionId = str(state?.["sessionId"]);
    const sessionFile = str(state?.["sessionFile"]);
    if (sessionId) {
      this.nativeRef = { kind: "pi-session", id: sessionId, ...(sessionFile ? { path: sessionFile } : {}) };
    }

    const model = asRecord(state?.["model"]);
    const modelId = str(model?.["id"]);
    const provider = str(model?.["provider"]);
    const thinking = str(state?.["thinkingLevel"]);
    this.emit({
      kind: "session.updated",
      data: {
        patch: {
          ...(modelId
            ? {
                model: {
                  resolved: provider ? `${provider}/${modelId}` : modelId,
                  label: str(model?.["name"]) ?? modelId,
                  ...(provider ? { provider } : {}),
                },
              }
            : {}),
          ...(thinking && model?.["reasoning"] === true ? { effort: thinking } : {}),
        },
      },
    });
  }

  /** 把启动阶段的失败转换成可行动的错误：Pi 启动失败时 stderr 里通常有明确原因。 */
  private startError(error: unknown): HarnessStartError {
    const stderr = this.proc.stderrTail().trim();
    const reason = stderr.split(/\r?\n/).find((line) => line.trim().length > 0) ?? errorMessage(error);
    const text = reason.replace(/^Error:\s*/, "");
    const code = /model .*not found/i.test(text) ? "model_not_found" : "start_failed";
    return new HarnessStartError(code, `Pi could not start: ${clip(text, 300)}`, stderr ? tail(stderr, 1_500) : undefined);
  }

  // ── ExecutorSession ──

  async startRun(input: StartRunInput): Promise<void> {
    if (this.closing) throw new Error("The Pi session is closed.");
    if (this.run) throw new Error("A run is already active in this Pi session.");
    const run: RunState = { id: input.runId, messageId: input.messageId, started: false, finishing: false, abortSent: false };
    this.run = run;
    this.baseline = { ...this.totals };
    try {
      await this.rpc.request("prompt", { message: input.prompt });
    } catch (error) {
      if (this.run === run) this.run = undefined;
      throw error;
    }
  }

  async steer(input: SteerInput): Promise<SteerOutcome> {
    const run = this.run;
    if (!run || run.id !== input.runId || run.finishing) {
      return { kind: "needs_follow_up", reason: "run_in_progress", evidence: "pi: no active run to steer" };
    }
    const track = new PiSteer(normalizeText(input.text));
    this.steers.set(input.messageId, track);
    try {
      await this.rpc.request("steer", { message: input.text });
    } catch (error) {
      this.steers.delete(input.messageId);
      throw error;
    }
    track.accept((evidence) => this.emitApplied(input.messageId, evidence, run.id));
    return {
      kind: "queued_by_harness",
      reason: "turn_boundary",
      evidence: "pi: steer accepted; delivered after the current turn finishes its tool calls",
    };
  }

  async cancel(runId: RunId): Promise<void> {
    const run = this.run;
    if (!run || run.id !== runId || run.finishing) return;
    // abort 之后 Pi 会继续处理队列里剩下的消息，所以先清空队列，被清掉的纠偏记为已取消。
    let cleared: Json | undefined;
    try {
      cleared = asRecord((await this.rpc.request("clear_queue", {}, 5_000))["data"]);
    } catch (error) {
      this.input.log.warn("pi: clear_queue before abort failed", { error: errorMessage(error) });
    }
    // clear_queue 和 abort 都是会话级命令。等待回执时，下一次运行可能已经开始。
    if (this.run !== run || this.closing) return;
    if (cleared) {
      const texts = new Set((arr(cleared?.["steering"]) ?? []).map((value) => normalizeText(String(value))));
      for (const [messageId, track] of this.steers) {
        if (!track.applied && texts.has(track.text)) {
          this.steers.delete(messageId);
          this.emit({
            kind: "message.delivery",
            data: {
              messageId,
              record: { stage: "cancelled", at: isoNow(), evidence: "pi: removed from the steering queue by clear_queue before abort" },
            },
            runId: run.id,
          });
        }
      }
    }
    if (run.finishing) return;
    // 请求立即写入进程；响应通常要等到 agent_settled 之后。
    run.abortSent = true;
    void this.rpc.request("abort", {}, 60_000).catch((error: unknown) => {
      if (this.run === run) run.abortSent = false;
      this.input.log.warn("pi: abort failed", { error: errorMessage(error) });
    });
  }

  // ── 事件映射 ──

  private handle(event: Json): void {
    switch (str(event["type"])) {
      case "agent_start":
        return this.onAgentStart();
      case "message_start":
        return this.onMessageStart(asRecord(event["message"]));
      case "message_update":
        return this.onMessageUpdate(asRecord(event["assistantMessageEvent"]));
      case "message_end":
        return this.onMessageEnd(asRecord(event["message"]));
      case "tool_execution_start":
        return this.onToolStart(event);
      case "tool_execution_update":
        return this.onToolUpdate(event);
      case "tool_execution_end":
        return this.onToolEnd(event);
      case "turn_end":
        return void this.pushUsage();
      case "queue_update":
        return this.onQueueUpdate(arr(event["steering"]) ?? []);
      case "agent_end":
        return this.onAgentEnd(event);
      case "agent_settled":
        return void this.finishRun();
      case "auto_retry_start":
        return this.diagnostic(
          "warn",
          "pi.auto_retry",
          `Provider error, Pi is retrying (${num(event["attempt"]) ?? "?"}/${num(event["maxAttempts"]) ?? "?"}): ${oneLine(str(event["errorMessage"]) ?? "", 200)}`,
        );
      case "auto_retry_end":
        if (event["success"] === false && this.run) {
          this.run.stop = { reason: "error", error: str(event["finalError"]) ?? "Pi gave up retrying." };
        }
        return;
      case "compaction_start":
        return this.diagnostic("info", "pi.compaction", `Pi is compacting the context (${str(event["reason"]) ?? "unknown reason"}).`);
      case "compaction_end":
        if (event["aborted"] === true || str(event["errorMessage"])) {
          this.diagnostic("warn", "pi.compaction_failed", `Context compaction did not complete: ${oneLine(str(event["errorMessage"]) ?? "aborted", 200)}`);
        }
        return;
      case "extension_ui_request":
        return this.onExtensionUi(event);
      case "extension_error":
        return this.diagnostic(
          "warn",
          "pi.extension_error",
          `A Pi extension failed: ${oneLine(str(event["error"]) ?? "unknown error", 240)}`,
        );
      default:
        return;
    }
  }

  private onAgentStart(): void {
    const run = this.run;
    if (!run || run.started) return;
    run.started = true;
    this.emit({ kind: "run.started", data: {} });
  }

  private onMessageStart(message: Json | undefined): void {
    if (!message) return;
    const role = str(message["role"]);
    if (role === "assistant") {
      this.assistant = { id: `m${++this.msgSeq}`, blocks: new Map(), textItemIds: [], hasToolCalls: false };
      this.argBuffers.clear();
    } else if (role === "user") {
      this.onUserMessage(normalizeText(textOfContent(message["content"])));
    }
  }

  /** 用户消息被写进 Pi 的会话：如果它就是某条待生效的纠偏，这就是“已生效”的证据。 */
  private onUserMessage(text: string): void {
    const run = this.run;
    if (!run) return;
    for (const [messageId, track] of this.steers) {
      if (track.applied || track.text !== text) continue;
      track.echo("pi: message_start(user) — the steering message entered the conversation", (evidence) =>
        this.emitApplied(messageId, evidence, run.id),
      );
      return;
    }
  }

  private onQueueUpdate(steering: unknown[]): void {
    const queued = new Set(steering.map((value) => normalizeText(String(value))));
    for (const track of this.steers.values()) {
      if (track.applied) continue;
      if (queued.has(track.text)) track.listed = true;
      else if (track.listed) track.consumed = true;
    }
  }

  private onMessageUpdate(update: Json | undefined): void {
    const assistant = this.assistant;
    if (!update || !assistant) return;
    const index = num(update["contentIndex"]) ?? 0;
    const itemId = `${assistant.id}:${index}`;

    switch (str(update["type"])) {
      case "text_start":
        assistant.blocks.set(index, { kind: "text", itemId, startedAt: Date.now() });
        assistant.textItemIds.push(itemId);
        return;
      case "text_delta": {
        const text = str(update["delta"]);
        if (text) this.emit({ kind: "assistant.delta", data: { itemId, text } });
        return;
      }
      case "text_end": {
        const text = str(update["content"]);
        this.emit({ kind: "assistant.completed", data: { itemId, ...(text !== undefined ? { text } : {}) } });
        return;
      }
      case "thinking_start":
        assistant.blocks.set(index, { kind: "thinking", itemId, startedAt: Date.now() });
        return;
      case "thinking_delta": {
        const text = str(update["delta"]);
        if (text) this.emit({ kind: "reasoning.delta", data: { itemId, text } });
        return;
      }
      case "thinking_end": {
        const block = assistant.blocks.get(index);
        this.emit({
          kind: "reasoning.completed",
          data: { itemId, ...(block ? { durationMs: Date.now() - block.startedAt } : {}) },
        });
        return;
      }
      case "toolcall_start": {
        assistant.hasToolCalls = true;
        const callId = str(update["id"]);
        const name = str(update["toolName"]);
        if (callId && name) this.argBuffers.set(index, { callId, name, json: "", existedBefore: undefined });
        return;
      }
      case "toolcall_delta":
        return this.onToolArgsDelta(index, str(update["delta"]) ?? "");
      case "toolcall_end": {
        // 参数在流式输出期间就已确定路径；这里只在没捕获到时兜底（此时工具可能已经开始，结果仅供参考）。
        const call = asRecord(update["toolCall"]);
        const callId = str(call?.["id"]);
        const path = str(asRecord(call?.["arguments"])?.["path"]);
        if (callId && str(call?.["name"]) === "write" && path && !this.existedByCall.has(callId)) {
          this.existedByCall.set(callId, existsSync(resolvePath(this.input.meta.cwd, path)));
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * write 工具在 tool_execution_start 之后几毫秒内就执行完，那时再检查文件是否存在已经来不及。
   * 模型流式输出参数期间路径通常很早就出现，在这时记录“写入前是否存在”才可靠。
   */
  private onToolArgsDelta(index: number, delta: string): void {
    const buffer = this.argBuffers.get(index);
    if (!buffer) return;
    buffer.json += delta;
    if (buffer.name !== "write" || buffer.existedBefore !== undefined) return;
    const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buffer.json);
    if (!match?.[1]) return;
    try {
      const path = JSON.parse(`"${match[1]}"`) as string;
      buffer.existedBefore = existsSync(resolvePath(this.input.meta.cwd, path));
      this.existedByCall.set(buffer.callId, buffer.existedBefore);
    } catch {
      // 路径尚未完整，等下一段增量。
    }
  }

  private onMessageEnd(message: Json | undefined): void {
    const assistant = this.assistant;
    if (!message || str(message["role"]) !== "assistant" || !assistant) return;
    const reason = str(message["stopReason"]);
    // 带工具调用的助手消息里的文字只是过程说明；以 stop 结束的那条才是最终回答。
    const phase = assistant.hasToolCalls || reason === "toolUse" ? "commentary" : "final";
    for (const itemId of assistant.textItemIds) {
      this.emit({ kind: "assistant.completed", data: { itemId, phase } });
    }
    this.assistant = undefined;
  }

  private onToolStart(event: Json): void {
    const callId = str(event["toolCallId"]);
    const name = str(event["toolName"]);
    if (!callId || !name) return;
    const args = asRecord(event["args"]) ?? {};
    const cwd = this.input.meta.cwd;
    const path = str(args["path"]) ?? str(args["file_path"]) ?? str(args["filePath"]);
    const category = categorizeTool(name);
    this.tools.set(callId, {
      name,
      path,
      existedBefore: this.existedByCall.get(callId),
      content: name === "write" ? str(args["content"]) : undefined,
      lastOutputAt: 0,
    });
    this.emit({
      kind: "tool.updated",
      data: {
        callId,
        name,
        category,
        title: toolTitle(name, args, cwd),
        status: "running",
        input: toolInput(name, args),
        startedAt: isoNow(),
      },
    });
  }

  private onToolUpdate(event: Json): void {
    const callId = str(event["toolCallId"]);
    const track = callId ? this.tools.get(callId) : undefined;
    if (!callId || !track) return;
    const now = Date.now();
    if (now - track.lastOutputAt < TOOL_OUTPUT_THROTTLE_MS) return;
    const text = textOfContent(asRecord(event["partialResult"])?.["content"]);
    if (!text) return;
    track.lastOutputAt = now;
    this.emit({ kind: "tool.updated", data: { callId, output: outputPreview(text) } });
  }

  private onToolEnd(event: Json): void {
    const callId = str(event["toolCallId"]);
    const track = callId ? this.tools.get(callId) : undefined;
    if (!callId || !track) return;
    this.tools.delete(callId);
    this.existedByCall.delete(callId);

    const result = asRecord(event["result"]);
    const text = textOfContent(result?.["content"]);
    const failed = event["isError"] === true;
    const cancelled = failed && this.run?.abortSent === true && wasAborted("error", text);
    const exitCode = track.name === "bash" && failed ? Number(/exit(?:ed)?(?: with)? code[: ]+(-?\d+)/i.exec(text)?.[1]) : undefined;

    this.emit({
      kind: "tool.updated",
      data: {
        callId,
        status: cancelled ? "cancelled" : failed ? "failed" : "completed",
        endedAt: isoNow(),
        ...(text ? { output: outputPreview(text) } : {}),
        ...(failed && !cancelled ? { error: oneLine(text || "The tool reported an error.", 400) } : {}),
        ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
      },
    });
    if (failed) return;

    const files = fileChangesOf(track, result, this.input.meta.cwd);
    if (files.length > 0) this.emit({ kind: "file.changed", data: { callId, files } });
  }

  private onAgentEnd(event: Json): void {
    const run = this.run;
    if (!run) return;
    const messages = arr(event["messages"]) ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = asRecord(messages[i]);
      if (message && str(message["role"]) === "assistant") {
        run.stop = { reason: str(message["stopReason"]), error: str(message["errorMessage"]) };
        break;
      }
    }
  }

  private onExtensionUi(event: Json): void {
    const method = str(event["method"]);
    const id = str(event["id"]);
    if (!method) return;
    if (id && (method === "select" || method === "confirm" || method === "input" || method === "editor")) {
      // Ensemble 没有办法替用户回答扩展的对话框；取消它，避免 Pi 一直阻塞。
      this.proc.send({ type: "extension_ui_response", id, cancelled: true });
      this.diagnostic(
        "warn",
        "pi.extension_dialog",
        `A Pi extension asked for input ("${oneLine(str(event["title"]) ?? method, 120)}"). Ensemble cannot answer extension dialogs, so it was cancelled.`,
      );
    } else if (method === "notify") {
      const type = str(event["notifyType"]);
      this.diagnostic(type === "error" ? "error" : type === "warning" ? "warn" : "info", "pi.extension_notify", oneLine(str(event["message"]) ?? "", 300));
    }
  }

  // ── 用量 ──

  /** Pi 的统计是整个会话的累计值；这里减去本次运行开始时的基线，得到本次运行的用量。 */
  private async pushUsage(): Promise<void> {
    const run = this.run;
    if (!run || this.closing) return;
    let response: Json;
    try {
      response = await this.rpc.request("get_session_stats", {}, 5_000);
    } catch {
      return;
    }
    const now = readTotals(response);
    if (!now) return;
    this.totals = now;
    this.emit({ kind: "usage.updated", data: { usage: usageSince(now, this.baseline, response) } }, run.id);
  }

  // ── 收束 ──

  private async finishRun(): Promise<void> {
    const run = this.run;
    if (!run || run.finishing) return;
    run.finishing = true;

    await this.pushUsage();
    if (this.run !== run || this.closing) return;

    // 纠偏的最终结局必须有交代：看到了回显就是已生效；从队列里消失但回显对不上，用较弱的证据说明；否则失败。
    for (const [messageId, track] of this.steers) {
      if (track.applied) continue;
      const record = track.consumed
        ? { stage: "applied" as const, at: isoNow(), evidence: "pi: the message left the steering queue (queue_update), but no matching user message echo was seen" }
        : {
            stage: "failed" as const,
            at: isoNow(),
            error: { code: "run_ended", message: "The run ended before Pi consumed this steering message." },
          };
      this.emit({ kind: "message.delivery", data: { messageId, record }, runId: run.id });
    }
    this.steers.clear();
    this.tools.clear();
    this.existedByCall.clear();

    // 先清掉活动运行再上报终态：管理器在收到终态时可能同步地开始下一次运行。
    this.run = undefined;
    const stop = run.stop;
    if (stop?.reason === "aborted" || (run.abortSent && wasAborted(stop?.reason, stop?.error))) {
      this.emit({ kind: "run.cancelled", data: {} }, run.id);
    } else if (stop?.reason === "error") {
      this.emit({ kind: "run.failed", data: { error: errorInfoFromText(stop.error ?? "Pi reported an error.") } }, run.id);
    } else {
      this.emit({ kind: "run.completed", data: { ...(stop?.reason ? { stopReason: stop.reason } : {}) } }, run.id);
    }
  }
}
