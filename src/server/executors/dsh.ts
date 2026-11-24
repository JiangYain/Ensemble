import { clip, errorMessage, isoNow, tail } from "@shared/format";
import type { ErrorInfo, HarnessInfo, MessageId, RunId } from "@shared/types";
import { HarnessStartError, asRecord, classifyError, num, str, type Json } from "./common";
import {
  endTool,
  findModel,
  parseCatalog,
  permissionDecision,
  progressTool,
  startTool,
  turnErrorInfo,
  usageOf,
  type DshCatalog,
  type ToolTrack,
} from "./dsh-events";
import { DSH_INSTALL_COMMAND, acpArgs, nodeSatisfies, readEnginesNode, resolveDshLaunch, sessionEnv, type DshLaunch } from "./dsh-launch";
import { probeDsh } from "./dsh-probe";
import { DshRpc, DshRpcError, NO_TIMEOUT_MS, type RpcId } from "./dsh-rpc";
import { killTree, spawnJsonl } from "./process";
import { ProcessSession } from "./process-session";
import { defaultProcessTools, snapshotTree, sweepOrphans, type ProcessTools, type TreeSnapshot } from "./process-tree";
import type { Executor, ExecutorSession, OpenInput, StartRunInput, SteerInput, SteerOutcome } from "./types";

/**
 * DSH（DeepSeek Harness）适配器：通过 `dsh --profile acp`（官方的 ACP v1 服务，stdio 上的 JSON-RPC 2.0）驱动一个完整的 dsh 会话。
 *
 * 以下行为都是在 dsh 0.2.2-rc.1 / Windows 11 / Node 22.22.2 上用真实 dsh 进程验证的（2026-11-16）。
 * 模型端用的是脚本化的假端点（本机没有 DeepSeek 凭据），所以“真实 DeepSeek 模型的运行”没有验证过：
 * - 更新都是整块提交的（没有逐字流）：session/prompt 的响应就是这一轮的结束，期间只有 session/update 通知；
 * - 同一会话同一时刻只能有一个 prompt：运行中再发一次会被拒绝（-32602），文字不会被注入，所以 steer 只能是“稍后继续交代”；
 * - session/cancel（通知）能让 prompt 在几十毫秒内以 cancelled 结束，会话照常可用；
 *   但 dsh 只结束工具的那层 shell，工具启动的子进程会变成孤儿，所以取消前后要清理（见 process-tree.ts）；
 *   孤儿只在 Windows 上观察到、清理也只在 Windows 上验证过；Linux 与 macOS 上同样会清理（有孤儿才动手），
 *   已实现但没有在真实系统上验证，也没有观察过 dsh 在那里是否留下孤儿；
 * - 权限由环境变量 DSH_PERMISSION_MODE 决定：danger-full-access 下不会出现任何授权请求；
 *   read-only 下写入被拒绝，模型申请提权时才会出现 session/request_permission；
 * - session/resume 能在新进程里恢复历史、模型与推理档位；回合结束后即使进程被强杀，已完成的轮次也已落盘；
 * - 上游 429 / 5xx 会在 dsh 内部重试约 15 秒，之后才以 `turn failed: <状态码>: <正文>` 失败；
 * - 没有配置 DeepSeek 凭据时，第一轮就会以 auth_failed 失败（dsh 的原文已说明怎么补），Ensemble 不读取、不保存任何凭据。
 */

const START_TIMEOUT_MS = 90_000;
const NEW_TIMEOUT_MS = 60_000;
const OPTION_TIMEOUT_MS = 20_000;
/**
 * 取消前拍进程树快照的时间预算：超了就不等，直接取消并留一条说明。
 * Windows 上实测读进程表（PowerShell CIM）通常 1.5–2 秒，机器繁忙时到过 7 秒（Linux 读 /proc、macOS 跑 ps 的耗时没有测过）；比它自己的 8 秒超时再多留一点，
 * 让超时由读取方决定，这里只防传入的工具挂住。管理器的取消是后台进行的（界面已经记下“取消请求”），晚一两秒停下比留下孤儿好。
 */
