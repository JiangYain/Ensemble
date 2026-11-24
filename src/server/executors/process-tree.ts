import { execFile } from "node:child_process";
import { killTree } from "./process";
import { describeFailure, killPosixTree, type KillDeps } from "./process-kill";
import { descendantsOf, listPosixProcesses, procKey, type ProcInfo } from "./process-list";

// ProcInfo 与 descendantsOf 搬到了 process-list.ts（POSIX 的读表与结束进程树也要用，放在这里会形成循环引用）；这里原样转出，现有的引用不用改。
export { descendantsOf };
export type { ProcInfo };

/**
 * 取消之后清理“被遗弃的工具子进程”。
 *
 * 缘由（dsh 0.2.2-rc.1 · Windows 11 实测）：session/cancel 能让这一轮在几十毫秒内以 cancelled 结束、会话照常可用，
 * 但 dsh 只结束执行工具的那层 shell，shell 之下启动的进程（ping、cmd /c、再 spawn 的 node、Start-Process、Start-Job 共 5 种写法）
 * 全部成了孤儿继续跑。取消的意义是让它们停下来，所以在取消前后各看一次进程表，把这次取消留下的孤儿结束掉。
 *
 * 边界（宁可漏掉也不误杀）：
 * - 只动“取消之前是 dsh 的后代、取消之后父进程已经没了”的进程：父进程还活着的（dsh 自己的子进程、它管理的后台作业）一律不碰；
 *   “父进程已经没了”看的是快照里记的父进程现在还在不在，不看这个进程现在的 ppid：POSIX 上孤儿会被 init 或 subreaper 收养（ppid 变成 1），
 *   Windows 上 ppid 则保持不变，这个判断对两边都成立；
 * - 只动晚于“最早一个进行中的工具调用”创建的进程：更早的工具留下的后台进程是模型有意起的，不算这次取消的后果；
 * - 判断进程是否还是同一个，要 pid 与创建标记都对得上（pid 会被系统复用）：Windows 用创建时间，
 *   POSIX 用 /proc 的 starttime 滴答 / ps 的 lstart（见 process-list.ts；不用换算出来的墙钟时间，系统时钟被校时跳变后它会变）；
 * - conhost.exe 是系统给控制台程序配的，不是工具启动的，不动（它只属于 Windows，POSIX 上没有找到等价物，所以不另设名单）；
 * - 任何无法确认的情形（读不了进程表、自己不在表里、父进程对不上）都退回“不清理”，由上层记一条诊断，绝不猜着动手。
 *
 * 平台现状：
 * - Windows：孤儿现象与清理都在真实系统上用真实 dsh 验证过。
 * - Linux、macOS：已实现（Linux 读 /proc，macOS 跑 ps；结束整棵进程树见 process-kill.ts），有用假 /proc、假 ps 输出与真实进程树做的测试，
 *   但没有在真实系统上验证过；dsh 与 OpenCode 在这两个系统上是否真的会留下孤儿也没有观察过——清理只在“有孤儿”时动手，没有孤儿就什么都不做。
 * - 其它平台（BSD、Solaris、AIX 等）：defaultProcessTools 返回 undefined，不清理，也不声称做了。
 */

export interface ProcessTools {
  list(): Promise<ProcInfo[]>;
  /**
   * 结束这个进程及其所有后代。`expected` 是调用方读表时看到的这个进程：POSIX 的实现据此再核对一次身份（pid 已被别的进程用了就不动）；
   * Windows 的实现用不上它。
   */
  kill(pid: number, expected?: ProcInfo): Promise<void>;
}

/**
 * 工具调用开始的时间戳是我们收到通知的时刻，进程可能比它早创建几十毫秒；留出余量，但不能大到把上一个工具的产物也算进来。
 * POSIX 上进程的创建时间精度不到毫秒（Linux 基于整秒的 btime，macOS 的 lstart 只到秒），process-list.ts 已经把它取成“最晚可能的创建时刻”，
 * 与这里的余量叠加后，候选只会多不会少；多出来的那些由“父进程已经没了”这一条再筛。
 */
export const SWEEP_MARGIN_MS = 1_000;

/** 系统替工具进程配的辅助进程，不是工具启动的：conhost.exe 只属于 Windows；POSIX 上没有找到等价物，不另设名单（没有依据的名字不加）。 */
const IGNORED_NAMES = new Set(["conhost.exe"]);
const FILETIME_UNIX_OFFSET_MS = 11_644_473_600_000;

const key = procKey;

