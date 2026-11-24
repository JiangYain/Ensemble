import { errorMessage, isoNow } from "@shared/format";
import type { QuestionId } from "@shared/questions";
import type { ErrorInfo, MessageId, RunId } from "@shared/types";
import { arr, asRecord, categorizeTool, num, oneLine, outputPreview, str, textOfContent, type Json } from "./common";
import type { OpenCodeClient, OpenCodeEvent } from "./opencode-api";
import { ZERO_TALLY, addTally, errorInfoOf, fileChangesOf, readTally, toUsage, toolInput, toolTitle, type CatalogModel, type Tally } from "./opencode-items";
import { OpenCodeQuestions, formTitle } from "./opencode-questions";
import { OpenCodeShells, SHELL_LIST_TIMEOUT_MS } from "./opencode-shells";
import { ProcessSession, SteerTrack } from "./process-session";
import type { OpenInput } from "./types";

/**
 * OpenCode 事件 → Ensemble 事件。映射依据是真实运行抓到的 SSE 序列（OpenCode 2.3.0，Windows）：
 * - 一次运行 = 一次 `session.execution.*`：started → 若干 step（每步 started → reasoning/text/tool → ended）→ succeeded / failed / interrupted；
 * - 工具：`input.started`（名字已知，入参还在流式输出）→ `called`（入参完整，开始执行）→ `success` / `failed`；
 *   shell 工具会另外产生 `shell.created`（带真实 pid）与 `shell.exited`；
 * - 纠偏（delivery=steer）进收件箱，在下一个 step 边界被 `session.inbox.delivered` 取走，这就是“已生效”的证据；
 * - 中断后工具以 `failed{metadata.interrupted}` 收尾，step 以 `failed{aborted}` 收尾，执行以 `interrupted{reason}` 收尾。
 * 同一个服务里还会出现别的会话（例如子 Agent 的会话）的事件，一律按 sessionID 过滤，不当作本会话的执行步骤。
 */

export interface RunState {
  id: RunId;
  messageId: MessageId;
  started: boolean;
  finishing: boolean;
  cancelRequested: boolean;
  /** Ensemble 自己拒绝了权限请求或取消了表单：OpenCode 会因此中止整次执行，运行的结局要如实说明原因。 */
  blocked: ErrorInfo | undefined;
  /** 本次运行各 step 的 token 合计（会话级累计值含标题生成等旁路调用，不能当作这次运行的用量）。 */
  tally: Tally;
  lastStep: Tally | undefined;
  finish: string | undefined;
  /** 最近一次非中断的 step 失败，用于执行失败时补充原因。 */
  failure: Json | undefined;
}

export class OpenCodeSteer extends SteerTrack {
  /** 提交纠偏时 OpenCode 返回的收件箱条目 id，用来对上 `inbox.delivered` / `inbox.cancelled`。 */
  inboxId: string | undefined;
}

interface ToolTrack {
  name: string;
  input: Json;
}

interface StepTrack {
  textItems: string[];
  hasToolCalls: boolean;
  reasoningStartedAt: Map<number, number>;
}

export type Outcome = { kind: "succeeded" } | { kind: "failed"; error: Json | undefined } | { kind: "interrupted"; reason: string | undefined };

/** 一次执行的结局 → Ensemble 的运行终态。 */
export function terminalOf(outcome: Outcome, run: Pick<RunState, "blocked" | "cancelRequested" | "finish" | "failure">):
  | { kind: "completed"; stopReason?: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: ErrorInfo } {
  if (outcome.kind === "succeeded") return { kind: "completed", ...(run.finish ? { stopReason: run.finish } : {}) };
  if (outcome.kind === "failed") return { kind: "failed", error: errorInfoOf(outcome.error ?? run.failure, "OpenCode reported an error.") };
  if (run.blocked) return { kind: "failed", error: run.blocked };
  if (run.cancelRequested || outcome.reason === "user") return { kind: "cancelled" };
  return {
    kind: "failed",
    error: { code: "opencode.interrupted", message: `OpenCode stopped the run without being asked to (reason: ${outcome.reason ?? "unknown"}).` },
  };
}

const itemId = (kind: "t" | "r", assistantMessageId: string | undefined, ordinal: number | undefined): string => `${assistantMessageId ?? "m"}:${kind}${ordinal ?? 0}`;

