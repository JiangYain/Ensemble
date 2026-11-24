import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sliceTail } from "@shared/safe-slice";
import { killPosixTree, type KillTreeOptions } from "./process-kill";

/**
 * 子进程与 JSONL 通道的公共工具。
 * 两个原生执行端（Pi RPC、Codex app-server）都是“子进程 + 每行一个 JSON”的协议，
 * 必须只按 \n 切分——Node 的 readline 还会按 U+2028 / U+2029 切分，会破坏合法的 JSON 字符串。
 */

function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    const rest = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    buffer = "";
    if (rest.length > 0) onLine(rest);
  });
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** spawn 本身失败（例如可执行文件不存在）时的错误。 */
  error?: Error;
  stderrTail: string;
}

export interface JsonlProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly exited: boolean;
  send(message: unknown): boolean;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (info: ExitInfo) => void): void;
  stderrTail(): string;
  kill(): Promise<void>;
}

export interface SpawnJsonlOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onNonJson?: (line: string) => void;
}

const STDERR_TAIL_BYTES = 6_000;

export function spawnJsonl(command: string, args: readonly string[], options: SpawnJsonlOptions): JsonlProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const messageListeners: ((message: unknown) => void)[] = [];
  const exitListeners: ((info: ExitInfo) => void)[] = [];
  let stderr = "";
  let exited = false;
  let spawnError: Error | undefined;
  let exitInfo: ExitInfo | undefined;

  attachJsonlReader(child.stdout, (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      options.onNonJson?.(line);
      return;
    }
    for (const listener of messageListeners) listener(parsed);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = sliceTail(stderr + chunk, STDERR_TAIL_BYTES);
  });
  // stdin 在子进程退出后写入会触发 EPIPE，这里吞掉，由退出事件统一上报。
  child.stdin.on("error", () => undefined);

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    exitInfo = { code, signal, stderrTail: stderr, ...(spawnError ? { error: spawnError } : {}) };
    for (const listener of exitListeners) listener(exitInfo);
  };
  child.on("error", (error) => {
    spawnError = error;
    finish(null, null);
  });
  child.on("close", (code, signal) => finish(code, signal));

  const handle: JsonlProcess = {
    child,
    get pid() {
      return child.pid;
    },
    get exited() {
      return exited;
    },
    send(message) {
      if (exited || !child.stdin.writable) return false;
      // write() 返回 false 只表示内部缓冲超过了高水位（例如超过 16KB 的委派提示），数据仍会被完整写出；
      // 这里的返回值只表示“进程还活着、消息已提交”，不能把背压当成失败。
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onExit(listener) {
      if (exitInfo) listener(exitInfo);
      else exitListeners.push(listener);
    },
    stderrTail: () => stderr,
    async kill() {
      if (exited) return;
      child.stdin.end();
      const closed = await waitForExit(handle, 900);
      // POSIX 上保留先 SIGTERM 的温和一步（旧实现本来就有）：走到这里说明对方关了 stdin 还不退，
      // SIGTERM 给带信号处理的 CLI 一次落盘的机会；Windows 的 taskkill /F 没有这一步，忽略这个选项。
      if (!closed) await killTree(child.pid, { graceMs: 1_500 });
      await waitForExit(handle, 3_000);
    },
  };
  return handle;
}

function waitForExit(proc: JsonlProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.onExit(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 结束整个进程树（工具子进程不会随父进程自动退出）。永不抛错。
 * - Windows：`taskkill /pid <pid> /T /F`，强制且立刻；已在真实系统上验证。`options` 被忽略，Windows 上的行为与时序不变。
 * - Linux / macOS：读进程表找出后代，冻结（SIGSTOP）到收敛后统一 SIGKILL，默认同样强制、不拖延（见 process-kill.ts）；
 *   `graceMs` > 0 时先对整棵树发 SIGTERM 并最多等这么久，仍活着的再强制结束。已实现，未在真实系统上验证。
 *   读不了进程表（包括 BSD、Solaris 等没有实现读表的系统）时退回只对这一个 pid 发信号（和旧实现一样不动后代；但默认直接 SIGKILL，不再先 SIGTERM 等 1.5 秒，传了 `graceMs` 才有那一步），
 *   不声称结束了整棵树。
 */
export async function killTree(pid: number | undefined, options: KillTreeOptions = {}): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }
  try {
    await killPosixTree(pid, options);
  } catch {
    // killPosixTree 自己不抛错，这里只是兜底：调用方（关闭、取消路径）都是尽力而为，没有 try/catch。
  }
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

/** 运行一次性命令并收集输出（探测版本用）。带超时，超时会结束整个进程树。 */
export function runCapture(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<CaptureResult, "stdout" | "stderr" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child.pid).then(() => finish({ code: null }));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = sliceTail(stdout + chunk, 64_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = sliceTail(stderr + chunk, 16_000);
    });
    child.on("error", (error) => finish({ code: null, error }));
    child.on("close", (code) => finish({ code }));
  });
}

// ───────────────────────── 可执行文件定位 ─────────────────────────

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env["PATH"] ?? env["Path"] ?? "";
  return raw.split(delimiter).filter((entry) => entry.length > 0);
}

/**
 * 在 PATH 中找到 npm 全局安装的命令，并返回它指向的 JS 入口。
 * Windows 上 npm 生成的是 .cmd / .ps1 垫片，直接 spawn .cmd 很脆弱，
 * 所以解析垫片里的 node_modules 路径，改为用 node 直接运行入口。
 */
export function resolveNpmCommandEntry(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of pathEntries(env)) {
    if (process.platform === "win32") {
      const shim = join(dir, `${command}.cmd`);
      if (!existsSync(shim)) continue;
      const text = readFileSync(shim, "utf8");
      const match = /"%dp0%[\\/]+(node_modules[^"]+?\.js)"/i.exec(text);
      if (match?.[1]) {
        const entry = join(dir, match[1]);
        if (existsSync(entry)) return entry;
      }
    } else {
      const candidate = join(dir, command);
      if (!existsSync(candidate)) continue;
      try {
        const real = realpathSync(candidate);
        if (real.endsWith(".js") || real.endsWith(".mjs")) return real;
      } catch {
        // 继续尝试下一个目录。
      }
    }
  }
  return undefined;
}

/** 在 PATH 中寻找第一个存在的可执行文件（按给定文件名顺序）。 */
export function findExecutableOnPath(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of pathEntries(env)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 在目录下（限深度）寻找指定文件名。 */
export function findFile(root: string, fileName: string, maxDepth = 6): string | undefined {
  const walk = (dir: string, depth: number): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === fileName) return join(dir, entry.name);
    }
    if (depth >= maxDepth) return undefined;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = walk(join(dir, entry.name), depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(root, 0);
}
