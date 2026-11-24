import { errorMessage } from "@shared/format";
import { ancestorsOf, descendantsOf, listPosixProcesses, procKey, type ProcInfo } from "./process-list";

/**
 * POSIX（Linux、macOS）上结束整棵进程树。已实现并有测试，但没有在真实系统上验证过。
 *
 * 为什么要有它：Windows 上 `taskkill /T /F` 一条命令就结束整棵树（已在真实系统上验证）；POSIX 的 kill 只认单个 pid（或整个进程组），
 * 旧实现只对这一个 pid 发 SIGTERM，它的后代原样留下。OpenCode 取消时的“先杀 shell 工具的树再中断”、dsh 的关闭、
 * 之后取消清理孤儿都依赖“结束整棵树”这个语义。
 *
 * 做法（冻结 → 收敛 → 强制结束 → 确认）：
 * 1. 读进程表，沿 ppid 找出目标的全部后代，逐个核对身份（pid + 起始标记，pid 会被复用）。
 * 2. 对找到的进程发 SIGSTOP 冻结，再读一遍表，把新出现的后代也冻结，直到一轮里没有新进程、并且已冻结的都在表里显示为停止状态。
 *    进程表只是快照，结束过程中后代还会 fork：不冻结的话，“列表 → 发 SIGKILL”之间 fork 出来的子进程会漏网（构建、测试这类工具每秒起很多进程，
 *    取消它们正是最常见的场景）；被冻结的进程不能再 fork，而 SIGKILL 不能被阻塞或忽略，对停止的进程照样生效（POSIX 的约定，没有在每个系统上核对）。
 * 3. 统一 SIGKILL（冻结后顺序无所谓）。
 * 4. 等它们真正消失：先用 kill(pid, 0) 便宜地轮询；僵尸（已死、还没被回收）会被它当成活着，所以轮询超过 100 毫秒仍有进程“存在”时改读进程表确认（僵尸不在表里）。
 *
 * 上限（取舍）：
 * - 冻结最多 MAX_FREEZE_ROUNDS 轮、总共不超过 FREEZE_BUDGET_MS：树不再长的时候两轮就收敛（第一轮冻结，第二轮确认没有新进程、已冻结的都已停止）。
 *   超过说明这棵树 fork 得比我们冻结得还快（fork 风暴），继续追下去只会拖慢取消：不再追，带着已知的进程直接结束，并在结果里标出 converged=false。
 * - 冻结期间无论怎么出错（读不了表、不该发生的异常）都会照常走到第 3 步：已冻结的进程绝不能留在停止状态。
 * - 整个函数的耗时 ≈ 首次读表 + 冻结阶段（≤ FREEZE_BUDGET_MS）+ 等待消失（≤ EXIT_WAIT_MS，期间读表确认的次数见 ZOMBIE_CHECK_*）。读表本身 Linux 读 /proc，macOS 跑 ps，没有实测耗时。
 *
 * 强制与温和：
 * - 默认强制、不拖延，与 Windows 的 taskkill /F 对齐：取消路径（opencode-shells、清理孤儿）与 dsh 运行中关闭都用它。
 *   旧实现的“SIGTERM、等 1.5 秒、再 SIGKILL”会让不肯退出的根进程多留最多 1.5 秒，而 OpenCode 取消时是等根进程消失才发中断的（见 opencode-shells.ts），宽限只会把那一刻往后推。
 * - `graceMs > 0` 时先对整棵树发 SIGTERM，最多等这么久（全部退出就提前结束），仍活着的再按上面的办法强制结束。
 *   只有进程自己的关闭（spawnJsonl.kill：已经先关了 stdin 等过 900 毫秒）用它：到那一步说明对方卡住了，SIGTERM 还给了带信号处理的 CLI 一次落盘的机会，
 *   这是 Windows 上没有的；旧实现在 POSIX 上本来就有这一步，保留它不算倒退。
 *
 * 安全（宁可漏掉也不误杀）：
 * - 只对读表时看到的进程发信号；身份是 pid + 起始标记（见 ProcInfo.startMark），每一轮重新核对。内核没有“起始标记对得上才发信号”的原子操作，
 *   读表到发信号之间有几毫秒的窗口；对已冻结的进程这个窗口不存在（停止的进程不会退出，pid 也就不会被回收复用）。
 * - 绝不对 pid ≤ 1、自己、自己的祖先发信号（BFS 在这些进程处也不会继续往下走）；目标本身是自己或祖先就整个拒绝。
 * - 没有 `expect` 时，目标必须是自己的后代（调用方的目标都是自己起的子进程或它们的后代）；清理孤儿时目标早已被系统收养，不再是后代，
 *   由调用方带着取消前的快照里看到的样子（`expect`）来证明身份。
 * - 读不了表：带 `expect` 的一律不动；没有 `expect` 的退回“只对这一个 pid 发信号”（和旧实现一样不动后代，但默认直接 SIGKILL），并如实标出没有处理后代。
 *   读到了表、但表里没有自己（这份表不是这个进程眼里的世界，祖先无从得知）：一律拒绝，不发任何信号。
 * - ESRCH（已经没了）吞掉；EPERM 等其它错误如实记进 failed，不当成功。结果里的 failed 由调用方决定要不要上报；killTree 本身永不抛错。
 *
 * 没有让 spawn 出来的执行端自成进程组（detached）：那样可以 kill(-pgid) 一次结束整组、没有 fork 竞态，
 * 但会改变 Ctrl+C 与服务崩溃时的行为（子进程不再随终端信号退出，服务崩溃时更容易留下孤儿），逃出进程组的（setsid、守护化）照样漏掉，
 * 所以保持现状，作为待决定项留给用户。
 */

