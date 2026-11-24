/**
 * 仅供测试使用：一个可以推演的 POSIX 进程世界（进程表、信号、虚拟时钟），
 * 让 process-kill 与 process-tree 的 POSIX 逻辑在任何平台（包括 Windows 开发机）上都能被测试，不起任何真实进程。
 *
 * 模拟到的内核行为：SIGSTOP 让进程停止（T）、SIGCONT 恢复；SIGTERM / SIGKILL 让进程消失；
 * 进程消失时它的子进程被挂到 init（pid 1）下；对不存在的 pid 发信号报 ESRCH；
 * 僵尸（已死、还没被回收）能被 kill(pid, 0) 探到，但不出现在进程表里（与 process-list.ts 的做法一致）。
 * 没有模拟：信号投递的延迟（SIGSTOP 总是立刻生效）、权限（用 failOn 指定哪个信号对哪个 pid 报错）。
 */

import type { KillDeps } from "./process-kill";
import type { ProcInfo } from "./process-list";

export type SimState = "S" | "T" | "D" | "Z";

export interface SimProc extends ProcInfo {
  state: SimState;
}

/** 自己（被测代码所在的进程）、自己的父进程；baseline() 里有它们和 init。 */
export const SELF = 10;
export const PARENT = 5;

/** 造一个进程：起始标记按 pid 取（"m<pid>"），名字 "p<pid>"，默认处于睡眠（S）。 */
export function sim(pid: number, ppid: number, extra: Partial<ProcInfo> = {}): ProcInfo {
  return { pid, ppid, created: 1_700_000_000_000 + pid, name: `p${pid}`, startMark: `m${pid}`, state: "S", ...extra };
}

/** init(1) → 宿主(5) → 我们(10)：每个世界都得有这条链，否则自检（自己必须在表里）过不了。 */
export function baseline(): ProcInfo[] {
  return [sim(1, 0, { name: "init" }), sim(PARENT, 1, { name: "host" }), sim(SELF, PARENT, { name: "self" })];
}

export function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

export interface World {
  /** 当前所有进程（含僵尸）。 */
  procs: Map<number, SimProc>;
  /** 发出的信号（不含信号 0 的探测），按发出顺序；目标不存在的也会记下。 */
  signals: { pid: number; signal: NodeJS.Signals }[];
  listCalls: number;
  /** 虚拟时钟（毫秒）；sleep 只推进它，不真的等。 */
  clock: number;
  deps: KillDeps;
  /** 这些 pid 收到 SIGTERM 后仍然活着（忽略了信号）。 */
  ignoreTerm: Set<number>;
  /** 这些 pid 收到 SIGKILL 后仍然活着（卡在内核里）。 */
  unkillable: Set<number>;
  /** 这些 pid 收到 SIGKILL 后变成僵尸（已死、还没被回收）。 */
  zombify: Set<number>;
  /** 每次读表之前调用（参数是第几次读）；用来推演“两次读表之间发生的事”：fork、退出、pid 被复用。抛错就是这次读表失败。 */
  onList?: (call: number) => void;
  /** 每次发出（非 0）信号时调用，在生效之前、目标存在时才调用。 */
  onSignal?: (pid: number, signal: NodeJS.Signals) => void;
  add(proc: ProcInfo): void;
  /** 让进程消失（它的子进程被挂到 init 下）。 */
  remove(pid: number): void;
  /** 某个信号发给某个 pid 时报错（code 如 "EPERM"）。信号 0 的探测也可以。 */
  failOn(pid: number, signal: NodeJS.Signals | 0, code: string): void;
  signalsTo(pid: number): NodeJS.Signals[];
  /** 进程还在运行（存在且不是僵尸）。 */
  isRunning(pid: number): boolean;
}

function toState(state: string | undefined): SimState {
  return state === "T" || state === "D" || state === "Z" ? state : "S";
}

/** `sleepStep`：每次 sleep 至少推进多少虚拟毫秒（调大可以更快撞上时间预算）。 */
export function makeWorld(initial: readonly ProcInfo[], sleepStep = 1): World {
  const procs = new Map<number, SimProc>(initial.map((proc) => [proc.pid, { ...proc, state: toState(proc.state) }] as const));
  const failures = new Map<string, string>();
  const die = (pid: number): void => {
    procs.delete(pid);
    for (const child of procs.values()) if (child.ppid === pid) child.ppid = 1;
  };
  const world: World = {
    procs,
    signals: [],
    listCalls: 0,
    clock: 1_000_000,
    ignoreTerm: new Set(),
    unkillable: new Set(),
    zombify: new Set(),
    add: (proc) => {
      procs.set(proc.pid, { ...proc, state: toState(proc.state) });
    },
    remove: die,
    failOn: (pid, signal, code) => {
      failures.set(`${pid}:${signal}`, code);
    },
    signalsTo: (pid) => world.signals.filter((entry) => entry.pid === pid).map((entry) => entry.signal),
    isRunning: (pid) => {
      const proc = procs.get(pid);
      return proc !== undefined && proc.state !== "Z";
    },
    deps: {
      list: async () => {
        world.listCalls += 1;
        world.onList?.(world.listCalls);
        return [...procs.values()].filter((proc) => proc.state !== "Z").map((proc) => ({ ...proc }));
      },
      signal: (pid, signal) => {
        if (signal !== 0) world.signals.push({ pid, signal });
        const failure = failures.get(`${pid}:${signal}`);
        if (failure) throw errno(failure);
        const target = procs.get(pid);
        if (!target) throw errno("ESRCH");
        if (signal === 0) return;
        world.onSignal?.(pid, signal);
        switch (signal) {
          case "SIGSTOP":
            // 卡在不可中断睡眠（D）里的进程停不下来。
            if (target.state === "S") target.state = "T";
            break;
          case "SIGCONT":
            if (target.state === "T") target.state = "S";
            break;
          case "SIGTERM":
            if (!world.ignoreTerm.has(pid)) die(pid);
            break;
          case "SIGKILL":
            if (world.unkillable.has(pid)) break;
            if (world.zombify.has(pid)) target.state = "Z";
            else die(pid);
            break;
          default:
            break;
        }
      },
      sleep: async (ms) => {
        world.clock += Math.max(ms, sleepStep);
      },
      now: () => world.clock,
      selfPid: SELF,
      parentPid: PARENT,
    },
  };
  return world;
}
