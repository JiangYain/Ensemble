import { tmpdir } from "node:os";
import { ENV } from "@shared/constants";
import { clip, errorMessage, isoNow } from "@shared/format";
import type { AccessEnforcement, AccessLevel, Capabilities, HarnessInfo, ModelInfo, RunId } from "@shared/types";
import { HarnessStartError, asRecord, str } from "./common";
import { OpenCodeHttpError, startOpenCodeServer } from "./opencode-api";
import { OpenCodeEventSession, OpenCodeSteer, newRun, type RunState } from "./opencode-events";
import { modelKey, permissionRules, readCatalog, redact, splitModelKey, toModelInfo } from "./opencode-items";
import { resolveOpenCode, type OpenCodeLaunch, type OpenCodeResolution } from "./opencode-launch";
import type { ExitInfo } from "./process";
import type { Executor, ExecutorSession, OpenInput, StartRunInput, SteerInput, SteerOutcome } from "./types";

/**
 * OpenCode 适配器：每个会话独占一个 `opencode serve --stdio` 私有服务，经 HTTP（REST）+ SSE 事件流驱动完整的 OpenCode 会话
 * （OpenCode 2.3.0 的 V2 接口，见 opencode-api.ts）。
 *
 * 为什么选这条路径：
 * - ACP（`opencode acp`）没有运行中补充输入；`opencode run --format json` 既不能纠偏也没有优雅取消；
 * - HTTP 接口里纠偏（`delivery:"steer"`）、中断（`interrupt`）、权限回复、会话续聊都是一等公民，事件流带 sessionID，能区分子 Agent 的会话；
 * - 私有服务按会话隔离，不碰用户已经开着的共享服务，也不改用户的 opencode.json：权限在创建会话时以会话级规则写入。
 *
 * 凭据：OpenCode 的登录与密钥完全由 OpenCode 自己管理，Ensemble 不读取、不保存；模型目录里带凭据的设置字段从不被拷贝。
 */

/**
 * live = 在真实 OpenCode 上跑通过（OpenCode 2.3.0 · Windows 11 · 2026-11-15～16 · 免费模型 opencode/deepseek-v4.1-flash-free）。
 * 换了 OpenCode 版本或操作系统后，这些结论需要重新验证。
 */
const OPENCODE_CAPABILITIES: Capabilities = {
  steer: { support: "yes", mode: "turn_boundary", verification: "live" },
  followUp: { support: "yes", mode: "after_run", verification: "live" },
  cancel: { support: "yes", verification: "live" },
  resume: { support: "yes", verification: "live" },
  reasoning: { support: "yes", verification: "live" },
  // V2 没有 todo 一类的计划工具，事件流里也没有计划条目。
  plan: { support: "no" },
  usage: { support: "yes", verification: "live" },
  // 只能从 edit 的结果元数据与 write 的回执得知文件变更；shell 与 execute（代码模式）里的改动看不到。
  fileEvents: { support: "partial", verification: "live" },
  // 业务提问（`question` 工具）的转交只对着假 OpenCode 验证过，接口形状是读 2.3.0 随包源码得来的；从未在真实 OpenCode 上触发过提问。
  question: { support: "yes", verification: "declared" },
};

const OPENCODE_ACCESS: Record<AccessLevel, AccessEnforcement | null> = {
  read_only: { level: "enforced", mechanism: "OpenCode session permission rules: only read / glob / grep are allowed; every other tool is denied and hidden from the model" },
  full: { level: "none", mechanism: "Session permission rules allow every tool: no sandbox and no approval prompts, so tools can reach any path the OS user can" },
};

const INSTALL_COMMAND = "npm install -g @opencode/cli";
const PROBE_TIMEOUT_MS = 25_000;
const CATALOG_TIMEOUT_MS = 10_000;
const STREAM_LOSS_GRACE_MS = 600;
/** 中断请求本身的上限：取消时给得宽松（服务在忙），关闭时服务马上要退出了，等不起。 */
const CANCEL_INTERRUPT_TIMEOUT_MS = 30_000;
const CLOSE_INTERRUPT_TIMEOUT_MS = 3_000;
const TITLE_MAX = 80;

function unavailableSetup(resolution: Exclude<OpenCodeResolution, { ok: true }>): NonNullable<HarnessInfo["setup"]> {
  switch (resolution.reason) {
    case "not_found":
      return { code: "opencode_not_found", message: "OpenCode was not found on PATH or in the usual install locations.", command: INSTALL_COMMAND };
    case "configured_unusable":
      return { code: "opencode_not_found", message: `${ENV.opencodeBin} points to ${resolution.path}, which does not exist or cannot run.` };
    case "unsupported":
      return {
        code: "opencode_unsupported",
        message: `OpenCode ${resolution.version} is too old: Ensemble needs 2.x (the \`serve --stdio\` server and its event stream).`,
        command: INSTALL_COMMAND,
      };
  }
}

