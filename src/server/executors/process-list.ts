import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@shared/format";

/**
 * 进程表：一次读出系统里的进程（pid / ppid / 创建时间 / 名字），以及在表上做的几个纯计算。
 *
 * 平台分工：Windows 的读法在 process-tree.ts（PowerShell CIM，在真实系统上验证过）；
 * Linux 与 macOS 的读法在这里——已实现并有测试，但没有在真实系统上验证过（macOS 更只是按 BSD ps 的输出格式写的）。
 * - Linux 直接读 /proc、不用 ps：最小的 Linux（BusyBox 的 ps、Alpine 容器）没有 lstart 之类的字段，/proc 到处都有。
 * - macOS 没有 /proc，只能跑 ps。
 * - 其它平台（BSD、Solaris、AIX…）不支持：listPosixProcesses 直接报错，上层据此“不清理”，不声称做了。
 *
 * 读不出、读不全、读出来对不上（自己不在表里、父进程对不上）都按“列表不可信”处理：抛错，
 * 由调用方退回“不清理”并留一条诊断，绝不猜着动手。
 *
 * 这个文件只依赖 Node 内置模块（process-kill.ts 也引用它，所以不能反过来引用 process.ts 或 process-tree.ts）。
 */

export interface ProcInfo {
  pid: number;
  ppid: number;
  /**
   * 创建时间（UTC 毫秒）。Windows 上是精确值；POSIX 上精度不到毫秒（Linux 以 /proc/stat 里整秒的 btime 为基准，
   * macOS 的 lstart 只到秒），这里取“最晚可能的创建时刻”：与 `since` 比较时宁可多算一个候选
   * （多算的由“父进程已死”那一条再筛），不能漏掉。它不用来判断“还是不是同一个进程”（见 startMark）。
   */
  created: number;
  name: string;
  /**
   * 判断“还是不是同一个进程”用的原始起始标记（POSIX 才有）：Linux 是 /proc 里的 starttime（开机后第几个时钟滴答），
   * macOS 是 lstart 换成数字后的文本。pid 会被复用，所以身份是 pid + 这个标记；
   * 不能用换算出来的 created——Linux 的 created 依赖 btime，系统时钟被校时跳变之后，同一个进程两次读出的 created 会不一样，
   * 活着的父进程就会被认成“已经没了”，进而误杀它还活着的子进程。
   */
  startMark?: string;
  /** POSIX 进程状态的首字符（R S D T Z …）；Windows 没有。 */
  state?: string;
}

/** “还是不是同一个进程”的键：pid 会被复用，所以必须带上创建标记；有原始起始标记（POSIX）用它，没有（Windows）用创建时间。 */
export const procKey = (proc: ProcInfo): string => `${proc.pid}@${proc.startMark ?? proc.created}`;

/** 根进程的所有后代（沿 ppid 向下找；有环也不会死循环）。 */
export function descendantsOf(rootPid: number, all: readonly ProcInfo[]): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const proc of all) {
    const siblings = children.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else children.set(proc.ppid, [proc]);
  }
  const found: ProcInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** 一个进程的祖先（沿 ppid 向上找，由近到远；不含它自己；断链或成环就停）。 */
export function ancestorsOf(pid: number, all: readonly ProcInfo[]): number[] {
  const parentOf = new Map<number, number>(all.map((proc) => [proc.pid, proc.ppid]));
  const found: number[] = [];
  const seen = new Set<number>([pid]);
  for (let next = parentOf.get(pid); next !== undefined && next > 0 && !seen.has(next); next = parentOf.get(next)) {
    found.push(next);
    seen.add(next);
  }
  return found;
}

/** 已经死了的状态：僵尸（Z）与已退出（X；老内核里还有小写 x）。它们不能被当成“还活着的孤儿”，也不该算进“已结束 n 个进程”。 */
const isDeadState = (state: string): boolean => state === "Z" || state === "X" || state === "x";

/** 自检用的“自己”：默认取 process.pid / process.ppid，测试里注入。 */
export interface PosixSelf {
  pid: number;
  ppid: number;
}

/**
 * 自检：表里必须有我们自己，并且它的父进程与 process.ppid 一致。否则这份表不是这个进程眼里的真实世界
 * （/proc 不是自己所在的 PID 命名空间、ps 输出格式对不上、被沙箱遮住了……），拿它做决定不可信。
 */
function assertListsSelf(procs: readonly ProcInfo[], self: PosixSelf | undefined): void {
  const expected = self ?? { pid: process.pid, ppid: process.ppid };
  const me = procs.find((proc) => proc.pid === expected.pid);
  if (!me) throw new Error(`listing processes failed: this process (pid ${expected.pid}) is not in the list, so the list cannot be trusted`);
  if (me.ppid !== expected.ppid) {
    throw new Error(`listing processes failed: the list gives this process's parent as ${me.ppid} but it is ${expected.ppid}, so the list cannot be trusted`);
  }
}

