import { randomUUID } from "node:crypto";
import { ENV } from "@shared/constants";
import { isoNow } from "@shared/format";
import type { AccessEnforcement, AccessLevel, Capabilities, ErrorInfo, HarnessInfo, ModelInfo, NativeRef, RunId } from "@shared/types";
import { ClaudeEvents } from "./claude-events";
import { claudeRunArgs, READ_ONLY_FLAGS, READ_ONLY_TOOLS, REQUIRED_FLAGS, resolveClaudeLaunch, supportsFlags, type ClaudeLaunch } from "./claude-launch";
import { HarnessStartError, arr, asRecord, errorInfoFromText, str, type Json } from "./common";
import { runCapture, spawnJsonl, type ExitInfo, type JsonlProcess } from "./process";
import type { Executor, ExecutorSession, OpenInput, StartRunInput, SteerInput, SteerOutcome } from "./types";

const CAPABILITIES: Capabilities = {
  steer: { support: "no", mode: "none", verification: "declared" },
  followUp: { support: "yes", mode: "after_run", verification: "declared" },
  cancel: { support: "yes", verification: "declared" },
  resume: { support: "yes", verification: "declared" },
  reasoning: { support: "partial", verification: "declared" },
  plan: { support: "partial", verification: "declared" },
  usage: { support: "yes", verification: "declared" },
  fileEvents: { support: "partial", verification: "declared" },
};

const FULL_ACCESS: AccessEnforcement = { level: "none", mechanism: "Claude Code runs with bypassPermissions on this machine." };
const READ_ACCESS: AccessEnforcement = { level: "enforced", mechanism: "Claude Code safe mode with only Read, Glob and Grep; custom hooks and MCP are disabled." };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function modelsFrom(env: NodeJS.ProcessEnv): { models: ModelInfo[]; defaultModel?: string } {
  const configured = env["ANTHROPIC_MODEL"]?.trim();
  const ids = [...new Set([...(configured ? [configured] : []), "sonnet", "opus", "haiku"])];
  const models = ids.map((id): ModelInfo => ({ id, label: id, efforts: ["low", "medium", "high"], ...(id === configured ? { isDefault: true } : {}) }));
  return { models, ...(configured ? { defaultModel: configured } : {}) };
}

export interface ClaudeExecutorOptions {
  /** Path to a native executable or JS entry, also used by tests. */
  cli?: string;
  env?: NodeJS.ProcessEnv;
}

export class ClaudeExecutor implements Executor {
  readonly id = "claude" as const;
  readonly runtime = "native" as const;
  readonly canResume = true;
  constructor(private readonly options: ClaudeExecutorOptions = {}) {}

  private get env(): NodeJS.ProcessEnv { return this.options.env ?? process.env; }