const SNAPSHOT_BUDGET_MS = 9_000;
/** 关闭会话时最多等多久让取消后的孤儿清理做完。 */
const SWEEP_WAIT_MS = 10_000;

export interface DshExecutorOptions {
  /** 直接指定 dsh 可执行文件或 JS 入口（测试时指向假 dsh）。 */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  /** 取消后清理孤儿进程用的进程表工具：不给时按当前平台用真实的（Windows、Linux、macOS），别的平台不清理；null 表示明确不清理。 */
  processTools?: ProcessTools | null;
}

export class DshExecutor implements Executor {
  readonly id = "dsh" as const;
  readonly runtime = "native" as const;
  readonly canResume = true;

  constructor(private readonly options: DshExecutorOptions = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private get clientVersion(): string {
    return this.options.clientVersion ?? "0.1.0";
  }

  probe(): Promise<HarnessInfo> {
    return probeDsh({ bin: this.options.bin, env: this.env, clientVersion: this.clientVersion });
  }

  async open(input: OpenInput): Promise<ExecutorSession> {
    const launch = resolveDshLaunch({ bin: this.options.bin, env: this.env });
    if (!launch) throw new HarnessStartError("harness_unavailable", `The DSH CLI \`dsh\` was not found. Install it with \`${DSH_INSTALL_COMMAND}\`.`);
    const tools = this.options.processTools === undefined ? defaultProcessTools() : (this.options.processTools ?? undefined);
    const session = new DshSession(launch, input, this.env, this.clientVersion, tools);
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

interface TextBlock {
  itemId: string;
  text: string;
}

interface RunState {
  id: RunId;
  messageId: MessageId;
  started: boolean;
  finished: boolean;
  cancelRequested: boolean;
  /** 正在累积的助手文字 / 推理块；换了块或遇到工具、结束时收尾。 */
  text: TextBlock | undefined;
  thought: TextBlock | undefined;
  /** 本次运行里出现过的助手文字块（按先后），成功结束时据此补“过程说明 / 最终回答”。 */
  answers: string[];
  /** 进行中的工具调用。 */
  tools: Map<string, ToolTrack>;
  /** 取消前拍的进程树快照；运行结束后据此清理孤儿。 */
  snapshot: TreeSnapshot | undefined;
}

type Outcome = { kind: "completed"; stopReason: string } | { kind: "cancelled" } | { kind: "failed"; error: ErrorInfo };

class DshSession extends ProcessSession<DshRpc> {
  private sessionId = "";
  private run: RunState | undefined;
  private readonly sweeps = new Set<Promise<void>>();
  private closeTask: Promise<void> | undefined;

  constructor(
    private readonly launch: DshLaunch,
    input: OpenInput,
    private readonly env: NodeJS.ProcessEnv,
    private readonly clientVersion: string,
    private readonly processTools: ProcessTools | undefined,
  ) {
    super(input, "DSH");
  }

  protected activeRunId(): RunId | undefined {
    return this.run?.id;
  }

  // ── 启动 ──

  async start(): Promise<void> {
    const { meta, log, signal, resume } = this.input;
    this.proc = spawnJsonl(this.launch.command, acpArgs(this.launch), {
      cwd: meta.cwd,
      env: sessionEnv(this.env, meta),
      onNonJson: (line) => log.debug("dsh: non-JSON stdout line", { line: clip(line, 200) }),
    });
    this.rpc = new DshRpc(this.proc, {
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
    });
    this.proc.onExit((info) => this.onExit(info));
    signal.addEventListener("abort", () => void this.close(), { once: true });

    try {
      const init = asRecord(await this.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "ensemble", version: this.clientVersion } }, START_TIMEOUT_MS));
      const protocol = num(init?.["protocolVersion"]);
      if (protocol !== 1) throw new HarnessStartError("start_failed", `DSH answered ACP protocol version ${protocol ?? "unknown"}; Ensemble speaks version 1.`);

      const opened = resume ? await this.resumeSession(resume.id) : await this.newSession();
      const catalog = await this.applyChoices(opened);
      this.nativeRef = { kind: "dsh-session", id: this.sessionId };
      this.announce(catalog);
    } catch (error) {
      throw this.startError(error);
    }
  }