// ───────────────────────── Linux：读 /proc ─────────────────────────

/**
 * /proc 里时间的单位（USER_HZ）。在常见架构上内核对用户空间固定导出 100（等于 sysconf(_SC_CLK_TCK)），不随编译选项 CONFIG_HZ 变；
 * 没有在每种架构上核对。它错了只会让 created 按比例偏差（只影响与 since 的比较），不影响身份判断。
 */
export const LINUX_CLK_TCK = 100;
/** btime 只有整秒（向下取整），换算出的创建时间最多比真实值早这么多。 */
const BTIME_RESOLUTION_MS = 1_000;
/** 进程多的机器上读 /proc 时每读这么多条让出一次事件循环，不至于卡住服务。 */
const YIELD_EVERY = 256;

export interface LinuxStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  /** 进程启动于系统启动之后的第几个时钟滴答（原始值）。 */
  startTicks: number;
}

/**
 * 解析 /proc/<pid>/stat：`pid (comm) state ppid pgrp session tty_nr tpgid flags … starttime(第 22 个字段) …`。
 * comm 可能含空格与括号（甚至换行），所以以第一个 "(" 与最后一个 ")" 为界：括号之后的字段全是数字或单个状态字母，不会再有 ")"。
 * 内容不完整（被截断、字段不够、数字坏了）返回 undefined。
 */
export function parseLinuxStat(content: string): LinuxStat | undefined {
  const open = content.indexOf("(");
  const close = content.lastIndexOf(")");
  if (open <= 0 || close < open) return undefined;
  const pidText = content.slice(0, open).trim();
  if (!/^\d+$/.test(pidText)) return undefined;
  // fields[0] 是第 3 个字段（state），第 n 个字段对应 fields[n - 3]：ppid 是第 4 个，starttime 是第 22 个（fields[19]）。
  // 要求 starttime 后面至少还有一个字段，才能确认 starttime 这一项本身没被截断。
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const [state = "", ppidText = ""] = fields;
  const startText = fields[19] ?? "";
  if (fields.length < 21 || !/^[A-Za-z]$/.test(state) || !/^\d+$/.test(ppidText) || !/^\d+$/.test(startText)) return undefined;
  const pid = Number(pidText);
  const ppid = Number(ppidText);
  const startTicks = Number(startText);
  if (![pid, ppid, startTicks].every(Number.isSafeInteger)) return undefined;
  return { pid, comm: content.slice(open + 1, close), state, ppid, startTicks };
}

/** /proc/stat 里的 `btime <秒>`：开机时刻（Unix 秒，整秒）。 */
function parseBootSeconds(text: string): number {
  const match = /^btime\s+(\d+)\s*$/m.exec(text);
  const seconds = Number(match?.[1]);
  if (!Number.isSafeInteger(seconds)) throw new Error("btime is missing from the proc stat file");
  return seconds;
}