export abstract class OpenCodeEventSession extends ProcessSession<OpenCodeClient> {
  protected run: RunState | undefined;
  /** OpenCode 的会话 id（ses_…）。订阅事件在创建/恢复会话之前开始，所以这里先空着。 */
  protected sessionId = "";
  protected readonly steers = new Map<MessageId, OpenCodeSteer>();
  /** 本会话的 shell 工具进程：取消与关闭时要按 pid 结束整棵进程树（见 opencode-shells.ts）。 */
  protected readonly shells = new OpenCodeShells({
    sessionId: () => this.sessionId,
    list: () => this.rpc.request("GET", "/api/shell", undefined, SHELL_LIST_TIMEOUT_MS),
    debug: (message, detail) => this.input.log.debug(`opencode: ${message}`, detail),
  });
  /** 执行端的业务提问（`question` 工具，不是权限请求）：转给发起方，等回答。见 opencode-questions.ts。 */
  protected readonly questions = new OpenCodeQuestions({
    sessionId: () => this.sessionId,
    request: (method, path, body) => this.rpc.request(method, path, body, 10_000),
    emit: (draft, runId) => this.emit(draft, runId),
    diagnostic: (level, code, message) => this.diagnostic(level, code, message),
    activeRunId: () => this.run?.id,
    cancelRequested: () => this.run?.cancelRequested === true,
    debug: (message, detail) => this.input.log.debug(`opencode: ${message}`, detail),
  });
  /** 探测到的模型目录（只含 id、名称、档位与上下文窗口，不含任何设置）。 */
  protected readonly catalog = new Map<string, CatalogModel>();
  private readonly tools = new Map<string, ToolTrack>();
  private readonly steps = new Map<string, StepTrack>();
  private readonly deliveredInbox = new Set<string>();
  private contextWindow: number | undefined;
  private reportedModel: string | undefined;

  protected constructor(input: OpenInput) {
    super(input, "OpenCode");
  }

  protected activeRunId(): RunId | undefined {
    return this.run?.id;
  }

  // ── 分派 ──

  protected handle(event: OpenCodeEvent): void {
    const { type, data } = event;
    if (type === "shell.created") return this.shells.created(asRecord(data["info"]));
    if (type === "shell.exited") return this.shells.exited(str(data["id"]));
    if (type === "form.created") return this.onForm(asRecord(data["form"]));
    // 表单有了结局：只认我们正在等的那几个 id，所以不需要先按会话过滤。
    if (type === "form.replied" || type === "form.cancelled") return this.questions.settled(str(data["id"]));
    if (str(data["sessionID"]) !== this.sessionId) return;

    switch (type) {
      case "session.execution.started":
        return this.ensureStarted();
      case "session.execution.succeeded":
        return this.finishRun({ kind: "succeeded" });
      case "session.execution.failed":
        return this.finishRun({ kind: "failed", error: asRecord(data["error"]) });
      case "session.execution.interrupted":
        return this.finishRun({ kind: "interrupted", reason: str(data["reason"]) });
      case "session.inbox.delivered":
        return this.onInboxDelivered(str(data["inboxID"]));
      case "session.inbox.cancelled":
        return this.onInboxCancelled(str(data["inboxID"]));
      case "session.step.started":
        return this.onStepStarted(data);
      case "session.step.ended":
        return this.onStepEnded(data, false);
      case "session.step.failed":
        return this.onStepEnded(data, true);
      case "session.text.started":
        return void this.step(data)?.textItems.push(itemId("t", str(data["assistantMessageID"]), num(data["ordinal"])));
      case "session.text.delta":
        return this.onDelta("assistant.delta", itemId("t", str(data["assistantMessageID"]), num(data["ordinal"])), str(data["delta"]));
      case "session.text.ended":
        return this.onTextEnded(data);
      case "session.reasoning.started":
        return void this.step(data)?.reasoningStartedAt.set(num(data["ordinal"]) ?? 0, Date.now());
      case "session.reasoning.delta":
        return this.onDelta("reasoning.delta", itemId("r", str(data["assistantMessageID"]), num(data["ordinal"])), str(data["delta"]));
      case "session.reasoning.ended":
        return this.onReasoningEnded(data);
      case "session.tool.input.started":
        return this.onToolInputStarted(data);
      case "session.tool.called":
        return this.onToolCalled(data);
      case "session.tool.success":
        return this.onToolEnded(data, false);
      case "session.tool.failed":
        return this.onToolEnded(data, true);
      case "session.usage.recorded":
        return this.onUsageRecorded(data);
      case "session.retry.scheduled": {
        const error = asRecord(data["error"]);
        return this.diagnostic(
          "warn",
          "opencode.retry",
          `Provider error, OpenCode is retrying (attempt ${num(data["attempt"]) ?? "?"}): ${errorInfoOf(error, "unknown error").message}`,
        );
      }
      case "session.compaction.started":
        return this.diagnostic("info", "opencode.compaction", `OpenCode is compacting the context (${str(data["reason"]) ?? "unknown reason"}).`);
      case "session.compaction.failed":
        return this.diagnostic("warn", "opencode.compaction_failed", `Context compaction did not complete: ${errorInfoOf(asRecord(data["error"]), "unknown error").message}`);
      case "permission.asked":
        return this.onPermission(data);
      default:
        return;
    }
  }