export interface KillTreeOptions {
  /** > 0：先对整棵树发 SIGTERM 并最多等这么久（毫秒），仍活着的再强制结束；缺省或 0 = 直接强制。Windows 的 taskkill /F 本来就是强制的，忽略它。 */
  graceMs?: number;
  /**
   * 调用方读表时看到的这个进程。给了就再核对一遍身份（pid + 起始标记），对不上说明 pid 已被别的进程用了：什么都不动；
   * 同时因为身份已经证明，目标不必是自己的后代（清理孤儿时它早已被系统收养）。
   */
  expect?: ProcInfo;
}

export interface KillFailure {
  pid: number;
  name?: string;
  reason: string;
}

export interface KillResult {
  /** 确认已经结束的进程。 */
  killed: ProcInfo[];
  /** 没能结束的进程，或者出于安全拒绝动手的原因（拒绝时 pid 是目标本身）。 */
  failed: KillFailure[];
  /** 冻结在轮数 / 时间上限内收敛了（最后一轮没有新进程）。false 表示这棵树在不停 fork，可能有漏网的新后代。 */
  converged: boolean;
}

/** 可注入的外界：测试里换成模拟的进程世界与虚拟时钟。 */
export interface KillDeps {
  list(): Promise<ProcInfo[]>;
  /** 发信号；失败时抛带 code 的错误（与 process.kill 一致）。信号 0 只探测进程是否存在。 */
  signal(pid: number, signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  selfPid: number;
  /** 自己的父进程：读不了表时唯一能用来避免误伤宿主的依据。 */
  parentPid: number;
}

/** 冻结最多这么多轮（每轮 = 读一次表 + 对新发现的进程发 SIGSTOP）。典型的树 2 轮收敛；连续 6 轮都有新进程说明在 fork 风暴。 */
export const MAX_FREEZE_ROUNDS = 6;
/** 冻结阶段的总耗时上限（在两轮之间检查；单次读表不会被打断，读表自己有超时）。 */
export const FREEZE_BUDGET_MS = 3_000;
/** 两轮之间等 SIGSTOP 生效的时间：信号发出后进程不一定立刻进入停止状态。 */
export const STOP_SETTLE_MS = 5;
/** SIGKILL 之后等进程消失的时限与轮询间隔。 */
export const EXIT_WAIT_MS = 300;
export const EXIT_POLL_MS = 10;
/** 温和结束时轮询的间隔。 */
export const GRACE_POLL_MS = 25;
/**
 * 等进程消失时先用 kill(pid, 0) 便宜地轮询，但它把僵尸（已死、还没被父进程或 init 回收）当成活着——
 * 没有会回收孤儿的 init 的容器里，被杀掉的孤儿会一直是僵尸。所以轮询超过 ZOMBIE_CHECK_AFTER_MS 仍有进程“存在”时改读进程表确认（僵尸不在表里），
 * 之后每隔 ZOMBIE_CHECK_EVERY_MS 再确认一次，限时到了也确认最后一次。
 */
export const ZOMBIE_CHECK_AFTER_MS = 100;
export const ZOMBIE_CHECK_EVERY_MS = 200;

function defaultDeps(): KillDeps {
  return {
    list: () => listPosixProcesses(),
    signal: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    selfPid: process.pid,
    parentPid: process.ppid,
  };
}

type SendOutcome = "sent" | "gone" | "failed";

/** 发一个信号：ESRCH（已经没了）算 gone；别的错误（EPERM 等）记进 failed。 */
function send(deps: KillDeps, proc: { pid: number; name?: string }, signal: NodeJS.Signals, failed: KillFailure[]): SendOutcome {
  try {
    deps.signal(proc.pid, signal);
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    failed.push({ pid: proc.pid, ...(proc.name ? { name: proc.name } : {}), reason: `${signal} failed: ${code ?? errorMessage(error)}` });
    return "failed";
  }
}

/** 进程还在吗（kill(pid, 0)）：僵尸也算在（它还没被回收）；EPERM 说明存在、只是不归我们管。 */
function exists(deps: KillDeps, pid: number): boolean {
  try {
    deps.signal(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 这些进程里仍在运行的（读表确认：僵尸不在表里，pid 被别的进程复用的也对不上）；读不了表就保守地当作都还在。 */
async function stillRunning(deps: KillDeps, procs: readonly ProcInfo[]): Promise<ProcInfo[]> {
  try {
    const present = new Set((await deps.list()).map(procKey));
    return procs.filter((proc) => present.has(procKey(proc)));
  } catch {
    return [...procs];
  }
}

/** 等这些进程消失，返回时限到了仍在运行的那些。读表确认的时机见 ZOMBIE_CHECK_AFTER_MS。 */
async function waitUntilGone(deps: KillDeps, procs: readonly ProcInfo[], waitMs: number, pollMs: number): Promise<ProcInfo[]> {
  const startedAt = deps.now();
  const deadline = startedAt + waitMs;
  let checkAt = startedAt + ZOMBIE_CHECK_AFTER_MS;
  let pending = [...procs];
  for (;;) {
    pending = pending.filter((proc) => exists(deps, proc.pid));
    if (pending.length === 0) return pending;
    if (deps.now() >= deadline) return await stillRunning(deps, pending);
    if (deps.now() >= checkAt) {
      pending = await stillRunning(deps, pending);
      if (pending.length === 0) return pending;
      checkAt = deps.now() + ZOMBIE_CHECK_EVERY_MS;
    }
    await deps.sleep(pollMs);
  }
}

/** 停止状态：T（被信号停止）、t（被跟踪时停止）。没有状态信息的表（Windows 风格的假表）无从判断，按已停止算。 */
const isStopped = (proc: ProcInfo): boolean => proc.state === undefined || proc.state === "T" || proc.state === "t";

/** 目标进程及其全部后代（身份必须与 anchors 里记的一致）；自己与祖先既不会被选中，BFS 也不会穿过它们。 */
function collectTargets(anchors: readonly ProcInfo[], table: readonly ProcInfo[], protectedPids: ReadonlySet<number>): Map<string, ProcInfo> {
  const usable = table.filter((proc) => !protectedPids.has(proc.pid));
  const live = new Map(usable.map((proc) => [procKey(proc), proc] as const));
  const targets = new Map<string, ProcInfo>();
  for (const anchor of anchors) {
    const current = live.get(procKey(anchor));
    if (!current) continue;
    targets.set(procKey(current), current);
    for (const descendant of descendantsOf(current.pid, usable)) targets.set(procKey(descendant), descendant);
  }
  return targets;
}

export function describeFailure(failure: KillFailure): string {
  return `${failure.name ?? "process"} (pid ${failure.pid}): ${failure.reason}`;
}

/**
 * 结束 rootPid 及其全部后代。永不抛错（读表失败、发信号失败都体现在返回值里）。
 * 读不了表时：带 `expect` 的不动；否则退回“只对 rootPid 发信号”（与旧实现一致），其它平台（读表直接报错）同样如此。
 */
export async function killPosixTree(rootPid: number, options: KillTreeOptions = {}, overrides: Partial<KillDeps> = {}): Promise<KillResult> {
  const deps: KillDeps = { ...defaultDeps(), ...overrides };
  const result: KillResult = { killed: [], failed: [], converged: true };
  const refuse = (reason: string): KillResult => {
    result.failed.push({ pid: rootPid, reason });
    return result;
  };
  // pid 0 与负数在 POSIX 上代表进程组，1 是 init：这些值出现在这里一定是 bug，绝不能发信号。
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || rootPid === deps.selfPid || rootPid === deps.parentPid) return refuse("refusing to signal this pid");

  let table: ProcInfo[];
  try {
    table = await deps.list();
  } catch (error) {
    return await signalRootOnly(rootPid, options, deps, result, errorMessage(error));
  }

  const root = table.find((proc) => proc.pid === rootPid);
  // 已经没了（或只剩僵尸）。它的后代若还活着，早已被系统收养，沿 ppid 找不到了——这是预期之内，不算失败。
  if (!root) return result;
  // pid 被别的进程用了：要找的那个已经没了，也绝不能动这个新进程。
  if (options.expect && procKey(options.expect) !== procKey(root)) return result;

  if (!table.some((proc) => proc.pid === deps.selfPid)) return refuse("this process is missing from the process list, so its ancestors are unknown");
  const protectedPids = new Set<number>([0, 1, deps.selfPid, deps.parentPid, ...ancestorsOf(deps.selfPid, table)]);
  if (protectedPids.has(rootPid)) return refuse("refusing to end this process or one of its ancestors");
  if (!options.expect && !descendantsOf(deps.selfPid, table).some((proc) => proc.pid === rootPid)) return refuse("it is not a descendant of this process");

  let anchors: ProcInfo[] = [root];
  let first: ProcInfo[] | undefined = table;
  const graceMs = options.graceMs ?? 0;
  if (graceMs > 0) {
    anchors = await terminateGently(root, table, protectedPids, graceMs, deps, result);
    if (anchors.length === 0) return result;
    first = undefined;
  }
  await freezeAndKill(anchors, first, protectedPids, deps, result);
  return result;
}

/** 读不了表（或这个平台不支持）：只能对 rootPid 本身发信号。带 `expect` 的无从核对身份，不动。 */
async function signalRootOnly(rootPid: number, options: KillTreeOptions, deps: KillDeps, result: KillResult, why: string): Promise<KillResult> {
  if (options.expect) {
    result.failed.push({ pid: rootPid, name: options.expect.name, reason: `could not verify the process before signalling it (${why})` });
    return result;
  }
  // 如实记下：后代没有处理（找不到它们），调用方看结果就知道这不是一次完整的结束整棵树。
  result.converged = false;
  result.failed.push({ pid: rootPid, reason: `could not list processes (${why}); signalled only this pid, not its descendants` });
  const graceMs = options.graceMs ?? 0;
  if (graceMs > 0) {
    if (send(deps, { pid: rootPid }, "SIGTERM", result.failed) !== "sent") return result;
    // 读不了表，只能用 kill(pid, 0) 等：僵尸会让它等满宽限，最坏只是多发一次 SIGKILL（对僵尸无害）。
    const deadline = deps.now() + graceMs;
    while (exists(deps, rootPid) && deps.now() < deadline) await deps.sleep(GRACE_POLL_MS);
    if (!exists(deps, rootPid)) return result;
  }
  send(deps, { pid: rootPid }, "SIGKILL", result.failed);
  return result;
}

/** 温和的一步：对根与全部后代发 SIGTERM，最多等 graceMs；返回时限到了仍然活着的进程（交给强制结束）。 */
async function terminateGently(
  root: ProcInfo,
  table: readonly ProcInfo[],
  protectedPids: ReadonlySet<number>,
  graceMs: number,
  deps: KillDeps,
  result: KillResult,
): Promise<ProcInfo[]> {
  const usable = table.filter((proc) => !protectedPids.has(proc.pid));
  const signalled: ProcInfo[] = [];
  for (const proc of [root, ...descendantsOf(root.pid, usable)]) {
    if (send(deps, proc, "SIGTERM", result.failed) === "sent") signalled.push(proc);
  }
  const survivors = new Set((await waitUntilGone(deps, signalled, graceMs, GRACE_POLL_MS)).map(procKey));
  for (const proc of signalled) if (!survivors.has(procKey(proc))) result.killed.push(proc);
  return signalled.filter((proc) => survivors.has(procKey(proc)));
}

/** 强制的一步：冻结到收敛，统一 SIGKILL，确认消失。`first` 是已经读好的第一张表（省一次读表）。 */
async function freezeAndKill(
  anchors: readonly ProcInfo[],
  first: ProcInfo[] | undefined,
  protectedPids: ReadonlySet<number>,
  deps: KillDeps,
  result: KillResult,
): Promise<void> {
  const deadline = deps.now() + FREEZE_BUDGET_MS;
  /** 已经发出 SIGSTOP 的进程（键 = pid + 起始标记）。 */
  const frozen = new Map<string, ProcInfo>();
  /** 发不了信号的（EPERM 等）：失败已经记过，不再重试，也不会再对它发 SIGKILL。 */
  const denied = new Set<string>();
  let latest: ProcInfo[] = [];
  let table = first;
  let converged = false;

  try {
    for (let round = 1; round <= MAX_FREEZE_ROUNDS; round += 1) {
      if (!table) {
        if (deps.now() >= deadline) break;
        table = await deps.list();
      }
      latest = table;
      const fresh = [...collectTargets(anchors, table, protectedPids).values()].filter((proc) => !frozen.has(procKey(proc)) && !denied.has(procKey(proc)));
      for (const proc of fresh) {
        const outcome = send(deps, proc, "SIGSTOP", result.failed);
        if (outcome === "sent") frozen.set(procKey(proc), proc);
        else if (outcome === "failed") denied.add(procKey(proc));
      }
      // 收敛：这一轮没有新进程，并且已冻结的在表里都已经是停止状态（SIGSTOP 生效有个小延迟；处于 D 状态的要等它醒来）。
      const byKey = new Map(table.map((proc) => [procKey(proc), proc] as const));
      const settled = [...frozen.keys()].every((key) => {
        const current = byKey.get(key);
        return current === undefined || isStopped(current);
      });
      if (fresh.length === 0 && settled) {
        converged = true;
        break;
      }
      table = undefined;
      await deps.sleep(STOP_SETTLE_MS);
    }
  } catch {
    // 读不了表（或不该发生的异常）：已冻结的不能留在停止状态，带着已知的进程去收尾。
  }
  result.converged = converged;

  // 只对“最近一张表里仍是同一个进程”的发 SIGKILL；已经不在的（或 pid 已被别的进程用了）不动。
  const liveNow = new Map(latest.map((proc) => [procKey(proc), proc] as const));
  const sent: ProcInfo[] = [];
  for (const [key, proc] of frozen) {
    if (!liveNow.has(key)) continue;
    const outcome = send(deps, proc, "SIGKILL", result.failed);
    if (outcome === "sent") sent.push(proc);
    // 冻结了却杀不掉：至少恢复原状，不能把它留在停止状态。
    else if (outcome === "failed") send(deps, proc, "SIGCONT", []);
  }
  if (latest.length === 0) {
    // 一张表都没读到（只会发生在温和一步之后重新读表失败）：身份无从核对，只对刚刚还确认是这棵树里的进程补一刀 SIGKILL。
    for (const proc of anchors) if (send(deps, proc, "SIGKILL", result.failed) === "sent") sent.push(proc);
  }
  await confirmGone(sent, deps, result);
}

/** 等发过 SIGKILL 的进程真正消失；仍在的记为失败，消失的记为已结束。 */
async function confirmGone(sent: readonly ProcInfo[], deps: KillDeps, result: KillResult): Promise<void> {
  if (sent.length === 0) return;
  // 僵尸（容器里的 PID 1 常常不回收孤儿）与 pid 被复用的都不算还在：等待里会读表确认。
  const stuckKeys = new Set((await waitUntilGone(deps, sent, EXIT_WAIT_MS, EXIT_POLL_MS)).map(procKey));
  for (const proc of sent) {
    if (stuckKeys.has(procKey(proc))) result.failed.push({ pid: proc.pid, name: proc.name, reason: "still running after SIGKILL" });
    else result.killed.push(proc);
  }
}