function readLinuxStat(root: string, name: string): LinuxStat | undefined {
  let content: string;
  try {
    content = readFileSync(join(root, name, "stat"), "utf8");
  } catch (error) {
    // 进程在 readdir 与读取之间退出了：只跳过这一条。别的错误（EMFILE、EIO、权限…）说明没有读全，
    // 不能当成“这个进程已经没了”（父进程读丢了，它还活着的子进程就会被当成孤儿），让整份列表失败。
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
  // 进程正在退出时可能读到空内容或半截内容：同样只跳过这一条。stat 里的 pid 必须与目录名一致，否则不是我们要的那一份。
  const parsed = parseLinuxStat(content);
  return parsed && String(parsed.pid) === name ? parsed : undefined;
}

export interface LinuxListOptions {
  /** /proc 的位置；测试里指向一个临时目录搭的假 /proc。 */
  procRoot?: string;
  clockTicks?: number;
  self?: PosixSelf;
}

/**
 * 读 /proc 列出所有进程（排除僵尸与已退出的）。
 * 创建时间 = btime + starttime / CLK_TCK（再按上面说的取最晚可能的时刻）；身份用原始的 starttime（startMark）。
 */
export async function listLinuxProcesses(options: LinuxListOptions = {}): Promise<ProcInfo[]> {
  const root = options.procRoot ?? "/proc";
  const ticks = options.clockTicks ?? LINUX_CLK_TCK;
  const procs: ProcInfo[] = [];
  try {
    const bootMs = parseBootSeconds(readFileSync(join(root, "stat"), "utf8")) * 1000;
    const names = (await readdir(root)).filter((name) => /^\d+$/.test(name));
    for (const [index, name] of names.entries()) {
      if (index > 0 && index % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const stat = readLinuxStat(root, name);
      if (!stat || isDeadState(stat.state)) continue;
      procs.push({
        pid: stat.pid,
        ppid: stat.ppid,
        // btime 向下取整到秒、starttime 向下取整到滴答：真实创建时刻不晚于 “基准 + 这两个精度”。
        created: bootMs + Math.floor((stat.startTicks * 1000) / ticks) + BTIME_RESOLUTION_MS + Math.ceil(1000 / ticks),
        name: stat.comm,
        startMark: String(stat.startTicks),
        state: stat.state,
      });
    }
  } catch (error) {
    throw new Error(`listing processes failed: ${errorMessage(error)}`);
  }
  assertListsSelf(procs, options.self);
  return procs;
}

// ───────────────────────── macOS：跑 ps ─────────────────────────

/**
 * 对 BSD ps 输出格式的假设（没有在真实的 macOS 上核对过）：
 * - `ps -axww -o pid=,ppid=,stat=,lstart=,comm=`：每个进程一行；`=` 把各列的表头清空（没清掉的表头行解析不出来，会被跳过）；`-ww` 不限宽度，不截断。
 * - 前三列是十进制 pid、ppid 和状态串（首字符是状态字母：R S I U T Z…；Z 是僵尸）。
 * - 环境固定 LC_ALL=C 时，lstart 恰好是五个词 `星期 月份 日 时:分:秒 年`（strftime 的 %c：`Sat Nov 21 14:03:05 2026`），
 *   英文三字母月份；日期 %e 是空格补位，所以个位数日期前面是两个空格（`Sun Nov  1 09:05:07 2026`）；
 *   本地时间（与我们同一个 TZ），只精确到秒（向下取整）。
 * - comm 在最后一列，可以含空格（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），是可执行文件路径或名字；我们取最后一个 `/` 之后的部分当名字。
 */
const MAC_PS_ARGS = ["-axww", "-o", "pid=,ppid=,stat=,lstart=,comm="];
const MAC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAC_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+?)\s*$/;
/** lstart 向下取整到秒：真实创建时刻不晚于 “这一秒 + 999 毫秒”。 */
const MAC_LSTART_SLACK_MS = 999;

/** 解析 `ps -axww -o pid=,ppid=,stat=,lstart=,comm=` 的输出；空行、表头与对不上格式的行跳过，僵尸（状态 Z / X）不要。 */
export function parseMacProcessList(text: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = MAC_LINE.exec(line);
    if (!match) continue;
    const [, pidText = "", ppidText = "", stat = "", month = "", day = "", hour = "", minute = "", second = "", year = "", command = ""] = match;
    const monthIndex = MAC_MONTHS.indexOf(month);
    const local = new Date(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second)).getTime();
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (monthIndex < 0 || !Number.isFinite(local) || !Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || stat === "" || command === "") continue;
    const state = stat.slice(0, 1);
    if (isDeadState(state)) continue;
    const slash = command.lastIndexOf("/");
    procs.push({
      pid,
      ppid,
      created: local + MAC_LSTART_SLACK_MS,
      name: slash >= 0 && slash < command.length - 1 ? command.slice(slash + 1) : command,
      // 身份只用数字拼成的起始时刻（不受空格补位之类的排版影响）。
      startMark: `${Number(year)}-${monthIndex + 1}-${Number(day)} ${Number(hour)}:${minute}:${second}`,
      state,
    });
  }
  return procs;
}

/** 跑一次 ps 取文本（macOS）。用绝对路径，免得 PATH 里排在前面的是别的 ps；LC_ALL=C 保证英文月份与星期。 */
export function runMacPs(timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", MAC_PS_ARGS, { env: { ...process.env, LC_ALL: "C" }, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`listing processes failed: ${error.message}`));
      else resolve(stdout);
    });
  });
}

export interface MacListOptions {
  /** 运行 ps 并返回文本；测试里注入样例输出。 */
  runPs?: () => Promise<string>;
  self?: PosixSelf;
}

export async function listMacProcesses(options: MacListOptions = {}): Promise<ProcInfo[]> {
  const procs = parseMacProcessList(await (options.runPs ?? (() => runMacPs()))());
  assertListsSelf(procs, options.self);
  return procs;
}

// ───────────────────────── 入口 ─────────────────────────

/** 列出当前平台的所有进程：Linux 读 /proc，macOS 跑 ps，其它平台报错（不声称支持）。 */
export function listPosixProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcInfo[]> {
  if (platform === "linux") return listLinuxProcesses();
  if (platform === "darwin") return listMacProcesses();
  return Promise.reject(new Error(`listing processes failed: ${platform} is not supported`));
}