  private async newSession(): Promise<DshCatalog> {
    const result = asRecord(await this.rpc.request("session/new", { cwd: this.input.meta.cwd, mcpServers: [] }, NEW_TIMEOUT_MS));
    const id = str(result?.["sessionId"]);
    if (!id) throw new Error("DSH did not return a session id.");
    this.sessionId = id;
    return parseCatalog(result?.["configOptions"]);
  }

  /** dsh 在新进程里恢复历史、模型与推理档位；响应里带当前的配置目录。 */
  private async resumeSession(id: string): Promise<DshCatalog> {
    const result = asRecord(await this.rpc.request("session/resume", { sessionId: id, cwd: this.input.meta.cwd, mcpServers: [] }, NEW_TIMEOUT_MS));
    this.sessionId = id;
    return parseCatalog(result?.["configOptions"]);
  }

  private async setOption(configId: "model" | "reasoning_effort", value: string): Promise<DshCatalog> {
    const result = asRecord(await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId, value }, OPTION_TIMEOUT_MS));
    return parseCatalog(result?.["configOptions"]);
  }

  /**
   * 把委派时选定的模型与推理档位落实到 dsh 会话里。
   * 明确指定的模型必须存在，不存在就明说（并列出可用的），而不是悄悄用默认模型；没指定时沿用 dsh 的默认。
   * 切换模型后推理档位会回到该模型的默认值，所以档位在模型之后设置。
   */
  private async applyChoices(opened: DshCatalog): Promise<DshCatalog> {
    const { meta, resume } = this.input;
    let catalog = opened;
    const requested = meta.model?.requested ?? (resume ? meta.model?.resolved : undefined);
    if (requested && catalog.models.length > 0) {
      const model = findModel(catalog.models, requested);
      if (!model) {
        throw new HarnessStartError("model_not_found", `DSH has no model "${requested}". Available: ${catalog.models.map((candidate) => candidate.id).join(", ")}.`);
      }
      if (model.value !== catalog.current) catalog = await this.setOption("model", model.value);
    }
    const effort = meta.effort;
    if (effort && effort !== catalog.effort) {
      if (!catalog.efforts.includes(effort)) {
        throw new HarnessStartError("invalid_request", `DSH's current model has no reasoning effort "${effort}". Available: ${catalog.efforts.join(", ") || "none"}.`);
      }
      catalog = await this.setOption("reasoning_effort", effort);
    }
    return catalog;
  }

  /** 把 dsh 实际采用的模型与档位告诉界面；Node 版本与官方声明不一致时留一条说明。 */
  private announce(catalog: DshCatalog): void {
    const model = catalog.models.find((candidate) => candidate.value === catalog.current);
    this.emit({
      kind: "session.updated",
      data: {
        patch: {
          ...(model ? { model: { resolved: model.id, label: model.label, ...(model.provider ? { provider: model.provider } : {}) } } : {}),
          ...(catalog.effort ? { effort: catalog.effort } : {}),
        },
      },
    });
    const engines = readEnginesNode(this.launch);
    if (engines && nodeSatisfies(process.version, engines) === false) {
      this.diagnostic(
        "info",
        "dsh.node_version",
        `DSH declares Node ${engines}, but Ensemble runs it with Node ${process.version}. It started and worked in testing; this combination is not officially supported by DSH.`,
      );
    }
  }

  private startError(error: unknown): HarnessStartError {
    if (error instanceof HarnessStartError) return error;
    const stderr = this.proc.stderrTail().trim();
    const message = errorMessage(error);
    const classified = classifyError(error instanceof DshRpcError ? error.reason : message);
    const resumeFailed = this.input.resume !== undefined && error instanceof DshRpcError;
    const code = resumeFailed ? "resume_failed" : classified.code === "model_not_found" || classified.code === "auth_failed" ? classified.code : "start_failed";
    return new HarnessStartError(code, `DSH could not start: ${clip(message, 300)}`, stderr ? tail(stderr, 1_500) : undefined);
  }

  // ── ExecutorSession ──

  async startRun(input: StartRunInput): Promise<void> {
    if (this.closing) throw new Error("The DSH session is closed.");
    if (this.run) throw new Error("A run is already active in this DSH session.");
    const run: RunState = {
      id: input.runId,
      messageId: input.messageId,
      started: false,
      finished: false,
      cancelRequested: false,
      text: undefined,
      thought: undefined,
      answers: [],
      tools: new Map(),
      snapshot: undefined,
    };
    this.run = run;
    // 响应就是这一轮的结束（可能是几十分钟后），不设超时；不 await，立即返回，由结果驱动终态事件。
    void this.rpc
      .request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: input.prompt }] }, NO_TIMEOUT_MS)
      .then(
        (result) => this.onPromptDone(run, result),
        (error: unknown) => this.onPromptFailed(run, error),
      );
  }

  /** dsh 在一轮进行中拒绝第二个 prompt（-32602），文字不会被注入；只能等这一轮结束后作为新的运行发送。 */
  async steer(_input: SteerInput): Promise<SteerOutcome> {
    return {
      kind: "needs_follow_up",
      reason: "run_in_progress",
      evidence: "dsh accepts one session/prompt at a time (a second one is rejected with -32602), so the message is sent after the current run.",
    };
  }

  async cancel(runId: RunId): Promise<void> {
    const run = this.run;
    if (!run || run.id !== runId || run.finished || run.cancelRequested) return;
    run.cancelRequested = true;
    await this.snapshotBeforeCancel(run);
    // 拍快照期间运行可能已经自己结束了。
    if (this.run !== run || run.finished) return;
    if (!this.rpc.notify("session/cancel", { sessionId: this.sessionId })) throw new Error("DSH is not running.");
  }

  /**
   * dsh 取消时只结束工具的那层 shell，shell 之下的进程会变成孤儿；所以在发出取消之前（这时进程树还是完整的）
   * 对有工具在跑的运行拍一次快照，运行结束后清理。没有工具在跑（例如正在等模型）就不需要。
   */
  private async snapshotBeforeCancel(run: RunState): Promise<void> {
    const tools = this.processTools;
    const pid = this.proc.pid;
    if (!tools || pid === undefined || run.tools.size === 0) return;
    const since = Math.min(...[...run.tools.values()].map((track) => Date.parse(track.startedAt)));
    let timer: NodeJS.Timeout | undefined;
    try {
      run.snapshot = await Promise.race([
        snapshotTree(pid, since, tools),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), SNAPSHOT_BUDGET_MS);
        }),
      ]);
      if (!run.snapshot) this.diagnostic("warn", "dsh.sweep_skipped", "Listing processes was too slow, so the cancel was sent without it; processes started by the cancelled tool may keep running.");
    } catch (error) {
      this.diagnostic("warn", "dsh.sweep_skipped", `Could not list processes before cancelling (${clip(errorMessage(error), 160)}); processes started by the cancelled tool may keep running.`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 运行中关闭：直接结束整个进程树。温和退出只会让 dsh 退出，它的工具子进程会留下来。
   * 之前取消留下的孤儿清理如果还没做完，限时等一下，免得服务退出把它丢在半路。
   *
   * 所有调用方（管理器的关闭与中止信号）必须共用同一次关闭：并发的第二次调用若越过“结束整棵树”直接走通用收尾，
   * 会先关掉 dsh 的标准输入，dsh 随即退出，按父子关系找后代的办法（Windows 的 taskkill /T、POSIX 上沿 ppid 向下找）再也找不到它的后代，
   * 工具的子进程就被留下了（真实 dsh 上实测到，Windows：关闭耗时 0.5 秒，ping 却还活着）。
   */
  override close(): Promise<void> {
    this.closeTask ??= this.closeAll();
    return this.closeTask;
  }

  private async closeAll(): Promise<void> {
    if (this.run) {
      this.closing = true;
      await killTree(this.proc?.pid);
    }
    await this.settleSweeps();
    return super.close();
  }

  private async settleSweeps(): Promise<void> {
    if (this.sweeps.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.sweeps]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SWEEP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  // ── 通知 ──

  private onNotification(method: string, params: Json): void {
    if (method === "session/update") this.onUpdate(params);
    else this.input.log.debug("dsh: ignored notification", { method });
  }

  private onUpdate(params: Json): void {
    if (str(params["sessionId"]) !== this.sessionId) return;
    const update = asRecord(params["update"]);
    const run = this.run;
    if (!update || !run || run.finished) return;
    this.markStarted(run);
    const kind = str(update["sessionUpdate"]);
    switch (kind) {
      case "agent_message_chunk":
        this.onText(run, update);
        break;
      case "agent_thought_chunk":
        this.onThought(run, update);
        break;
      case "tool_call":
        this.onToolStart(run, update);
        break;
      case "tool_call_update":
        this.onToolUpdate(run, update);
        break;
      case "usage_update": {
        const usage = usageOf(update);
        if (usage) this.emit({ kind: "usage.updated", data: { usage } }, run.id);
        break;
      }
      default:
        this.input.log.debug("dsh: ignored session update", { kind });
    }
  }

  /**
   * dsh 没有“回合开始”的通知，session/prompt 在整轮结束前也不会有任何应答：这一轮的第一条 session/update
   * （或直接给出的结果）才是它已经在处理这条消息的证据。
   * 管理器把 run.started 视为“消息已生效”，所以不能在写出请求时就发：第一次模型调用就以 401 之类失败时，
   * 模型从没见过这条消息，不该记成“已生效”。代价是第一次模型调用期间界面显示“正在连接”（dsh 的 ACP 没有更早的信号）。
   */
  private markStarted(run: RunState): void {
    if (run.started) return;
    run.started = true;
    this.emit({ kind: "run.started", data: {} }, run.id);
  }

  private onText(run: RunState, update: Json): void {
    const chunk = str(asRecord(update["content"])?.["text"]);
    if (!chunk) return;
    this.closeThought(run);
    const itemId = str(update["messageId"]) ?? `${run.id}:a${run.answers.length + 1}`;
    if (run.text && run.text.itemId !== itemId) this.closeText(run);
    if (!run.text) {
      run.text = { itemId, text: "" };
      if (!run.answers.includes(itemId)) run.answers.push(itemId);
    }
    run.text.text += chunk;
    this.emit({ kind: "assistant.delta", data: { itemId, text: chunk } }, run.id);
  }

  private onThought(run: RunState, update: Json): void {
    const chunk = str(asRecord(update["content"])?.["text"]);
    if (!chunk) return;
    this.closeText(run);
    const itemId = str(update["messageId"]) ?? `${run.id}:r`;
    if (run.thought && run.thought.itemId !== itemId) this.closeThought(run);
    run.thought ??= { itemId, text: "" };
    run.thought.text += chunk;
    this.emit({ kind: "reasoning.delta", data: { itemId, text: chunk } }, run.id);
  }

  private closeText(run: RunState): void {
    const open = run.text;
    if (!open) return;
    run.text = undefined;
    this.emit({ kind: "assistant.completed", data: { itemId: open.itemId, text: open.text } }, run.id);
  }

  private closeThought(run: RunState): void {
    const open = run.thought;
    if (!open) return;
    run.thought = undefined;
    this.emit({ kind: "reasoning.completed", data: { itemId: open.itemId } }, run.id);
  }

  // ── 工具 ──

  private onToolStart(run: RunState, update: Json): void {
    this.closeText(run);
    this.closeThought(run);
    const started = startTool(update, this.input.meta.cwd, isoNow());
    if (!started) return;
    run.tools.set(started.track.callId, started.track);
    this.emit({ kind: "tool.updated", data: started.update }, run.id);
  }

  private onToolUpdate(run: RunState, update: Json): void {
    const callId = str(update["toolCallId"]);
    if (!callId) return;
    let track = run.tools.get(callId);
    if (!track) {
      // 没见过这个调用的开始事件（例如是别的更新乱序）：按能拿到的信息补一条，免得结果无处安放。
      const created = startTool(update, this.input.meta.cwd, isoNow());
      if (!created) return;
      track = created.track;
      run.tools.set(callId, track);
      this.emit({ kind: "tool.updated", data: created.update }, run.id);
    }
    const status = str(update["status"]);
    if (status === "completed" || status === "failed") {
      const end = endTool(track, update, { cwd: this.input.meta.cwd, at: isoNow(), cancelRequested: run.cancelRequested });
      run.tools.delete(callId);
      this.emit({ kind: "tool.updated", data: end.update }, run.id);
      if (end.files.length > 0) this.emit({ kind: "file.changed", data: { callId, files: end.files } }, run.id);
      if (end.plan) this.emit({ kind: "plan.updated", data: { entries: end.plan } }, run.id);
      return;
    }
    const progress = progressTool(track, update);
    if (progress) this.emit({ kind: "tool.updated", data: progress }, run.id);
  }

  // ── dsh 发来的请求 ──

  private onServerRequest(id: RpcId, method: string, params: Json): void {
    if (method !== "session/request_permission") {
      this.rpc.respondError(id, -32601, `Ensemble does not handle "${method}".`);
      this.diagnostic("info", "dsh.unsupported_request", `DSH sent a request Ensemble does not handle ("${method}"); it was rejected.`);
      return;
    }
    // 被委派的会话一律带着 DSH_PERMISSION_MODE 启动：Full Access 下 dsh 不会发出这个请求（已实测），
    // 这里只是兜底——不弹窗、不等人：Full Access 放行一次，只读拒绝。
    const access = this.input.meta.access;
    const decision = permissionDecision(access, params);
    if (!this.rpc.respond(id, decision.response)) return;
    const callId = str(asRecord(params["toolCall"])?.["toolCallId"]);
    const track = callId ? this.run?.tools.get(callId) : undefined;
    const subject = track ? `${track.name}: ${clip(track.input ? JSON.stringify(track.input) : track.name, 160)}` : (callId ?? "unknown tool call");
    if (decision.allow) {
      this.diagnostic("info", "dsh.approval_granted", `DSH asked for approval ("${subject}"). Delegated sessions run with Full Access, so it was granted automatically (once).`);
    } else if (access === "read_only") {
      this.diagnostic("warn", "dsh.approval_declined", `DSH asked for approval ("${subject}"). This session is read-only, so it was declined automatically.`);
    } else {
      this.diagnostic("warn", "dsh.approval_unanswered", `DSH asked for approval ("${subject}") but offered no one-time allow option, so the request was cancelled.`);
    }
  }

  // ── 结束 ──

  private onPromptDone(run: RunState, result: unknown): void {
    const stopReason = str(asRecord(result)?.["stopReason"]) ?? "end_turn";
    if (stopReason === "cancelled") {
      this.finishRun(run, { kind: "cancelled" });
      return;
    }
    if (stopReason !== "end_turn") {
      this.diagnostic("warn", "dsh.stop_reason", `DSH ended the turn with stop reason "${stopReason}" instead of "end_turn"; the task may be incomplete.`);
    }
    this.finishRun(run, { kind: "completed", stopReason });
  }

  private onPromptFailed(run: RunState, error: unknown): void {
    // 只有 dsh 明确拒绝才是这一轮的失败；进程退出、写不进去等传输层问题由 onExit（→ fatal）与 close 统一处理，避免重复上报。
    if (!(error instanceof DshRpcError)) {
      this.input.log.debug("dsh: prompt request failed at the transport level", { error: errorMessage(error) });
      return;
    }
    if (run.cancelRequested) {
      this.diagnostic("info", "dsh.cancel_error", `DSH reported an error while the run was being cancelled: ${clip(error.reason, 240)}`);
      this.finishRun(run, { kind: "cancelled" });
      return;
    }
    this.finishRun(run, { kind: "failed", error: turnErrorInfo(error) });
  }

  private finishRun(run: RunState, outcome: Outcome): void {
    if (run.finished) return;
    run.finished = true;
    this.closeThought(run);
    this.closeText(run);
    // 没有任何更新就结束（例如空回答）也要先有“开始”。
    if (outcome.kind === "completed") this.markStarted(run);

    // 助手文字块的阶段：dsh 不给，最后一块视为最终回答，其余为过程说明。
    if (outcome.kind === "completed") {
      run.answers.forEach((itemId, index) => {
        this.emit({ kind: "assistant.completed", data: { itemId, phase: index === run.answers.length - 1 ? "final" : "commentary" } }, run.id);
      });
    }
    // 被我们取消的运行里没来得及结束的工具：dsh 对 shell 之外的工具不再上报结束事件，这里明确记为“已取消”。
    if (run.cancelRequested) {
      for (const track of run.tools.values()) this.emit({ kind: "tool.updated", data: { callId: track.callId, status: "cancelled", endedAt: isoNow() } }, run.id);
    }
    run.tools.clear();

    // 先清掉活动运行再上报终态：管理器在收到终态时可能同步地开始下一次运行。
    if (this.run === run) this.run = undefined;
    switch (outcome.kind) {
      case "completed":
        this.emit({ kind: "run.completed", data: { stopReason: outcome.stopReason } }, run.id);
        break;
      case "cancelled":
        this.emit({ kind: "run.cancelled", data: run.cancelRequested ? {} : { note: "DSH reported the turn as cancelled." } }, run.id);
        break;
      case "failed":
        this.emit({ kind: "run.failed", data: { error: outcome.error } }, run.id);
        break;
    }
    if (run.snapshot) this.sweep(run.snapshot);
  }

  // ── 取消后的孤儿清理 ──

  /**
   * 运行已经结束，清理结果作为会话层面的诊断上报（不带运行号：管理器会丢弃运行结束之后仍挂在这个运行名下的事件）。
   * 清理放在后台做，不拖慢“已取消”的上报；关闭会话时会限时等它做完（见 close）。
   */
  private sweep(snapshot: TreeSnapshot): void {
    const tools = this.processTools;
    if (!tools) return;
    const label = (procs: { name: string; pid: number }[]): string => procs.map((proc) => `${proc.name} (pid ${proc.pid})`).join(", ");
    const plural = (count: number): string => `${count} process${count === 1 ? "" : "es"}`;
    const task: Promise<void> = (async () => {
      try {
        const result = await sweepOrphans(snapshot, tools);
        if (result.killed.length > 0) {
          this.diagnostic("info", "dsh.orphans_stopped", `DSH's cancel stops the tool's shell but leaves the processes it started running. Ensemble ended ${plural(result.killed.length)}: ${clip(label(result.killed), 240)}.`);
        }
        if (result.failed.length > 0) {
          this.diagnostic("warn", "dsh.orphans_remaining", `Could not end ${plural(result.failed.length)} left by the cancelled tool: ${clip(label(result.failed.map((failure) => failure.proc)), 240)}.`);
        }
      } catch (error) {
        this.diagnostic("warn", "dsh.sweep_failed", `Could not check for processes left by the cancelled tool: ${clip(errorMessage(error), 200)}`);
      }
    })().finally(() => this.sweeps.delete(task));
    this.sweeps.add(task);
  }
}