  async probe(): Promise<HarnessInfo> {
    const base = { id: this.id, displayName: "Claude Code", runtime: this.runtime, capabilities: CAPABILITIES,
      access: { read_only: null, full: FULL_ACCESS } as Record<AccessLevel, AccessEnforcement | null>, models: [] as ModelInfo[] };
    const launch = resolveClaudeLaunch(this.env, this.options.cli);
    if (!launch) return { ...base, status: "unavailable", setup: { code: "claude_not_found", message: "Claude Code was not found on PATH.", command: "npm install -g @anthropic-ai/claude-code" }, checkedAt: isoNow() };
    if (/^(?:1|true|yes)$/i.test(this.env["CLAUDE_CODE_SKIP_PROMPT_HISTORY"] ?? "")) {
      return { ...base, status: "needs_setup", setup: { code: "claude_persistence_disabled", message: "Claude Code session persistence is disabled; continuing a session requires it." }, checkedAt: isoNow() };
    }
    let version: Awaited<ReturnType<typeof runCapture>>;
    let help: Awaited<ReturnType<typeof runCapture>>;
    let auth: Awaited<ReturnType<typeof runCapture>>;
    try {
      [version, help, auth] = await Promise.all([
        runCapture(launch.command, [...launch.prefix, "--version"], { env: this.env, timeoutMs: 10_000 }),
        runCapture(launch.command, [...launch.prefix, "--help"], { env: this.env, timeoutMs: 10_000 }),
        runCapture(launch.command, [...launch.prefix, "auth", "status"], { env: this.env, timeoutMs: 12_000 }),
      ]);
    } catch {
      return { ...base, status: "unavailable", setup: { code: "claude_probe_failed", message: "Claude Code could not be started for its availability check." }, checkedAt: isoNow() };
    }
    const foundVersion = `${version.stdout}\n${version.stderr}`.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
    const withVersion = { ...base, ...(foundVersion ? { version: foundVersion } : {}) };
    if (version.code !== 0 || help.code !== 0 || !supportsFlags(help.stdout, REQUIRED_FLAGS)) {
      return { ...withVersion, status: "unavailable", setup: { code: "claude_unsupported", message: "Claude Code lacks the required streaming session interface.", command: "claude update" }, checkedAt: isoNow() };
    }
    let status: Json | undefined;
    try { status = asRecord(JSON.parse(auth.stdout)); } catch { /* Do not include auth output in diagnostics. */ }
    if (status?.["loggedIn"] === false) {
      return { ...withVersion, status: "needs_setup", setup: { code: "claude_login_required", message: "Claude Code is not signed in.", command: "claude auth login" }, checkedAt: isoNow() };
    }
    if (auth.code !== 0 || status?.["loggedIn"] !== true) {
      return { ...withVersion, status: "unavailable", setup: { code: "claude_probe_failed", message: "Claude Code authentication status could not be read." }, checkedAt: isoNow() };
    }
    const access = { full: FULL_ACCESS, read_only: supportsFlags(help.stdout, READ_ONLY_FLAGS) ? READ_ACCESS : null };
    return { ...withVersion, ...modelsFrom(this.env), access, status: "ready", checkedAt: isoNow() };
  }

  async open(input: OpenInput): Promise<ExecutorSession> {
    const launch = resolveClaudeLaunch(this.env, this.options.cli);
    if (!launch) throw new HarnessStartError("harness_unavailable", "Claude Code was not found on PATH.");
    if (input.resume && (input.resume.kind !== "claude-session" || !UUID.test(input.resume.id))) {
      throw new HarnessStartError("session_not_resumable", "The Claude Code session reference is invalid.");
    }
    if (input.meta.access === "read_only") {
      const help = await runCapture(launch.command, [...launch.prefix, "--help"], { env: this.env, timeoutMs: 10_000 });
      if (help.code !== 0 || !supportsFlags(help.stdout, READ_ONLY_FLAGS)) throw new HarnessStartError("access_unsupported", "This Claude Code version cannot enforce the read-only tool policy.");
    }
    input.signal.throwIfAborted();
    return new ClaudeSession(launch, input, this.env);
  }
}

interface ActiveRun {
  id: RunId;
  sessionId: string;
  messageUuid: string;
  process: JsonlProcess;
  initialized: boolean;
  startPending: boolean;
  started: boolean;
  cancelRequested: boolean;
  result?: Json;
  error?: ErrorInfo;
}