  private step(data: Json): StepTrack | undefined {
    const id = str(data["assistantMessageID"]);
    if (!id) return undefined;
    let track = this.steps.get(id);
    if (!track) {
      track = { textItems: [], hasToolCalls: false, reasoningStartedAt: new Map() };
      this.steps.set(id, track);
    }
    return track;
  }

  private ensureStarted(): void {
    const run = this.run;
    if (!run || run.started) return;
    run.started = true;
    this.emit({ kind: "run.started", data: {} });
  }

  // ── step / 文本 / 推理 ──

  private onStepStarted(data: Json): void {
    if (!this.run) return;
    this.ensureStarted();
    const model = asRecord(data["model"]);
    const modelId = str(model?.["id"]);
    const providerId = str(model?.["providerID"]);
    if (!modelId || !providerId) return;
    const key = `${providerId}/${modelId}`;
    if (key === this.reportedModel) return;
    this.reportedModel = key;
    const known = this.catalog.get(key);
    this.contextWindow = known?.contextWindow;
    const variant = str(model?.["variant"]);
    this.emit({
      kind: "session.updated",
      data: {
        patch: {
          model: { resolved: key, label: known?.name ?? modelId, provider: providerId },
          // “default” 是没有选档位时的占位值，不是一个真实档位。
          ...(variant && variant !== "default" ? { effort: variant } : {}),
        },
      },
    });
  }

  private onStepEnded(data: Json, failed: boolean): void {
    const run = this.run;
    const step = this.step(data);
    const id = str(data["assistantMessageID"]);
    if (id) this.steps.delete(id);
    if (!run) return;
    const tally = readTally(data);
    if (tally) {
      run.tally = addTally(run.tally, tally);
      run.lastStep = tally;
      this.pushUsage(run);
    }
    if (failed) {
      const error = asRecord(data["error"]);
      if (str(error?.["type"]) !== "aborted") run.failure = error;
      return;
    }
    const finish = str(data["finish"]);
    run.finish = finish ?? run.finish;
    // 带工具调用的那一步里的文字只是过程说明；不带工具调用的最后一步才是最终回答。
    const phase = step?.hasToolCalls || finish === "tool-calls" || finish === "tool_calls" ? "commentary" : "final";
    for (const textItem of step?.textItems ?? []) this.emit({ kind: "assistant.completed", data: { itemId: textItem, phase } });
  }

  private onDelta(kind: "assistant.delta" | "reasoning.delta", id: string, text: string | undefined): void {
    if (!this.run || !text) return;
    this.emit({ kind, data: { itemId: id, text } });
  }

  private onTextEnded(data: Json): void {
    if (!this.run) return;
    const text = str(data["text"]);
    this.emit({ kind: "assistant.completed", data: { itemId: itemId("t", str(data["assistantMessageID"]), num(data["ordinal"])), ...(text !== undefined ? { text } : {}) } });
  }

