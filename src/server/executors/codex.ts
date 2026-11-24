import { tmpdir } from "node:os";
import { ENV } from "@shared/constants";
import { clip, errorMessage, isoNow, tail } from "@shared/format";
import type { QuestionId } from "@shared/questions";
import type { ErrorInfo, HarnessInfo, MessageId, ModelInfo, RunId } from "@shared/types";
import {
  appServerArgs,
  CodexRpc,
  CodexRpcError,
  resolveCodexLaunch,
  versionArgs,
  type CodexLaunch,
  type RpcId,
} from "./codex-rpc";
import { pickDefaultModel, sandboxFor, toTurnErrorInfo, type TokenBase } from "./codex-items";
import { HarnessStartError, asRecord, classifyError, oneLine, str, type Json } from "./common";
import { CodexItemFlow, type AgentText } from "./codex-item-flow";
import { CodexQuestions } from "./codex-questions";
import { answerServerRequest, noticeOf } from "./codex-side-channel";
import { accountLabel, CODEX_CAPABILITIES, codexAccess, initialize, listModels, PROBE_TIMEOUT_MS, START_TIMEOUT_MS } from "./codex-setup";
import { runCapture, spawnJsonl } from "./process";
import { ProcessSession, SteerTrack } from "./process-session";
import type { Executor, ExecutorSession, OpenInput, StartRunInput, SteerInput, SteerOutcome } from "./types";

/**
 * Codex 适配器：通过 `codex app-server`（stdio 上的精简 JSON-RPC）驱动一个完整的 Codex 线程。
 *
 * 以下行为都是在 Codex 0.151.0 / Windows 11 上用真实调用验证过的（2026-11-07）：
 * - turn/start 立即返回 turn id；turn/started → item/started(userMessage, 回显 clientId) → … → turn/completed；
 * - turn/steer 立即被接受，但纠偏消息要等当前工具调用结束、下一次模型请求时才进入线程（item/started userMessage，
 *   clientId 原样回显），所以“已生效”的证据是这条回显，而不是 turn/steer 的响应；
 * - turn/interrupt 约 10ms 内生效，turn/completed.status = interrupted；被中断的命令不会再收到 item/completed；
 * - 授权：被委派的会话一律以 approvalPolicy=never 启动（Full Access 或只读），Codex 不会再发出授权请求，
 *   也就不存在“等待授权”。历史验证（on-request 下）：沙箱挡住的写入会触发 item/commandExecution/requestApproval，
 *   回复 accept 后命令在沙箱外执行，回复 decline 后命令状态为 declined，回合继续——现在只用于兜底（见 codex-side-channel.ts 的 answerApproval）；
 * - 沙箱：read-only 由 Codex（Windows 沙箱）强制，工作区与临时目录之外的写入被拒绝；Full Access 使用 danger-full-access；
 * - 推理摘要只有在 turn/start 带 summary 时才会下发；
 * - 用户配置里的默认模型可能不在可用目录里（会 model_not_found），所以必须显式给出可用模型。
 *
 * 文件分工：本文件是执行端（探测、打开会话）与会话本身（启动、运行控制、回合生命周期、通知分发）；
 * 能力声明、访问级别的说明、超时常量，以及握手、模型目录、账号的查询在 codex-setup.ts；
 * 条目、计划与用量的转换（助手文字、推理摘要、工具，连同它们各自的状态表）在 codex-item-flow.ts；
 * 业务提问在 codex-questions.ts，授权与其他旁路请求在 codex-side-channel.ts，条目的纯映射在 codex-items.ts。
 */

// ───────────────────────── 执行端 ─────────────────────────

export interface CodexExecutorOptions {
  /** 直接指定 Codex 可执行文件或 JS 入口（测试时指向假 Codex）。 */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
}

export class CodexExecutor implements Executor {
  readonly id = "codex" as const;
  readonly runtime = "native" as const;
  readonly canResume = true;

  /** 最近一次探测得出的默认模型，open() 优先使用，避免每次委派都再等一次（可能很慢的）模型目录查询。 */
  private knownDefault: string | undefined;