/** Each process runs one turn; Claude's persisted native session carries context across turns. */
class ClaudeSession implements ExecutorSession {
  nativeRef: NativeRef | undefined;
  private active: ActiveRun | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly launch: ClaudeLaunch, private readonly input: OpenInput, private readonly env: NodeJS.ProcessEnv) {
    this.nativeRef = input.resume;
    input.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private readonly onAbort = (): void => { void this.close(); };

  async startRun(input: StartRunInput): Promise<void> {
    if (this.closing) throw new HarnessStartError("session_closed", "The Claude Code session is closed.");
    if (this.active) throw new HarnessStartError("conflict", "A Claude Code run is already active.");
    const sessionId = this.nativeRef?.id ?? randomUUID();
    const args = claudeRunArgs(this.input.meta, sessionId, this.nativeRef !== undefined);
    const proc = spawnJsonl(this.launch.command, [...this.launch.prefix, ...args], {
      cwd: this.input.meta.cwd,
      env: { ...this.env, CLAUDECODE: undefined, [ENV.parentSession]: this.input.meta.id, [ENV.parentDepth]: String(this.input.meta.depth) },
    });
    const run: ActiveRun = { id: input.runId, sessionId, messageUuid: randomUUID(), process: proc, initialized: false, startPending: false, started: false, cancelRequested: false };
    this.active = run;
    const mapper = new ClaudeEvents(run.id, run.messageUuid, this.input.meta.cwd, {
      emit: (draft) => { if (!this.closing && this.active === run && run.started && !run.error) this.input.emit(draft); },
      init: (message) => this.onInit(run, message),
      started: () => this.onStarted(run),
      result: (message) => { if (this.active === run) run.result = message; },
    });
    proc.onMessage((message) => { if (!this.closing && this.active === run && !run.error) mapper.accept(message); });
    proc.onExit((exit) => this.onExit(run, exit));
    const sent = proc.send({ type: "user", uuid: run.messageUuid, session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: input.prompt } });
    if (!sent) {
      this.active = undefined;
      await proc.kill();
      throw new HarnessStartError("start_failed", "Claude Code could not accept the run input.");
    }
    proc.child.stdin?.end();
  }

  async steer(_input: SteerInput): Promise<SteerOutcome> {
    return { kind: "needs_follow_up", reason: "run_in_progress", evidence: "Claude Code follow-up will start after the current run." };
  }

  async cancel(runId: RunId): Promise<void> {
    const run = this.active;
    if (!run || run.id !== runId) return;
    run.cancelRequested = true;
    await run.process.kill();
    if (!run.process.exited) throw new Error("Claude Code did not exit after cancellation.");
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.input.signal.removeEventListener("abort", this.onAbort);
    this.closePromise = this.active?.process.kill() ?? Promise.resolve();
    return this.closePromise;
  }

  private onInit(run: ActiveRun, message: Json): void {
    const sessionId = str(message["session_id"]);
    if (sessionId !== run.sessionId) {
      this.failAndStop(run, { code: "session_not_resumable", message: "Claude Code returned an unexpected session ID." });
      return;
    }
    if (this.input.meta.access === "read_only") {
      const tools = arr(message["tools"]);
      const allowed = new Set<string>(READ_ONLY_TOOLS.map((name) => name.toLowerCase()));
      if (!tools || tools.some((name) => typeof name !== "string" || !allowed.has(name.toLowerCase()))) {
        this.failAndStop(run, { code: "access_unsupported", message: "Claude Code reported tools outside the read-only allowlist." });
        return;
      }
    }
    run.initialized = true;
    const model = str(message["model"]);
    if (model) this.input.emit({ kind: "session.updated", data: { patch: { model: { ...this.input.meta.model, resolved: model, label: model } } }, runId: run.id });
    if (run.startPending) this.onStarted(run);
  }

  private onStarted(run: ActiveRun): void {
    if (this.active !== run || run.started || run.error || this.closing) return;
    if (!run.initialized) {
      run.startPending = true;
      return;
    }
    run.started = true;
    this.nativeRef = { kind: "claude-session", id: run.sessionId };
    this.input.emit({ kind: "session.updated", data: { patch: { nativeRef: this.nativeRef } }, runId: run.id });
    this.input.emit({ kind: "run.started", data: {}, runId: run.id });
  }

  private failAndStop(run: ActiveRun, error: ErrorInfo): void {
    if (this.active !== run || run.error) return;
    run.error = error;
    void run.process.kill();
  }

  private onExit(run: ActiveRun, exit: ExitInfo): void {
    if (this.active !== run) return;
    this.active = undefined;
    if (this.closing) return;
    const result = run.result;
    if (run.error) {
      this.input.emit({ kind: "run.failed", data: { error: run.error }, runId: run.id });
    } else if (run.cancelRequested && !result) {
      this.input.emit({ kind: "run.cancelled", data: {}, runId: run.id });
    } else if (!run.initialized) {
      this.input.emit({ kind: "run.failed", data: { error: { code: "start_failed", message: "Claude Code did not report a valid session initialization." } }, runId: run.id });
    } else if (result?.["subtype"] === "success" && result["is_error"] !== true) {
      this.input.emit({ kind: "run.completed", data: { ...(str(result["stop_reason"]) ? { stopReason: str(result["stop_reason"]) } : {}) }, runId: run.id });
    } else {
      const details = (arr(result?.["errors"]) ?? []).filter((value): value is string => typeof value === "string").join("; ");
      const message = details || str(result?.["result"]) || exit.error?.message || exit.stderrTail.trim() || `Claude Code exited without a result (code ${exit.code ?? "unknown"}).`;
      this.input.emit({ kind: "run.failed", data: { error: errorInfoFromText(message) }, runId: run.id });
    }
  }
}
