/**
 * 仅供测试使用：在 Linux / macOS 上起一棵真实的 node 进程树，并在测试结束时清理。
 *
 * - 只用 process.execPath 起进程，不依赖 sh、sleep 之类外部命令的细节；
 * - 每个进程启动后把自己的 pid 与起始标记写进日志（一行一个 JSON）；
 * - 清理只结束“日志里记着的、起始标记没变”的进程——起始标记用这里自带的读法（Linux 读 /proc/<pid>/stat，macOS 跑 ps），
 *   不借助被测代码，pid 被别的进程复用时标记对不上，绝不会误杀无关进程；
 * - 所有进程都有自己的寿命上限（默认 120 秒，短命的 6 秒），万一清理没做成也不会一直留下。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 真实进程树测试能在这个平台上跑（process-tree.ts 的默认工具也只在 Linux 与 macOS 上有 POSIX 实现）。 */
export const CAN_RUN_REAL_TREES = process.platform === "linux" || process.platform === "darwin";

const PS_ENV = { ...process.env, LC_ALL: "C" };

/** 进程的起始标记：Linux 是 /proc 里的 starttime，macOS 是 ps 的 lstart；读不到（进程已经不在了）返回 undefined。 */
export function startMarkOf(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
    }
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: PS_ENV, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** 进程是否还在运行：已死、还没被回收的僵尸不算（没有会回收孤儿的 init 的容器里，被杀掉的孤儿会一直是僵尸，kill(pid, 0) 却仍然成功）。 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    if (process.platform === "linux") {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = text.charAt(text.lastIndexOf(")") + 2);
      return state !== "Z" && state !== "X" && state !== "x";
    }
    if (process.platform === "darwin") {
      const stat = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", env: PS_ENV, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return stat !== "" && !stat.startsWith("Z");
    }
  } catch {
    // 读的时候进程刚好没了。
    return false;
  }
  return true;
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 只在起始标记没变（还是当初那个进程）时才结束它。 */
export function killIfSame(pid: number, mark: string | undefined): void {
  if (!mark || startMarkOf(pid) !== mark) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经退出。
  }
}

/**
 * 树里每个进程运行的脚本（CommonJS：仓库是 ESM，.cjs 才能 require）。参数：日志文件、标签、剩余深度、模式。
 * - plain：每层起两个子进程，直到深度用完，然后空转；
 * - stubborn：同 plain，但忽略 SIGTERM（用来检验温和结束的宽限与强制）；
 * - storm：根每 40 毫秒起一个短命的子进程，共 10 个（用来检验结束过程中还在 fork 的树）；
 * - brief：storm 的子进程，6 秒后自己退出。
 */
const TREE_SCRIPT = `"use strict";
const { spawn, execFileSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");
const [logFile, label, depthText, mode] = process.argv.slice(2);

function startMark() {
  try {
    if (process.platform === "linux") {
      const text = readFileSync("/proc/self/stat", "utf8");
      return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
    }
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  } catch {
    return "";
  }
}

appendFileSync(logFile, JSON.stringify({ label, pid: process.pid, mark: startMark() }) + "\\n");
if (mode === "stubborn") process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), mode === "brief" ? 6000 : 120000).unref();

const spawnChild = (suffix, depth, childMode) =>
  spawn(process.execPath, [__filename, logFile, label + suffix, String(depth), childMode], { stdio: "ignore" });
const depth = Number(depthText);
if (mode === "storm") {
  let count = 0;
  const timer = setInterval(() => {
    if (count >= 10) {
      clearInterval(timer);
      return;
    }
    count += 1;
    spawnChild("s" + count, 0, "brief");
  }, 40);
} else if (depth > 0) {
  spawnChild("a", depth - 1, mode);
  spawnChild("b", depth - 1, mode);
}
setInterval(() => {}, 1000);
`;

export type TreeMode = "plain" | "stubborn" | "storm";

interface LogEntry {
  label: string;
  pid: number;
  mark: string;
}

function readLog(log: string): LogEntry[] {
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // 正在写的半行。
    }
  }
  return entries;
}

export interface RealTree {
  /** 根进程（标签 "r"）。 */
  rootPid: number;
  /** 日志里已经记下的进程：标签 → pid。plain / stubborn：根 "r"，子 "ra"、"rb"，孙 "raa"、"rab"、"rba"、"rbb"……；storm：根 "r"，子 "rs1"……。 */
  pids(): Map<string, number>;
}

const trees: { dir: string; log: string }[] = [];
const extras: { pid: number; mark: string }[] = [];

/**
 * 起一棵树并等它全部启动（日志里有齐所有进程）。depth 是层数：0 只有根，1 有根加两个子，2 有根、两个子、四个孙。
 * 树里的进程都是调用者（vitest 的工作进程）的后代。
 */
export async function startTree(depth: number, mode: TreeMode = "plain"): Promise<RealTree> {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-tree-"));
  const script = join(dir, "tree.cjs");
  const log = join(dir, "pids.jsonl");
  writeFileSync(script, TREE_SCRIPT);
  writeFileSync(log, "");
  trees.push({ dir, log });
  const root = spawn(process.execPath, [script, log, "r", String(depth), mode], { stdio: "ignore" });
  root.unref();
  if (root.pid === undefined) throw new Error("could not start the root of the process tree");
  const pids = (): Map<string, number> => new Map(readLog(log).map((entry) => [entry.label, entry.pid] as const));
  const expected = mode === "storm" ? 1 : 2 ** (depth + 1) - 1;
  await waitFor(() => pids().size >= expected, 30_000, `${expected} process(es) of the tree to start`);
  return { rootPid: root.pid, pids };
}

/** 一个与任何树都无关的进程：用来证明清理没有误伤旁人。返回它的 pid。 */
export function startBystander(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120000).unref();"], { stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("could not start the bystander process");
  const mark = startMarkOf(child.pid);
  if (mark) extras.push({ pid: child.pid, mark });
  return child.pid;
}

/** 每个测试之后调用：结束日志里记着的、仍是当初那个进程的所有进程（根最先），删掉临时目录。 */
export function cleanupRealProcesses(): void {
  for (const { dir, log } of trees.splice(0)) {
    for (const entry of readLog(log)) killIfSame(entry.pid, entry.mark);
    rmSync(dir, { recursive: true, force: true });
  }
  for (const entry of extras.splice(0)) killIfSame(entry.pid, entry.mark);
}