  constructor(private readonly options: CodexExecutorOptions = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private get clientVersion(): string {
    return this.options.clientVersion ?? "0.1.0";
  }

  async probe(): Promise<HarnessInfo> {
    const base = {
      id: "codex" as const,
      displayName: "Codex",
      runtime: "native" as const,
      capabilities: CODEX_CAPABILITIES,
      models: [] as ModelInfo[],
    };
    const launch = resolveCodexLaunch({ bin: this.options.bin, env: this.env });
    if (!launch) {
      return {
        ...base,
        access: codexAccess({ enforced: false, note: "Codex is not installed" }),
        status: "unavailable",
        setup: { code: "codex_not_found", message: "The Codex CLI was not found on PATH.", command: "npm install -g @openai/codex" },
        checkedAt: isoNow(),
      };
    }

    const versionResult = await runCapture(launch.command, versionArgs(launch), { timeoutMs: 10_000, env: this.env });
    const version = `${versionResult.stdout}\n${versionResult.stderr}`.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];

    const proc = spawnJsonl(launch.command, appServerArgs(launch), { cwd: tmpdir(), env: this.env });
    const rpc: CodexRpc = new CodexRpc(proc, {
      onNotification: () => undefined,
      onServerRequest: (id, method) => rpc.respondError(id, -32601, `Ensemble probe does not handle "${method}".`),
    });
    try {
      const init = await initialize(rpc, this.clientVersion);
      const [account, models, config, readiness] = await Promise.allSettled([
        rpc.request("account/read", { refreshToken: false }, PROBE_TIMEOUT_MS),
        listModels(rpc, PROBE_TIMEOUT_MS),
        rpc.request("config/read", { cwd: tmpdir() }, PROBE_TIMEOUT_MS),
        init.platformOs === "windows" ? rpc.request("windowsSandbox/readiness", {}, 15_000) : Promise.resolve(undefined),
      ]);

      if (account.status === "rejected") throw account.reason;
      const accountResult = asRecord(account.value);
      const accountInfo = asRecord(accountResult?.["account"]);

      const entries = models.status === "fulfilled" ? models.value : [];
      const configModel = config.status === "fulfilled" ? str(asRecord(asRecord(config.value)?.["config"])?.["model"]) : undefined;
      const { model: defaultModel } = pickDefaultModel(entries, configModel);
      this.knownDefault = defaultModel;
      // isDefault 以 Ensemble 实际会使用的默认模型为准（可能不同于目录里标记的默认）。
      const modelInfos = entries.map((entry): ModelInfo => {
        const { isDefault: _isDefault, ...rest } = entry.info;
        return entry.model === defaultModel ? { ...rest, isDefault: true } : rest;
      });

      const readinessStatus = readiness.status === "fulfilled" ? str(asRecord(readiness.value)?.["status"]) : undefined;
      const windows = init.platformOs === "windows";
      const enforced = !windows || readinessStatus === "ready";
      const access = codexAccess({ enforced, note: `Windows sandbox: ${readinessStatus ?? "unknown"}` });

      const label = accountLabel(accountInfo);
      const info: HarnessInfo = {
        ...base,
        access,
        status: "ready",
        models: modelInfos,
        ...(defaultModel ? { defaultModel } : {}),
        ...(version ? { version } : {}),
        ...(label ? { account: label } : {}),
        checkedAt: isoNow(),
      };
      if (!accountInfo && accountResult?.["requiresOpenaiAuth"] === true) {
        info.status = "needs_setup";
        info.setup = { code: "codex_login_required", message: "Codex is not signed in. Run `codex login`.", command: "codex login" };
      } else if (modelInfos.length === 0) {
        info.status = "needs_setup";
        info.setup = {
          code: "codex_no_models",
          message: "Codex returned no available models. Check your Codex sign-in and network, then try again.",
          command: "codex login status",
        };
      }
      return info;
    } catch (error) {
      const reason = proc.stderrTail().split(/\r?\n/).find((line) => line.trim().length > 0);
      return {
        ...base,
        access: codexAccess({ enforced: false, note: "Codex could not be probed" }),
        status: "unavailable",
        ...(version ? { version } : {}),
        setup: {
          code: "codex_probe_failed",
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
    const launch = resolveCodexLaunch({ bin: this.options.bin, env: this.env });
    if (!launch) throw new HarnessStartError("harness_unavailable", "The Codex CLI was not found on PATH.");
    const session = new CodexSession(launch, input, this.env, this.clientVersion, this.knownDefault);
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
  turnId: string | undefined;
  turnWaiters: ((turnId: string | undefined) => void)[];
  started: boolean;
  finishing: boolean;
  cancelRequested: boolean;
  usageBase: TokenBase | undefined;
  lastError: ErrorInfo | undefined;
  agentTexts: AgentText[];
}

class CodexSession extends ProcessSession<CodexRpc> {
  private threadId = "";
  private model: string | undefined;

  private run: RunState | undefined;
  private readonly steers = new Map<MessageId, SteerTrack>();
  private readonly reportedMcpFailures = new Set<string>();
  /** 回合里的条目、计划与用量（助手文字、推理摘要、工具），连同它们的三张状态表。见 codex-item-flow.ts。 */
  private readonly items = new CodexItemFlow({
    emit: (draft, runId) => this.emit(draft, runId),
    isCurrentTurn: (params) => this.isCurrentTurn(params),
    run: () => this.run,
    cwd: () => this.input.meta.cwd,
    userMessage: (item) => this.onUserMessage(item),
    contextCompacted: (params) => this.onSideNotice("thread/compacted", params),
  });
  /** 执行端的业务提问（不是授权）：转给发起方，等回答。见 codex-questions.ts。 */
  private readonly questions = new CodexQuestions({
    rpc: () => this.rpc,
    emit: (draft, runId) => this.emit(draft, runId),
    diagnostic: (level, code, message) => this.diagnostic(level, code, message),
    activeRunId: () => this.run?.id,
    cancelRequested: () => this.run?.cancelRequested === true,
  });

  constructor(
    private readonly launch: CodexLaunch,
    input: OpenInput,
    private readonly env: NodeJS.ProcessEnv,
    private readonly clientVersion: string,
    private readonly knownDefault: string | undefined,
  ) {
    super(input, "Codex");
  }

  protected activeRunId(): RunId | undefined {
    return this.run?.id;
  }

  // ── 启动 ──

  async start(): Promise<void> {
    const { meta, log, signal, resume } = this.input;
    this.proc = spawnJsonl(this.launch.command, appServerArgs(this.launch), {
      cwd: meta.cwd,
      env: { ...this.env, [ENV.parentSession]: meta.id, [ENV.parentDepth]: String(meta.depth) },
      onNonJson: (line) => log.debug("codex: non-JSON stdout line", { line: clip(line, 200) }),
    });
    this.rpc = new CodexRpc(this.proc, {
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
    });
    this.proc.onExit((info) => this.onExit(info));
    signal.addEventListener("abort", () => void this.close(), { once: true });

    try {
      await initialize(this.rpc, this.clientVersion);
      const choice = sandboxFor(meta.access);
      const model = await this.resolveModel();
      const threadParams = { cwd: meta.cwd, approvalPolicy: choice.approvalPolicy, sandbox: choice.sandbox, ...(model ? { model } : {}) };

      const response = asRecord(
        resume
          ? await this.rpc.request("thread/resume", { ...threadParams, threadId: resume.id, excludeTurns: true }, START_TIMEOUT_MS)
          : await this.rpc.request("thread/start", { ...threadParams, ephemeral: false, serviceName: "ensemble" }, START_TIMEOUT_MS),
      );
      const thread = asRecord(response?.["thread"]);
      const threadId = str(thread?.["id"]);
      if (!threadId) throw new Error("Codex did not return a thread id.");
      this.threadId = threadId;
      const path = str(thread?.["path"]);
      this.nativeRef = { kind: "codex-thread", id: threadId, ...(path ? { path } : {}) };
      this.model = str(response?.["model"]) ?? model;

      const provider = str(response?.["modelProvider"]);
      const effort = meta.effort ?? str(response?.["reasoningEffort"]);
      const actual = str(asRecord(response?.["sandbox"])?.["type"]);
      const mismatch = actual !== undefined && actual !== choice.expectType;
      this.emit({
        kind: "session.updated",
        data: {
          patch: {
            ...(this.model ? { model: { resolved: this.model, label: this.model, ...(provider ? { provider } : {}) } } : {}),
            ...(effort ? { effort } : {}),
            // 请求的沙箱和 Codex 实际采用的不一致时，如实改写“访问限制”的说明，而不是继续声称已强制。
            ...(mismatch
              ? { accessEnforcement: { level: "none" as const, mechanism: `Codex applied sandbox "${actual}" instead of the requested "${choice.expectType}"` } }
              : {}),
          },
        },
      });
      if (mismatch) {
        this.diagnostic("warn", "codex.sandbox_mismatch", `Codex reported sandbox "${actual}" but "${choice.expectType}" was requested. The access limit is not enforced as requested.`);
      }

      if (!resume) {
        // 让用户在 Codex 自己的会话列表里也能认出这是 Ensemble 派发的线程；失败不影响委派。
        this.rpc
          .request("thread/name/set", { threadId, name: `Ensemble · ${clip(meta.title, 70)}` }, 10_000)
          .catch((error: unknown) => log.debug("codex: thread/name/set failed", { error: errorMessage(error) }));
      }
    } catch (error) {
      throw this.startError(error);
    }
  }

  /** 明确指定的模型原样使用；否则用探测得出的默认模型；探测缓存缺失时现场查询。 */
  private async resolveModel(): Promise<string | undefined> {
    const { meta, resume } = this.input;
    const requested = meta.model?.requested ?? (resume ? meta.model?.resolved : undefined);
    if (requested) return requested;
    if (this.knownDefault) return this.knownDefault;

    const [models, config] = await Promise.allSettled([
      listModels(this.rpc, 20_000),
      this.rpc.request("config/read", { cwd: meta.cwd }, 20_000),
    ]);
    const entries = models.status === "fulfilled" ? models.value : [];
    const configModel = config.status === "fulfilled" ? str(asRecord(asRecord(config.value)?.["config"])?.["model"]) : undefined;
    const picked = pickDefaultModel(entries, configModel);
    if (picked.fellBackFrom) {
      this.diagnostic("info", "codex.default_model_unavailable", `The default model in your Codex config ("${picked.fellBackFrom}") is not available; using "${picked.model}".`);
    }
    return picked.model;
  }

  private startError(error: unknown): HarnessStartError {
    if (error instanceof HarnessStartError) return error;
    const stderr = this.proc.stderrTail().trim();
    const message = errorMessage(error);
    const classified = classifyError(message);
    const resumeFailed = this.input.resume !== undefined && error instanceof CodexRpcError;
    const code = resumeFailed ? "resume_failed" : classified.code === "model_not_found" || classified.code === "auth_failed" ? classified.code : "start_failed";
    return new HarnessStartError(code, `Codex could not start: ${clip(message, 300)}`, stderr ? tail(stderr, 1_500) : undefined);
  }

  // ── ExecutorSession ──

  async startRun(input: StartRunInput): Promise<void> {
    if (this.closing) throw new Error("The Codex session is closed.");
    if (this.run) throw new Error("A run is already active in this Codex session.");
    const run: RunState = {
      id: input.runId,
      messageId: input.messageId,
      turnId: undefined,
      turnWaiters: [],
      started: false,
      finishing: false,
      cancelRequested: false,
      usageBase: undefined,
      lastError: undefined,
      agentTexts: [],
    };
    this.run = run;
    try {
      const effort = this.input.meta.effort;
      const result = asRecord(
        await this.rpc.request(
          "turn/start",
          {
            threadId: this.threadId,
            clientUserMessageId: input.messageId,
            input: [{ type: "text", text: input.prompt, text_elements: [] }],
            ...(this.model ? { model: this.model } : {}),
            ...(effort ? { effort } : {}),
            // 没有这个参数 Codex 不会下发推理摘要（用户配置里常常是 none）。
            summary: "auto",
          },
          START_TIMEOUT_MS,
        ),
      );
      const turnId = str(asRecord(result?.["turn"])?.["id"]);
      if (turnId && this.run === run) this.adoptTurn(run, turnId);
    } catch (error) {
      if (this.run === run) this.run = undefined;
      throw error;
    }
  }

  async steer(input: SteerInput): Promise<SteerOutcome> {
    const run = this.run;
    if (!run || run.id !== input.runId || run.finishing || !run.turnId) {
      return { kind: "needs_follow_up", reason: "run_in_progress", evidence: "codex: no active turn to steer" };
    }
    const track = new SteerTrack();
    this.steers.set(input.messageId, track);
    try {
      await this.rpc.request(
        "turn/steer",
        {
          threadId: this.threadId,
          expectedTurnId: run.turnId,
          clientUserMessageId: input.messageId,
          input: [{ type: "text", text: input.text, text_elements: [] }],
        },
        15_000,
      );
    } catch (error) {
      this.steers.delete(input.messageId);
      // -32600 是前置条件不满足（回合已结束、回合编号不符、当前回合不可纠偏），此时应当作为新的运行继续交代。
      if (error instanceof CodexRpcError && error.code === -32600) {
        return { kind: "needs_follow_up", reason: "run_in_progress", evidence: `codex rejected turn/steer: ${error.message}` };
      }
      throw error;
    }
    track.accept((evidence) => this.emitApplied(input.messageId, evidence, run.id));
    return {
      kind: "queued_by_harness",
      reason: "turn_boundary",
      evidence: "codex: turn/steer accepted; the message enters the thread at the next model request, after the current tool call",
    };
  }

  async cancel(runId: RunId): Promise<void> {
    const run = this.run;
    if (!run || run.id !== runId || run.finishing) return;
    run.cancelRequested = true;
    // 取消可能发生在 turn/start 的响应之前，此时还不知道回合编号。
    const turnId = await this.awaitTurnId(run, 10_000);
    if (!turnId || this.run !== run || run.finishing) return;
    try {
      await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId }, 15_000);
    } catch (error) {
      // 回合恰好已经结束：目的已经达到。
      if (error instanceof CodexRpcError && error.code === -32600) return;
      throw error;
    }
  }

  answerQuestion(questionId: QuestionId, answers: readonly (readonly string[])[]): Promise<boolean> {
    return this.questions.answerQuestion(questionId, answers);
  }

  declineQuestion(questionId: QuestionId, note: string): Promise<boolean> {
    return this.questions.declineQuestion(questionId, note);
  }

  protected override dispose(): void {
    this.items.clearTimers();
    this.questions.clear();
  }

  // ── 回合编号 ──

  private adoptTurn(run: RunState, turnId: string): void {
    if (run.turnId) return;
    run.turnId = turnId;
    for (const waiter of run.turnWaiters.splice(0)) waiter(turnId);
  }

  private awaitTurnId(run: RunState, timeoutMs: number): Promise<string | undefined> {
    if (run.turnId) return Promise.resolve(run.turnId);
    return new Promise((resolve) => {
      const waiter = (turnId: string | undefined): void => {
        clearTimeout(timer);
        resolve(turnId);
      };
      const timer = setTimeout(() => {
        const index = run.turnWaiters.indexOf(waiter);
        if (index >= 0) run.turnWaiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      run.turnWaiters.push(waiter);
    });
  }

  // ── 通知分发 ──

  private onNotification(method: string, params: Json): void {
    // 线程级别的通知带 threadId；Codex 自己派生的子线程（collabAgent）发来的不属于这个会话。
    const threadId = str(params["threadId"]);
    if (threadId && this.threadId && threadId !== this.threadId) return;

    switch (method) {
      case "turn/started":
        return this.onTurnStarted(params);
      case "turn/completed":
        return this.onTurnCompleted(params);
      case "item/started":
        return this.items.onItemStarted(params);
      case "item/completed":
        return this.items.onItemCompleted(params);
      case "item/agentMessage/delta":
        return this.items.onAgentDelta(params);
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return this.items.onReasoningDelta(params);
      case "item/commandExecution/outputDelta":
        return this.items.onOutputDelta(params);
      case "item/mcpToolCall/progress":
        return this.items.onToolProgress(params);
      case "turn/plan/updated":
        return this.items.onPlan(params);
      case "thread/tokenUsage/updated":
        return this.items.onTokenUsage(params);
      case "error":
        return this.onError(params);
      case "serverRequest/resolved":
        // Codex 结清了它发给我们的某个请求（对提问来说：回合被中断，或在别处被回答了）。
        return this.questions.resolved(params);
      default:
        return this.onSideNotice(method, params);
    }
  }

  /** 只需要变成诊断的通知（警告、弃用、压缩、模型改道……）。 */
  private onSideNotice(method: string, params: Json): void {
    if (method === "model/rerouted") {
      const to = str(params["toModel"]);
      if (to) {
        this.model = to;
        this.emit({ kind: "session.updated", data: { patch: { model: { resolved: to, label: to } } } });
      }
    }
    const notice = noticeOf(method, params, this.reportedMcpFailures);
    if (notice) this.diagnostic(notice.level, notice.code, notice.message);
  }

  // ── 回合 ──

  /** 通知里的 turnId 与当前运行不符时，说明是别的回合的残余事件，忽略。 */
  private isCurrentTurn(params: Json): boolean {
    const run = this.run;
    if (!run) return false;
    const turnId = str(params["turnId"]);
    return !turnId || !run.turnId || run.turnId === turnId;
  }

  private onTurnStarted(params: Json): void {
    const turnId = str(asRecord(params["turn"])?.["id"]);
    const run = this.run;
    if (!turnId) return;
    if (!run) {
      this.diagnostic("warn", "codex.unrequested_turn", "Codex started a turn Ensemble did not request (for example from queued input). Its events are not tracked.");
      return;
    }
    if (run.turnId && run.turnId !== turnId) return;
    this.adoptTurn(run, turnId);
    if (!run.started) {
      run.started = true;
      this.emit({ kind: "run.started", data: { nativeTurnId: turnId } });
    }
  }

  private onTurnCompleted(params: Json): void {
    const run = this.run;
    const turn = asRecord(params["turn"]);
    if (!run || !turn) return;
    const turnId = str(turn["id"]);
    if (run.turnId && turnId && run.turnId !== turnId) return;
    this.finishRun(run, turn);
  }

  private finishRun(run: RunState, turn: Json): void {
    if (run.finishing) return;
    run.finishing = true;
    const status = str(turn["status"]);
    for (const waiter of run.turnWaiters.splice(0)) waiter(undefined);

    // 助手文字块的阶段：Codex 对部分模型不给 phase，此时最后一块视为最终回答，其余为过程说明。
    if (status === "completed") {
      const unknown = run.agentTexts.filter((text) => text.phase === undefined);
      unknown.forEach((text, index) => {
        this.emit({ kind: "assistant.completed", data: { itemId: text.itemId, phase: index === unknown.length - 1 ? "final" : "commentary" } }, run.id);
      });
    }

    // 被我们中断的运行里没来得及结束的工具：Codex 不再为它们上报结束事件，这里明确记为“已取消”。
    const interrupted = status === "interrupted" && run.cancelRequested;
    this.items.runEnded(run.id, interrupted);
    // 回合结束时仍在等的提问不会再有回答了（Codex 不再等）：先记过期，再上报终态。
    this.questions.runEnded(run.id, status === "interrupted" && run.cancelRequested);

    // 纠偏的最终结局必须有交代。
    for (const [messageId, track] of this.steers) {
      if (track.applied) continue;
      const record = run.cancelRequested
        ? { stage: "cancelled" as const, at: isoNow(), evidence: "codex: the run was cancelled before this message entered the thread" }
        : {
            stage: "failed" as const,
            at: isoNow(),
            error: { code: "run_ended", message: "The run ended before Codex applied this steering message." },
          };
      this.emit({ kind: "message.delivery", data: { messageId, record }, runId: run.id });
    }
    this.steers.clear();

    // 先清掉活动运行再上报终态：管理器在收到终态时可能同步地开始下一次运行。
    this.run = undefined;
    if (status === "interrupted") {
      this.emit(
        { kind: "run.cancelled", data: run.cancelRequested ? {} : { note: "Codex reported the turn as interrupted." } },
        run.id,
      );
    } else if (status === "failed") {
      // turn.error 带 codexErrorInfo 与详情，比单独的 error 通知更完整；没有时才用通知里记下的那条。
      const error = asRecord(turn["error"]);
      this.emit({ kind: "run.failed", data: { error: error ? toTurnErrorInfo(error) : (run.lastError ?? toTurnErrorInfo(undefined)) } }, run.id);
    } else {
      this.emit({ kind: "run.completed", data: { stopReason: "completed" } }, run.id);
    }
  }

  private onError(params: Json): void {
    if (!this.isCurrentTurn(params)) return;
    const info = toTurnErrorInfo(asRecord(params["error"]));
    if (params["willRetry"] === true) {
      this.diagnostic("warn", "codex.retrying", `Codex hit an error and is retrying: ${oneLine(info.message, 240)}`);
    } else if (this.run) {
      this.run.lastError = info;
    }
  }

  // ── 条目 ──
  // 条目与计划、用量的转换在 codex-item-flow.ts；用户消息的回显要对照这里的纠偏记录（`steers`），所以留在会话里。

  /** 用户消息被写进线程：如果它就是某条待生效的纠偏（clientId 对得上），这就是“已生效”的证据。 */
  private onUserMessage(item: Json): void {
    const run = this.run;
    const clientId = str(item["clientId"]);
    if (!run || !clientId) return;
    const track = this.steers.get(clientId);
    if (!track || track.applied) return;
    track.echo("codex: item/started userMessage — the steering message entered the thread (clientId matches)", (evidence) =>
      this.emitApplied(clientId, evidence, run.id),
    );
  }

  // ── 服务端请求 ──

  private onServerRequest(id: RpcId, method: string, params: Json): void {
    answerServerRequest(
      {
        rpc: this.rpc,
        access: this.input.meta.access,
        diagnostic: (level, code, message) => this.diagnostic(level, code, message),
        titleOf: (itemId) => this.items.titleOf(itemId),
        questions: this.questions,
      },
      id,
      method,
      params,
    );
  }
}
