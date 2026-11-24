/**
 * 看门狗脚本（skills/ensemble-delegate/scripts/watch.mjs）的测试夹具：载入脚本、造数据、假的服务、真实服务加子进程。
 * 从 test/watch-script.test.ts 原样搬出（只加了 export 与几处只增不改的扩展），现在由 watch-script.test.ts、watch-script.copies.test.ts、watch-script.pass.test.ts、watch-script.run.test.ts、watch-script.shared.fixtures.ts 与 watch-wake.test.ts 共用。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FixtureExecutor } from "../src/server/executors/fixture";
import { silentLogger } from "../src/server/logger";
import { startService, type RunningService } from "../src/server/service";
import { until } from "../src/server/testing";
import { testOrigin } from "../src/shared/testing";
import type { Actor } from "../src/shared/types";

// ───────────────────────── 载入脚本 ─────────────────────────

export type Json = Record<string, any>;

export interface RuleSet {
  commands: { regex: RegExp; message: string }[];
  paths: { regex: RegExp; message: string }[];
}

export interface Finding {
  tag: "ALERT" | "INFO" | "DONE";
  key: string;
  text: string;
  repeat?: boolean;
}

export interface WatchModule {
  clip(text: unknown, max?: number): string;
  formatDuration(ms: number): string;
  shortenPath(path: string, max?: number): string;
  harnessLabel(summary: Json): string;
  resolveHome(env?: NodeJS.ProcessEnv, platform?: string): string;
  isSettled(summary: Json): boolean;
  parseArgs(argv: string[]): { options: Json; errors: string[] };
  compileRules(raw: unknown): RuleSet;
  loadRules(file: string): RuleSet;
  normalizePath(file: string, cwd: string): string;
  attentionKey(item: Json): string;
  describeAttention(item: Json, summary: Json, now: number): string;
  createTracker(summary: Json): Json;
  ingest(tracker: Json, events: Json[], context: { rules?: RuleSet; now: number }): Finding[];
  inspect(tracker: Json, summary: Json, context: { now: number; capacity?: Json | undefined }): Finding[];
  settle(tracker: Json, summary: Json, now: number): Finding[];
  createWatcher(options: Json, deps?: Json): Json;
  pass(watcher: Json): Promise<{ exit?: number }>;
  // ── 唤醒 / 状态文件 / 来源过滤 / 指纹 / 代理对安全的截断（test/watch-wake.test.ts 用）
  sliceHead(text: string, max: number): string;
  sliceTail(text: string, max: number): string;
  callFingerprint(tool: Json): string;
  parseState(text: string): { state?: Json; problem?: string };
  readStateFile(file: string): { state?: Json; missing?: true; problem?: string };
  buildState(watcher: Json, now: number): Json;
  endedAtOf(summary: Json): number | undefined;
  main(argv: string[], env?: NodeJS.ProcessEnv, deps?: Json): Promise<number>;
}

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const skillDir = join(root, "skills", "ensemble-delegate");
export const scriptDir = join(skillDir, "scripts");
export const scriptPath = join(scriptDir, "watch.mjs");
export const examplePath = join(scriptDir, "watch.rules.example.json");

export const watch = (await import(pathToFileURL(scriptPath).href)) as WatchModule;

// ───────────────────────── 造数据 ─────────────────────────

export const NOW = Date.parse("2026-11-17T12:00:00.000Z");
export const at = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString();

export function summary(patch: Json = {}): Json {
  return {
    id: "ses_a",
    title: "Refactor the parser",
    harness: "codex",
    runtime: "native",
    status: "running",
    phase: "running",
    cwd: "/work/app",
    activity: { kind: "tool", since: at(-1000) },
    messages: { total: 1, pending: 0 },
    counters: { tools: 4, failedTools: 0, files: 1, interventions: 0 },
    lastRun: { id: "run_1", index: 1, status: "running" },
    createdAt: at(-600_000),
    updatedAt: at(-1000),
    seq: 0,
    ...patch,
  };
}

export const started = (callId: string, title: string, extra: Json = {}, offsetMs = -1000): Json => ({
  kind: "tool.updated",
  at: at(offsetMs),
  data: { callId, name: "shell", category: "shell", title, status: "running", input: { text: title }, ...extra },
});

export const ended = (callId: string, status: "completed" | "failed" | "cancelled", output = "", offsetMs = -500): Json => ({
  kind: "tool.updated",
  at: at(offsetMs),
  data: { callId, status, ...(output ? { output: { text: output } } : {}), ...(status === "failed" ? { error: output || "failed" } : {}) },
});

export const changed = (files: Json[], offsetMs = -500): Json => ({ kind: "file.changed", at: at(offsetMs), data: { files } });

/** 给事件补上信封（id、会话、序号、来源），序号在同一个 feeder 里递增。 */
export function feeder(sessionId = "ses_a"): (...events: Json[]) => Json[] {
  let seq = 0;
  return (...events) => events.map((raw) => ({ id: `evt_${sessionId}_${++seq}`, sessionId, seq, source: "executor", ...raw }));
}