  private onReasoningEnded(data: Json): void {
    if (!this.run) return;
    const ordinal = num(data["ordinal"]) ?? 0;
    const startedAt = this.step(data)?.reasoningStartedAt.get(ordinal);
    this.emit({
      kind: "reasoning.completed",
      data: { itemId: itemId("r", str(data["assistantMessageID"]), ordinal), ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}) },
    });
  }

  // ── 工具 ──

  private onToolInputStarted(data: Json): void {
    const callId = str(data["id"]);
    const name = str(data["name"]);
    if (!this.run || !callId || !name) return;
    this.tools.set(callId, { name, input: {} });
    const step = this.step(data);
    if (step) step.hasToolCalls = true;
    this.emit({ kind: "tool.updated", data: { callId, name, category: categorizeTool(name), title: name, status: "running", startedAt: isoNow() } });
  }

  private onToolCalled(data: Json): void {
    const callId = str(data["id"]);
    const track = callId ? this.tools.get(callId) : undefined;
    if (!this.run || !callId || !track) return;
    track.input = asRecord(data["input"]) ?? {};
    this.emit({
      kind: "tool.updated",
      data: { callId, title: toolTitle(track.name, track.input, this.input.meta.cwd), status: "running", input: toolInput(track.name, track.input) },
    });
  }

  private onToolEnded(data: Json, failed: boolean): void {
    const callId = str(data["id"]);
    const track = callId ? this.tools.get(callId) : undefined;
    if (!this.run || !callId || !track) return;
    this.tools.delete(callId);

    const metadata = asRecord(data["metadata"]);
    const error = asRecord(data["error"]);
    const text = textOfContent(data["content"]);
    const exit = num(metadata?.["exit"]);
    // 被中断或被拒绝的工具是“取消”，不是工具自己出错；它们的错误文本也不是有价值的报错（Windows 上还是乱码）。
    const aborted = failed && (metadata?.["interrupted"] === true || str(error?.["type"]) === "aborted");
    const commandFailed = !failed && exit !== undefined && exit !== 0;
    const status = aborted ? "cancelled" : failed || commandFailed ? "failed" : "completed";
    const message = failed ? oneLine(str(error?.["message"]) ?? "The tool reported an error.", 400) : commandFailed ? `The command exited with code ${exit}.` : undefined;

    this.emit({
      kind: "tool.updated",
      data: {
        callId,
        status,
        endedAt: isoNow(),
        ...(text && !aborted ? { output: outputPreview(text) } : {}),
        ...(message && !aborted ? { error: message } : {}),
        ...(exit !== undefined ? { exitCode: exit } : {}),
      },
    });
    if (status !== "completed") return;
    const files = fileChangesOf(track.name, track.input, text, metadata, this.input.meta.cwd);
    if (files.length > 0) this.emit({ kind: "file.changed", data: { callId, files } });
  }

  // ── 用量 ──

  private pushUsage(run: RunState): void {
    this.emit({ kind: "usage.updated", data: { usage: toUsage(run.tally, run.lastStep, this.contextWindow) } }, run.id);
  }

  /** 标题生成、上下文压缩等旁路调用的用量（未实测压缩；同一份 tokens 也出现在 compaction.ended 里，这里不重复计）。 */
  private onUsageRecorded(data: Json): void {
    const run = this.run;
    const tally = readTally(data);
    if (!run || !tally) return;
    run.tally = addTally(run.tally, tally);
    this.pushUsage(run);
  }

  // ── 纠偏 ──

  private onInboxDelivered(inboxId: string | undefined): void {
    if (!inboxId) return;
    this.deliveredInbox.add(inboxId);
    for (const [messageId, track] of this.steers) {
      if (!track.applied && track.inboxId === inboxId) return this.echoSteer(messageId, track);
    }
  }

  /** 收件箱条目被取走：消息已进入会话，这是“已生效”的证据。 */
  protected echoSteer(messageId: MessageId, track: OpenCodeSteer): void {
    const run = this.run;
    if (!run) return;
    track.echo("opencode: session.inbox.delivered — the steering message entered the conversation at a step boundary", (evidence) =>
      this.emitApplied(messageId, evidence, run.id),
    );
  }

  protected isDelivered(inboxId: string): boolean {
    return this.deliveredInbox.has(inboxId);
  }

  private onInboxCancelled(inboxId: string | undefined): void {
    for (const [messageId, track] of this.steers) {
      if (!track.applied && inboxId && track.inboxId === inboxId) this.cancelSteer(messageId, "opencode: session.inbox.cancelled — removed from the inbox before it was delivered");
    }
  }

  protected cancelSteer(messageId: MessageId, evidence: string): void {
    const run = this.run;
    if (!this.steers.delete(messageId) || !run) return;
    this.emit({ kind: "message.delivery", data: { messageId, record: { stage: "cancelled", at: isoNow(), evidence } }, runId: run.id });
  }

  protected async deleteInbox(inboxId: string): Promise<boolean> {
    try {
      await this.rpc.request("DELETE", `/api/session/${this.sessionId}/inbox/${inboxId}`, undefined, 10_000);
      return true;
    } catch (error) {
      this.input.log.debug("opencode: could not remove inbox entry", { inboxId, error: errorMessage(error) });
      return false;
    }
  }

  // ── 权限与表单 ──
  // 权限请求（被委派的会话不会遇到，但遇到了不能卡住）当场应答；业务提问是表单的一种，转给发起方；其余的表单仍然撤回。

  /**
   * 会话级规则已经放行（Full Access）或只放行读取（只读），正常情况下不会有人来问。
   * 万一还有（例如 OpenCode 的硬性策略要求确认）：Full Access 就放行，只读就拒绝，并留下诊断，绝不让运行停在那里等人。
   */
  private onPermission(data: Json): void {
    const requestId = str(data["id"]);
    if (!requestId) return;
    const resources = (arr(data["resources"]) ?? []).filter((value): value is string => typeof value === "string");
    const what = `${str(data["action"]) ?? "an action"}${resources.length > 0 ? ` on ${oneLine(resources.join(", "), 160)}` : ""}`;
    const full = this.input.meta.access === "full";
    if (full) {
      this.diagnostic("info", "opencode.permission_allowed", `OpenCode asked permission for ${what}; Ensemble allowed it (Full Access has no approval gate).`);
    } else {
      const message = `OpenCode asked permission for ${what}, which a read-only session must not do; Ensemble rejected it, so the run was stopped.`;
      if (this.run) this.run.blocked = { code: "opencode.permission_rejected", message };
      this.diagnostic("warn", "opencode.permission_rejected", message);
    }
    this.rpc
      .request("POST", `/api/session/${this.sessionId}/permission/${requestId}/reply`, { decision: full ? "once" : "reject" }, 10_000)
      .catch((error: unknown) => this.input.log.warn("opencode: permission reply failed", { error: errorMessage(error) }));
  }

  private onForm(form: Json | undefined): void {
    const formId = str(form?.["id"]);
    if (!form || !formId || str(form["sessionID"]) !== this.sessionId) return;
    // 业务提问：转给发起方回答（或带说明地撤回），运行继续；不是提问的表单仍按下面的老办法处理。
    if (this.questions.created(form)) return;
    // 标题是执行端写的，下面这句话既进诊断也进运行失败的原因（`run.blocked`，见 terminalOf）：与撤回提问时一样，引用之前先脱敏。
    const title = formTitle(form);
    const message = `OpenCode asked for input ("${title}"). Ensemble cannot answer questions during a delegation, so it was cancelled and the run stopped.`;
    if (this.run) this.run.blocked = { code: "opencode.question_unanswered", message };
    this.diagnostic("warn", "opencode.question_unanswered", message);
    this.rpc
      .request("DELETE", `/api/session/${this.sessionId}/form/${formId}`, undefined, 10_000)
      .catch((error: unknown) => this.input.log.warn("opencode: form cancel failed", { error: errorMessage(error) }));
  }

  // ── 提问的回复（见 opencode-questions.ts） ──

  answerQuestion(questionId: QuestionId, answers: readonly (readonly string[])[]): Promise<boolean> {
    return this.questions.answerQuestion(questionId, answers);
  }

  declineQuestion(questionId: QuestionId, note: string): Promise<boolean> {
    return this.questions.declineQuestion(questionId, note);
  }

  protected override dispose(): void {
    this.questions.clear();
  }

  // ── 收束 ──

  protected finishRun(outcome: Outcome): void {
    const run = this.run;
    if (!run || run.finishing) return;
    run.finishing = true;

    // 每条纠偏都要有交代：没被取走的，记为失败，并把它从收件箱里撤掉，免得漏进下一次运行。
    for (const [messageId, track] of this.steers) {
      if (track.applied) continue;
      this.emit({
        kind: "message.delivery",
        data: {
          messageId,
          record: { stage: "failed", at: isoNow(), error: { code: "run_ended", message: "The run ended before OpenCode delivered this steering message." } },
        },
        runId: run.id,
      });
      if (track.inboxId) void this.deleteInbox(track.inboxId);
    }
    this.steers.clear();
    this.tools.clear();
    this.steps.clear();
    this.deliveredInbox.clear();
    // 运行结束时仍在等的提问不会再有回答了：先记过期，再上报终态。
    this.questions.runEnded(run.id, run.cancelRequested);

    // 先清掉活动运行再上报终态：管理器在收到终态时可能同步地开始下一次运行。
    this.run = undefined;
    const end = terminalOf(outcome, run);
    if (end.kind === "completed") this.emit({ kind: "run.completed", data: end.stopReason ? { stopReason: end.stopReason } : {} }, run.id);
    else if (end.kind === "cancelled") this.emit({ kind: "run.cancelled", data: {} }, run.id);
    else this.emit({ kind: "run.failed", data: { error: end.error } }, run.id);
  }
}

export function newRun(id: RunId, messageId: MessageId): RunState {
  return { id, messageId, started: false, finishing: false, cancelRequested: false, blocked: undefined, tally: ZERO_TALLY, lastStep: undefined, finish: undefined, failure: undefined };
}