/** `pid|ppid|FILETIME|name` 每行一条（见 LIST_SCRIPT）；FILETIME 是 1601 年起的 100 纳秒数。 */
export function parseProcessList(stdout: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\|(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
    if (!match) continue;
    const ticks = BigInt(match[3] ?? "0");
    procs.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      created: ticks === 0n ? 0 : Number(ticks / 10_000n) - FILETIME_UNIX_OFFSET_MS,
      name: (match[4] ?? "").trim(),
    });
  }
  return procs;
}

/** 取消前对 dsh 进程树拍的快照。 */
export interface TreeSnapshot {
  /** 候选：晚于 since 创建的后代（已去掉 conhost）。 */
  members: ProcInfo[];
  /** 根进程与它的全部后代，按 pid 索引，用来查候选的父进程是谁。 */
  known: Map<number, ProcInfo>;
}

export async function snapshotTree(rootPid: number, since: number, tools: ProcessTools): Promise<TreeSnapshot> {
  const all = await tools.list();
  const root = all.find((proc) => proc.pid === rootPid);
  const descendants = descendantsOf(rootPid, all);
  const known = new Map<number, ProcInfo>(descendants.map((proc) => [proc.pid, proc]));
  if (root) known.set(root.pid, root);
  const members = descendants.filter((proc) => proc.created >= since - SWEEP_MARGIN_MS && !IGNORED_NAMES.has(proc.name.toLowerCase()));
  return { members, known };
}

export interface SweepResult {
  killed: ProcInfo[];
  failed: { proc: ProcInfo; error: string }[];
}

/** 取消完成后调用：结束快照里“仍然活着、父进程已经没了”的进程。 */
export async function sweepOrphans(snapshot: TreeSnapshot, tools: ProcessTools): Promise<SweepResult> {
  const result: SweepResult = { killed: [], failed: [] };
  if (snapshot.members.length === 0) return result;
  const alive = new Set((await tools.list()).map(key));
  const orphans = snapshot.members.filter((member) => {
    if (!alive.has(key(member))) return false;
    const parent = snapshot.known.get(member.ppid);
    // 父进程不在快照里（不该发生）就不动它。
    return parent !== undefined && !alive.has(key(parent));
  });
  for (const orphan of orphans) {
    try {
      // 带上快照里看到的样子：POSIX 的实现用它再核对一次身份，并据此知道目标已被系统收养、不再是我们的后代也可以动。
      await tools.kill(orphan.pid, orphan);
      result.killed.push(orphan);
    } catch (error) {
      result.failed.push({ proc: orphan, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

// ───────────────────────── Windows 实现 ─────────────────────────

const LIST_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.Name }";

/** 用 CIM 列出所有进程（一次约 0.5–2 秒，机器繁忙时更久）。 */
export function listWindowsProcesses(timeoutMs = 8_000): Promise<ProcInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`listing processes failed: ${error.message}`));
          return;
        }
        const procs = parseProcessList(stdout);
        if (procs.length === 0) reject(new Error("listing processes returned nothing"));
        else resolve(procs);
      },
    );
  });
}

// ───────────────────────── Linux / macOS 实现（已实现，未在真实系统上验证） ─────────────────────────

/**
 * Linux 读 /proc、macOS 跑 ps 列出进程（见 process-list.ts），结束时按 process-kill.ts 的冻结收敛结束整棵树。
 * `overrides` 让测试换成模拟的进程世界（假的列表、信号与时钟）。
 *
 * kill 只要有任何一个进程没能结束（权限不够、SIGKILL 之后仍在）或出于安全拒绝动手（读不了表、目标是自己的祖先……）就抛错：
 * 清理的单位是“这个孤儿和它的后代”，让 sweepOrphans 把它记进 failed、上层如实上报“没清掉”，而不是当成功。
 * 目标已经不在了（比如在两次读表之间自己退出）不算失败。
 */
export function posixProcessTools(platform: "linux" | "darwin", overrides: Partial<KillDeps> = {}): ProcessTools {
  const list = overrides.list ?? (() => listPosixProcesses(platform));
  return {
    list,
    kill: async (pid, expected) => {
      const result = await killPosixTree(pid, expected ? { expect: expected } : {}, { ...overrides, list });
      if (result.failed.length > 0) throw new Error(result.failed.map(describeFailure).join("; "));
    },
  };
}

/**
 * 当前平台能做孤儿清理时返回工具集：win32 用 CIM 与 taskkill；linux、darwin 用 POSIX 实现；
 * 其它平台（freebsd、sunos、aix 等）返回 undefined——不清理，也不声称做了。`platform` 可注入，默认当前平台。
 */
export function defaultProcessTools(platform: NodeJS.Platform = process.platform): ProcessTools | undefined {
  if (platform === "win32") return { list: () => listWindowsProcesses(), kill: (pid) => killTree(pid) };
  if (platform === "linux" || platform === "darwin") return posixProcessTools(platform);
  return undefined;
}