/** 若干次成功或失败的工具调用，标题各不相同（不会触发“同一个调用反复出现”）。 */
export function calls(prefix: string, count: number, status: "completed" | "failed"): Json[] {
  return Array.from({ length: count }, (_, index) => [started(`${prefix}${index}`, `step ${prefix}${index}`), ended(`${prefix}${index}`, status, status === "failed" ? "exit code 1" : "ok")]).flat();
}

export const track = (patch: Json = {}): Json => watch.createTracker(summary(patch));
export const keysOf = (findings: Finding[]): string[] => findings.map((finding) => finding.key);

export function world(options: Json = {}, rules?: RuleSet) {
  let now = NOW;
  let capacity: Json | undefined = { occupied: 1, max: 4, waiting: 0 };
  let outage: Error | undefined;
  const out: string[] = [];
  const requests: string[] = [];
  const sessions = new Map<string, Json>();
  const eventLists = new Map<string, Json[]>();
  // --wake 的合并窗口走注入的 sleep：不等真实的时间，只把假时钟拨过去，并让测试在“窗口里”改动世界。
  const slept: number[] = [];
  let duringSleep: (() => void) | undefined;

  // `restart` 用同一份假服务再造一个看门狗：除了状态文件，它什么也不记得，和真的重启一样。
  const create = (extra: Json = {}): Json => watch.createWatcher(
    { ids: [], interval: 30, tick: 0, goneAfter: 10, forever: false, once: false, ...options, ...extra },
    {
      home: "unused",
      now: () => now,
      say: (tag: string, text: string) => out.push(`[${tag}] ${text}`),
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
        duringSleep?.();
      },
      readService: () => ({ port: 1, token: "t" }),
      ...(rules ? { rules } : {}),
      fetchJson: async (_service: Json, path: string) => {
        requests.push(path);
        if (outage) throw outage;
        if (path === "/sessions") return { sessions: [...sessions.values()] };
        if (path === "/health") {
          if (!capacity) throw new Error("health is not available");
          return { capacity };
        }
        const match = /^\/sessions\/([^/?]+)\/events\?after=(\d+)(?:&limit=(\d+))?$/.exec(path);
        if (!match) throw new Error(`unexpected request ${path}`);
        const [, id = "", after = "0", limit] = match;
        const newer = (eventLists.get(id) ?? []).filter((event) => (event["seq"] as number) > Number(after));
        return { events: limit ? newer.slice(-Number(limit)) : newer };
      },
    },
  );
  let watcher = create();

  const session = (id: string, patch: Json = {}): Json => {
    const next = { ...(sessions.get(id) ?? summary({ id, title: `Session ${id}` })), ...patch };
    sessions.set(id, next);
    return next;
  };
  const emit = (id: string, ...events: Json[]): void => {
    const list = eventLists.get(id) ?? [];
    for (const event of events) list.push({ ...event, id: `evt_${id}_${list.length + 1}`, sessionId: id, seq: list.length + 1, source: "executor" });
    eventLists.set(id, list);
    session(id, { seq: list.length });
  };

  return {
    out,
    requests,
    get watcher(): Json {
      return watcher;
    },
    restart: (extra: Json = {}): void => {
      watcher = create(extra);
    },
    slept,
    pass: () => watch.pass(watcher),
    advance: (ms: number): void => {
      now += ms;
    },
    clock: (): number => now,
    whileSleeping: (callback: (() => void) | undefined): void => {
      duringSleep = callback;
    },
    session,
    emit,
    replaceEvents: (id: string, ...events: Json[]): void => {
      eventLists.delete(id);
      emit(id, ...events);
    },
    drop: (id: string): void => {
      sessions.delete(id);
    },
    setCapacity: (value: Json | undefined): void => {
      capacity = value;
    },
    breakService: (error: Error): void => {
      outage = error;
    },
    mendService: (): void => {
      outage = undefined;
    },
    lines: (tag: string): string[] => out.filter((line) => line.startsWith(`[${tag}]`)),
    eventRequests: (): string[] => requests.filter((path) => path.includes("/events")),
  };
}

// ───────────────────────── 当作脚本跑（真实服务，真实子进程） ─────────────────────────

const services: RunningService[] = [];
const children: ChildProcess[] = [];

/** 每个用到子进程或真实服务的测试文件都要 `afterEach(cleanup)`：结束还活着的子进程、关掉起过的服务。 */
export async function cleanup(): Promise<void> {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  while (services.length > 0) await services.pop()!.close("test");
}

export const USER: Actor = { kind: "user", label: "test" };

export async function serve(): Promise<RunningService> {
  const service = await startService({
    home: mkdtempSync(join(tmpdir(), "ensemble-watch-")),
    port: 0,
    executors: [new FixtureExecutor("pi", { speed: 0 })],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
  });
  services.push(service);
  return service;
}

export const delegate = (service: RunningService, task: string) => service.manager.delegate({ harness: "pi", task, cwd: tmpdir(), origin: testOrigin(), allowDuplicate: true });

export interface Run {
  stdout(): string;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<void>;
}

export function run(args: string[], home: string): Run {
  // windowsHide：验证期间不能弹出任何控制台窗口。
  const child = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env, ENSEMBLE_HOME: home }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { stdout: () => stdout, done, waitFor: (pattern, timeoutMs = 10_000) => until(() => pattern.test(stdout), timeoutMs, `output matching ${pattern}`) };
}