// ───────────────────────── 执行端 ─────────────────────────

export interface OpenCodeExecutorOptions {
  /** 直接指定 opencode 可执行文件（测试时指向假 OpenCode 的 JS 入口）。 */
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

export class OpenCodeExecutor implements Executor {
  readonly id = "opencode" as const;
  readonly runtime = "native" as const;
  readonly canResume = true;

  constructor(private readonly options: OpenCodeExecutorOptions = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  async probe(): Promise<HarnessInfo> {
    const base = {
      id: "opencode" as const,
      displayName: "OpenCode",
      runtime: "native" as const,
      capabilities: OPENCODE_CAPABILITIES,
      access: OPENCODE_ACCESS,
      models: [] as ModelInfo[],
    };
    const resolution = await resolveOpenCode(this.env, this.options.bin, { fresh: true });
    if (!resolution.ok) {
      return {
        ...base,
        status: "unavailable",
        ...(resolution.reason === "unsupported" ? { version: resolution.version } : {}),
        setup: unavailableSetup(resolution),
        checkedAt: isoNow(),
      };
    }
    const { version } = resolution.launch;

    // 模型目录必须问 OpenCode 自己（它合并了用户配置、登录状态与内置目录）；这里不读任何配置或凭据文件。
    let server: Awaited<ReturnType<typeof startOpenCodeServer>> | undefined;
    try {
      server = await startOpenCodeServer(resolution.launch, { cwd: tmpdir(), env: this.env });
      const { client } = server;
      const [catalogBody, defaultBody] = await Promise.all([
        client.request("GET", "/api/model", undefined, PROBE_TIMEOUT_MS),
        client.request("GET", "/api/model/default", undefined, PROBE_TIMEOUT_MS).catch(() => undefined),
      ]);
      const defaultModel = asRecord(asRecord(defaultBody)?.["data"]);
      const providerId = str(defaultModel?.["providerID"]);
      const modelId = str(defaultModel?.["modelID"]) ?? str(defaultModel?.["id"]);
      const defaultKey = providerId && modelId ? modelKey({ providerID: providerId, modelID: modelId }) : undefined;
      const models = readCatalog(catalogBody).map((model) => toModelInfo(model, defaultKey));
      const info: HarnessInfo = {
        ...base,
        status: models.length > 0 ? "ready" : "needs_setup",
        models,
        version,
        checkedAt: isoNow(),
        ...(defaultKey && models.some((model) => model.id === defaultKey) ? { defaultModel: defaultKey } : {}),
      };
      if (models.length === 0) {
        info.setup = { code: "opencode_no_models", message: "OpenCode has no usable models. Connect a provider with `opencode auth login`.", command: "opencode auth login" };
      }
      return info;
    } catch (error) {
      const reason = (server?.proc.stderrTail() ?? "").split(/\r?\n/).find((line) => line.trim().length > 0);
      const message = redact(errorMessage(error));
      return {
        ...base,
        status: "unavailable",
        version,
        setup: { code: "opencode_probe_failed", message: reason ? `${message} (${clip(redact(reason.trim()), 200)})` : message },
        checkedAt: isoNow(),
      };
    } finally {
      server?.client.failAll(new Error("probe finished"));
      await server?.proc.kill();
    }
  }

  async open(input: OpenInput): Promise<ExecutorSession> {
    const resolution = await resolveOpenCode(this.env, this.options.bin);
    if (!resolution.ok) throw new HarnessStartError("harness_unavailable", unavailableSetup(resolution).message);
    const session = new OpenCodeSession(resolution.launch, input, this.env);
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

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

class OpenCodeSession extends OpenCodeEventSession {
  private closeAll: Promise<void> | undefined;

  constructor(
    private readonly launch: OpenCodeLaunch,
    input: OpenInput,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super(input);
  }

  // ── 启动 ──

  async start(): Promise<void> {
    const { meta, resume, log, signal } = this.input;
    if (resume && (resume.kind !== "opencode-session" || !SESSION_ID.test(resume.id))) {
      throw new HarnessStartError("session_not_resumable", "The OpenCode session reference is invalid.");
    }
    const requested = meta.model?.requested;
    const model = requested ? splitModelKey(requested) : undefined;
    if (requested && !model) throw new HarnessStartError("invalid_request", `OpenCode models are written provider/model, got "${clip(requested, 80)}".`);

    const server = await startOpenCodeServer(this.launch, {
      cwd: meta.cwd,
      // 嵌套委派：被委派的 OpenCode 里如果也装了 Ensemble 插件，它的 MCP 桥读这两个变量，把二次委派挂到正确的父会话下。
      env: { ...this.env, [ENV.parentSession]: meta.id, [ENV.parentDepth]: String(meta.depth) },
      onNonJson: (line) => log.debug("opencode: non-JSON stdout line", { line: clip(redact(line), 200) }),
    });
    this.proc = server.proc;
    this.rpc = server.client;
    this.proc.onExit((info) => this.onExit(info));
    signal.addEventListener("abort", () => void this.close(), { once: true });

    try {
      // 先订阅再建会话，这样不会漏掉任何事件。
      await this.rpc.subscribe(
        (event) => this.handle(event),
        (error) => this.onStreamClosed(error),
      );
      await this.loadCatalog();
      if (resume) await this.resumeSession(resume.id);
      else await this.createSession(model, meta.effort);
    } catch (error) {
      throw this.startError(error);
    }

    this.nativeRef = { kind: "opencode-session", id: this.sessionId };
    const known = requested ? this.catalog.get(requested) : undefined;
    if (model && requested) {
      this.emit({
        kind: "session.updated",
        data: {
          patch: {
            model: { resolved: requested, label: known?.name ?? model.modelID, provider: model.providerID },
            ...(meta.effort ? { effort: meta.effort } : {}),
          },
        },
      });
    }
  }

  /** 模型目录只用来取展示名与上下文窗口；拿不到不影响委派。 */
  private async loadCatalog(): Promise<void> {
    try {
      for (const model of readCatalog(await this.rpc.request("GET", "/api/model", undefined, CATALOG_TIMEOUT_MS))) {
        this.catalog.set(modelKey(model), model);
      }
    } catch (error) {
      this.input.log.debug("opencode: model catalog unavailable", { error: errorMessage(error) });
    }
  }

  private async createSession(model: { providerID: string; modelID: string } | undefined, effort: string | undefined): Promise<void> {
    const { meta } = this.input;
    const created = await this.rpc.request("POST", "/api/session", {
      location: { directory: meta.cwd },
      ...(model ? { model: { id: model.modelID, providerID: model.providerID, ...(effort ? { variant: effort } : {}) } } : {}),
      permissions: permissionRules(meta.access),
      metadata: { source: "ensemble", ensembleSession: meta.id },
    });
    const id = str(asRecord(asRecord(created)?.["data"])?.["id"]);
    if (!id || !SESSION_ID.test(id)) throw new Error("OpenCode did not return a session id.");
    this.sessionId = id;
    // 先给会话起好名字：有标题就不会再多花一次模型调用去生成标题，用户在 OpenCode 里也能认出它。
    await this.rpc.request("PATCH", `/api/session/${id}`, { title: clip(meta.title.replace(/\s+/g, " ").trim() || "Ensemble delegation", TITLE_MAX) });
  }

  private async resumeSession(id: string): Promise<void> {
    try {
      const found = await this.rpc.request("GET", `/api/session/${id}`);
      if (str(asRecord(asRecord(found)?.["data"])?.["id"]) !== id) throw new OpenCodeHttpError(404, "session id mismatch");
    } catch (error) {
      if (error instanceof OpenCodeHttpError && (error.status === 404 || error.status === 400)) {
        throw new HarnessStartError("session_not_resumable", "OpenCode no longer has this session, so it cannot be resumed.", error.message);
      }
      throw error;
    }
    this.sessionId = id;
  }

  /** 启动阶段的失败 → 可行动的错误（HarnessStartError 原样放行）。 */
  private startError(error: unknown): HarnessStartError {
    if (error instanceof HarnessStartError) return error;
    const stderr = this.proc.stderrTail().trim();
    const text = redact(errorMessage(error));
    const code = /model/i.test(text) && /not (?:found|available)|unavailable/i.test(text) ? "model_not_found" : "start_failed";
    return new HarnessStartError(code, `OpenCode could not start the session: ${clip(text, 300)}`, stderr ? clip(redact(stderr), 1_500) : undefined);
  }

  // ── ExecutorSession ──

  async startRun(input: StartRunInput): Promise<void> {
    if (this.closing) throw new Error("The OpenCode session is closed.");
    if (this.run) throw new Error("A run is already active in this OpenCode session.");
    const run = newRun(input.runId, input.messageId);
    this.run = run;
    try {
      await this.rpc.request("POST", `/api/session/${this.sessionId}/prompt`, { text: input.prompt });
    } catch (error) {
      if (this.run === run) this.run = undefined;
      throw error;
    }
  }

  async steer(input: SteerInput): Promise<SteerOutcome> {
    const run = this.run;
    if (!run || run.id !== input.runId || run.finishing) {
      return { kind: "needs_follow_up", reason: "run_in_progress", evidence: "opencode: no active run to steer" };
    }
    const track = new OpenCodeSteer();
    this.steers.set(input.messageId, track);
    let accepted: unknown;
    try {
      accepted = await this.rpc.request("POST", `/api/session/${this.sessionId}/prompt`, { text: input.text, delivery: "steer" });
    } catch (error) {
      this.steers.delete(input.messageId);
      throw error;
    }
    track.inboxId = str(asRecord(asRecord(accepted)?.["data"])?.["id"]);
    // 在 steer 的响应回来之前，运行可能已经被取消：这条消息不能留在收件箱里漏进下一次运行。
    if (track.inboxId && run.cancelRequested) {
      if (await this.deleteInbox(track.inboxId)) this.cancelSteer(input.messageId, "opencode: removed from the inbox because the run was cancelled");
      return { kind: "queued_by_harness", reason: "turn_boundary", evidence: "opencode: steer accepted, then withdrawn because the run was cancelled" };
    }
    // 回执与事件谁先到都可能：收件箱条目已被取走就立刻补上“已生效”的证据。
    if (track.inboxId && this.isDelivered(track.inboxId)) this.echoSteer(input.messageId, track);
    track.accept((evidence) => this.emitApplied(input.messageId, evidence, run.id));
    return {
      kind: "queued_by_harness",
      reason: "turn_boundary",
      evidence: `opencode: steer accepted (delivery=steer${track.inboxId ? `, inbox ${track.inboxId}` : ""}); injected at the next step boundary`,
    };
  }

  async cancel(runId: RunId): Promise<void> {
    const run = this.run;
    if (!run || run.id !== runId || run.finishing) return;
    run.cancelRequested = true;

    // 1. 撤回还没被取走的纠偏：中断之后它会留在收件箱里，漏进下一次运行。
    await Promise.all(
      [...this.steers]
        .filter(([, track]) => !track.applied && track.inboxId !== undefined)
        .map(async ([messageId, track]) => {
          if (track.inboxId && (await this.deleteInbox(track.inboxId))) this.cancelSteer(messageId, "opencode: removed from the inbox before it was delivered (run cancelled)");
        }),
    );
    // 2. 先杀 shell 工具的进程树、根进程一退出就中断（取消期间新冒出来的 shell 也会被立刻结束）。
    this.shells.halt();
    try {
      await this.haltRun(run, CANCEL_INTERRUPT_TIMEOUT_MS);
    } finally {
      this.shells.resume();
    }
  }

  /**
   * 停下一次运行：先结束 shell 工具的进程树，根进程一退出就发中断，最后等杀树收尾，确认孙进程已经清干净。
   * 顺序的理由见 opencode-shells.ts：OpenCode 自己的中断只杀得掉 shell 本身；而中断也不能等杀树完全收尾再发，否则模型会抢先开始下一步。
   * resume=false：中断后不要自动接着处理收件箱里的东西；会话本身保留，之后可以继续交代。
   */
  private async haltRun(run: RunState | undefined, interruptTimeoutMs: number): Promise<void> {
    const kills = await this.shells.killAll();
    try {
      if (run && this.run === run && !run.finishing) {
        await this.rpc.request("POST", `/api/session/${this.sessionId}/interrupt?resume=false`, undefined, interruptTimeoutMs);
      }
    } finally {
      await kills.settled;
    }
  }

  // ── 关闭与异常 ──

  /**
   * 关闭时先把仍在进行的运行停下来（服务退出并不会带走工具进程；也不能让模型在 shell 被杀后接着开新的），
   * 再关 stdin 让私有服务自己退出。中断让 OpenCode 干净地记下这次执行的结局，之后恢复会话时状态是一致的。会话数据由 OpenCode 保留。
   */
  override close(): Promise<void> {
    this.closeAll ??= (async () => {
      this.closing = true;
      this.shells.finish();
      // 清理尽力而为：服务可能已经崩溃，任何一步失败都不能妨碍后面的关闭。
      await this.haltRun(this.run, CLOSE_INTERRUPT_TIMEOUT_MS).catch((error: unknown) => {
        this.input.log.debug("opencode: could not stop the run while closing", { error: errorMessage(error) });
      });
      await super.close();
    })();
    return this.closeAll;
  }

  protected override onExit(info: ExitInfo): void {
    super.onExit({ ...info, stderrTail: redact(info.stderrTail) });
  }

  private onStreamClosed(error: Error | undefined): void {
    if (this.closing) return;
    // 服务进程退出时事件流会同时断开：让带退出码与 stderr 的“进程退出”报告抢先，进程还活着才说是事件流断了。
    const timer = setTimeout(() => {
      if (this.closing || this.proc.exited) return;
      this.input.fatal({
        code: "process_exited",
        message: `The OpenCode event stream closed while the session was still open${error ? `: ${clip(redact(errorMessage(error)), 200)}` : ""}.`,
      });
    }, STREAM_LOSS_GRACE_MS);
    timer.unref();
  }
}