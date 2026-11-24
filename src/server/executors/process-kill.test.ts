import { describe, expect, it } from "vitest";
import { describeFailure, EXIT_WAIT_MS, FREEZE_BUDGET_MS, killPosixTree, MAX_FREEZE_ROUNDS } from "./process-kill";
import { baseline, makeWorld, PARENT, SELF, sim } from "./process-world.fakes";

// POSIX 杀进程树的逻辑测试：用模拟的进程世界（process-world.fakes.ts）与虚拟时钟，不起任何真实进程，在任何平台上都能跑。
// 真实进程树上的行为见 process-tree.posix.test.ts（只在 Linux / macOS 上跑，至今没有在真实系统上验证过）。

/** 我们起的目标树：100 → 101、102；102 → 103；另有无关进程 200（挂在 init 下）。 */
const tree = () => [...baseline(), sim(100, SELF), sim(101, 100), sim(102, 100), sim(103, 102), sim(200, 1)];
const pidsOf = (procs: { pid: number }[]): number[] => procs.map((proc) => proc.pid).sort((a, b) => a - b);

describe("killPosixTree：冻结 → 收敛 → 统一 SIGKILL", () => {
  it("根与全部后代都结束；先全部冻结（根在前，广度优先）再统一 SIGKILL；没有 SIGTERM；无关进程、自己、祖先一个信号都收不到", async () => {
    const world = makeWorld(tree());
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([]);
    expect(result.converged).toBe(true);
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103]);
    for (const pid of [100, 101, 102, 103]) expect(world.isRunning(pid)).toBe(false);

    const stops = world.signals.filter((entry) => entry.signal === "SIGSTOP").map((entry) => entry.pid);
    expect(stops).toEqual([100, 101, 102, 103]);
    const kinds = world.signals.map((entry) => entry.signal);
    expect(kinds.lastIndexOf("SIGSTOP")).toBeLessThan(kinds.indexOf("SIGKILL"));
    expect(kinds).not.toContain("SIGTERM");
    expect([...new Set(world.signals.map((entry) => entry.pid))].sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
    for (const pid of [200, SELF, PARENT, 1]) expect(world.isRunning(pid)).toBe(true);
    // 树不再长的时候，第一次读表（拿到全树）加一次确认就收敛。
    expect(world.listCalls).toBe(2);
  });

  it("读表与 SIGSTOP 生效之间新 fork 出来的后代也会被冻结、结束，不会漏网", async () => {
    const world = makeWorld(tree());
    // 第二次读表之前，101 又 fork 了一个子进程。
    world.onList = (call) => {
      if (call === 2) world.add(sim(150, 101));
    };
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.converged).toBe(true);
    expect(world.isRunning(150)).toBe(false);
    expect(world.signalsTo(150)).toEqual(["SIGSTOP", "SIGKILL"]);
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103, 150]);
    expect(world.listCalls).toBe(3);
  });

  it("一直在 fork 的树：冻结最多 MAX_FREEZE_ROUNDS 轮就不追了，已知的全部结束，converged=false，没有进程被留在停止状态", async () => {
    const world = makeWorld(tree());
    let next = 1_000;
    // 每次读表前根又长出一个新的子进程：永远有新进程。
    world.onList = () => {
      world.add(sim(next, 100));
      next += 1;
    };
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.converged).toBe(false);
    expect(world.listCalls).toBe(MAX_FREEZE_ROUNDS);
    // 第 1 次读表里就有 1000，第 6 次读表里有 1005：这些都已知，都被冻结、结束。
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103, 1000, 1001, 1002, 1003, 1004, 1005]);
    expect(result.failed).toEqual([]);
    for (const proc of world.procs.values()) expect(proc.state).not.toBe("T");
  });

  it("冻结阶段的总耗时超过 FREEZE_BUDGET_MS 也不再追（每次 sleep 推进 1 秒的虚拟时钟）", async () => {
    const world = makeWorld(tree(), 1_000);
    let next = 1_000;
    world.onList = () => {
      world.add(sim(next, 100));
      next += 1;
    };
    const startedAt = world.clock;
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.converged).toBe(false);
    expect(world.listCalls).toBeLessThan(MAX_FREEZE_ROUNDS);
    // 冻结用掉的虚拟时间不会远超预算（预算 + 一次 sleep），之后的等待消失也不拖。
    expect(world.clock - startedAt).toBeLessThanOrEqual(FREEZE_BUDGET_MS + 1_000);
    for (const pid of [100, 101, 102, 103, 1000, 1001, 1002]) expect(world.isRunning(pid)).toBe(false);
    for (const proc of world.procs.values()) expect(proc.state).not.toBe("T");
  });

  it("冻结后 pid 被别的进程顶替：只结束身份仍然对得上的，顶替者不动", async () => {
    const world = makeWorld(tree());
    world.onSignal = (pid, signal) => {
      if (pid === 101 && signal === "SIGSTOP") {
        // 101 刚被冻结就没了，pid 被一个无关的新进程占用（起始标记不同，也不是后代）。
        world.remove(101);
        world.add(sim(101, 1, { startMark: "reused", name: "stranger" }));
      }
    };
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([]);
    expect(world.signalsTo(101)).toEqual(["SIGSTOP"]);
    expect(world.isRunning(101)).toBe(true);
    expect(world.procs.get(101)?.name).toBe("stranger");
    expect(world.procs.get(101)?.state).toBe("S");
    expect(pidsOf(result.killed)).toEqual([100, 102, 103]);
  });

  it("冻结时某个后代刚好退出（ESRCH）：吞掉，不算失败；它已经冻结的后代照样被结束", async () => {
    const world = makeWorld(tree());
    world.onSignal = (pid, signal) => {
      if (pid === 101 && signal === "SIGSTOP") world.remove(102);
    };
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([]);
    // 102 在第一张表里时它的子进程 103 也在，103 已经在同一轮被冻结：之后即使它被挂到了 init 下，也在已冻结的名单里。
    expect(world.isRunning(103)).toBe(false);
    expect(world.isRunning(100)).toBe(false);
    expect(world.signalsTo(102)).toEqual(["SIGSTOP"]);
  });
});

describe("killPosixTree：安全规则", () => {
  it.each([[0], [1], [-3], [Number.NaN], [2 ** 53], [SELF], [PARENT]])("拒绝 pid %s：什么信号都不发，也不读表", async (pid) => {
    const world = makeWorld(tree());
    const result = await killPosixTree(pid, {}, world.deps);
    expect(result.killed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(world.signals).toEqual([]);
    expect(world.listCalls).toBe(0);
  });

  it("目标是自己更远的祖先（读表后才知道）时整体拒绝，什么信号都不发；带 expect 也一样", async () => {
    const world = makeWorld([sim(1, 0), sim(4, 1, { name: "app" }), sim(PARENT, 4), sim(SELF, PARENT), sim(100, SELF)]);
    const refused = await killPosixTree(4, {}, world.deps);
    expect(refused.failed).toEqual([{ pid: 4, reason: expect.stringContaining("ancestors") }]);
    const refusedWithExpect = await killPosixTree(4, { expect: sim(4, 1, { name: "app" }) }, world.deps);
    expect(refusedWithExpect.failed).toHaveLength(1);
    expect(world.signals).toEqual([]);
  });

  it("没有 expect 时目标必须是自己的后代；带 expect（身份对得上）则不要求——清理孤儿时它早已被系统收养", async () => {
    const stray = sim(300, 1, { name: "stray" });
    const refusing = makeWorld([...baseline(), stray, sim(301, 300)]);
    const refused = await killPosixTree(300, {}, refusing.deps);
    expect(refused.failed).toEqual([{ pid: 300, reason: expect.stringContaining("not a descendant") }]);
    expect(refusing.signals).toEqual([]);

    const allowing = makeWorld([...baseline(), stray, sim(301, 300), sim(200, 1)]);
    const result = await killPosixTree(300, { expect: stray }, allowing.deps);
    expect(result.failed).toEqual([]);
    expect(pidsOf(result.killed)).toEqual([300, 301]);
    expect(allowing.isRunning(200)).toBe(true);
  });

  it("expect 与现在这个 pid 的身份对不上（pid 已被别的进程用了）：什么都不动，也不算失败", async () => {
    const world = makeWorld([...baseline(), sim(300, 1, { startMark: "new" })]);
    const result = await killPosixTree(300, { expect: sim(300, 1, { startMark: "old" }) }, world.deps);
    expect(result).toMatchObject({ killed: [], failed: [] });
    expect(world.signals).toEqual([]);
    expect(world.isRunning(300)).toBe(true);
  });

  it("目标已经不在表里（退出了，或只剩僵尸）：什么都不做，不算失败", async () => {
    const world = makeWorld(tree());
    world.procs.get(100)!.state = "Z";
    const result = await killPosixTree(100, {}, world.deps);
    expect(result).toMatchObject({ killed: [], failed: [] });
    expect(world.signals).toEqual([]);
    expect((await killPosixTree(777, {}, world.deps)).failed).toEqual([]);
  });

  it("自己不在表里（表不是这个进程眼里的世界）：拒绝，不动任何进程", async () => {
    const world = makeWorld(tree().filter((entry) => entry.pid !== SELF));
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([{ pid: 100, reason: expect.stringContaining("missing from the process list") }]);
    expect(world.signals).toEqual([]);
  });
});

describe("killPosixTree：信号错误", () => {
  it("EPERM（不归我们管）如实记为失败、不再重试、也不会对它发 SIGKILL；其余照常结束", async () => {
    const world = makeWorld(tree());
    world.failOn(102, "SIGSTOP", "EPERM");
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([{ pid: 102, name: "p102", reason: "SIGSTOP failed: EPERM" }]);
    expect(world.signalsTo(102)).toEqual(["SIGSTOP"]);
    expect(world.isRunning(102)).toBe(true);
    // 它的子进程 103 照样被冻结与结束。
    expect(pidsOf(result.killed)).toEqual([100, 101, 103]);
    expect(result.converged).toBe(true);
  });

  it("冻结了却 SIGKILL 失败（EPERM）：记为失败，并发 SIGCONT 把它恢复，不留在停止状态", async () => {
    const world = makeWorld(tree());
    world.failOn(101, "SIGKILL", "EPERM");
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([{ pid: 101, name: "p101", reason: "SIGKILL failed: EPERM" }]);
    expect(world.signalsTo(101)).toEqual(["SIGSTOP", "SIGKILL", "SIGCONT"]);
    expect(world.procs.get(101)?.state).toBe("S");
    expect(pidsOf(result.killed)).toEqual([100, 102, 103]);
  });

  it("SIGKILL 发出后进程仍在（卡在内核里）：等一小会儿后记为失败，不算已结束", async () => {
    const world = makeWorld(tree());
    world.unkillable.add(101);
    const startedAt = world.clock;
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([{ pid: 101, name: "p101", reason: "still running after SIGKILL" }]);
    expect(pidsOf(result.killed)).toEqual([100, 102, 103]);
    // 等待有上限：最多 EXIT_WAIT_MS（期间读表确认过几次），不是一直等。
    expect(world.clock - startedAt).toBeLessThanOrEqual(EXIT_WAIT_MS + 100);
  });

  it("SIGKILL 之后只剩僵尸（已死、没被回收，kill(pid, 0) 仍探得到）：读表确认后算已结束", async () => {
    const world = makeWorld(tree());
    world.zombify.add(101);
    const result = await killPosixTree(100, {}, world.deps);
    expect(result.failed).toEqual([]);
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103]);
    expect(world.isRunning(101)).toBe(false);
  });

  it("describeFailure：名字、pid 与原因", () => {
    expect(describeFailure({ pid: 7, name: "sleep", reason: "SIGKILL failed: EPERM" })).toBe("sleep (pid 7): SIGKILL failed: EPERM");
    expect(describeFailure({ pid: 8, reason: "x" })).toBe("process (pid 8): x");
  });
});

describe("killPosixTree：graceMs（先 SIGTERM，再强制）", () => {
  it("所有进程在宽限内退出：只发过 SIGTERM，没有冻结与 SIGKILL", async () => {
    const world = makeWorld(tree());
    const result = await killPosixTree(100, { graceMs: 500 }, world.deps);
    expect(result.failed).toEqual([]);
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103]);
    expect(world.signals.every((entry) => entry.signal === "SIGTERM")).toBe(true);
    expect(world.signals.map((entry) => entry.pid)).toEqual([100, 101, 102, 103]);
    expect(world.isRunning(200)).toBe(true);
  });

  it("根不肯退出（忽略 SIGTERM）：宽限到了再冻结并 SIGKILL，宽限期间等满", async () => {
    const world = makeWorld(tree());
    world.ignoreTerm.add(100);
    const startedAt = world.clock;
    const result = await killPosixTree(100, { graceMs: 500 }, world.deps);
    expect(result.failed).toEqual([]);
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103]);
    expect(world.signalsTo(100)).toEqual(["SIGTERM", "SIGSTOP", "SIGKILL"]);
    expect(world.clock - startedAt).toBeGreaterThanOrEqual(500);
  });

  it("根先退出、子进程不肯退出（被挂到 init 下）：强制的一步按“还活着的进程”找，不依赖已经没了的根", async () => {
    const world = makeWorld(tree());
    world.ignoreTerm.add(101);
    const result = await killPosixTree(100, { graceMs: 500 }, world.deps);
    expect(result.failed).toEqual([]);
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103]);
    expect(world.signalsTo(101)).toEqual(["SIGTERM", "SIGSTOP", "SIGKILL"]);
    expect(world.isRunning(200)).toBe(true);
  });

  it("宽限期间幸存者又 fork 了新进程（收到 SIGTERM 就起新的）：强制的一步把新后代也结束", async () => {
    const world = makeWorld(tree());
    world.ignoreTerm.add(100);
    world.onSignal = (pid, signal) => {
      if (pid === 100 && signal === "SIGTERM") world.add(sim(150, 100));
    };
    const result = await killPosixTree(100, { graceMs: 200 }, world.deps);
    expect(world.isRunning(150)).toBe(false);
    expect(world.isRunning(100)).toBe(false);
    expect(pidsOf(result.killed)).toEqual([100, 101, 102, 103, 150]);
  });

  it("宽限之后重新读表失败：身份无从核对，只对刚才确认过的幸存者补一刀 SIGKILL，不冻结", async () => {
    const world = makeWorld(tree());
    world.ignoreTerm.add(100);
    world.onList = (call) => {
      if (call >= 2) throw new Error("ps unavailable");
    };
    const result = await killPosixTree(100, { graceMs: 200 }, world.deps);
    expect(world.signalsTo(100)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(world.isRunning(100)).toBe(false);
    expect(result.converged).toBe(false);
    expect(world.signals.some((entry) => entry.signal === "SIGSTOP")).toBe(false);
    expect(world.isRunning(200)).toBe(true);
  });
});

describe("killPosixTree：读不了进程表", () => {
  const broken = (world: ReturnType<typeof makeWorld>) => ({
    ...world.deps,
    list: async () => {
      throw new Error("proc unreadable");
    },
  });

  it("没有 expect：退回只对这一个 pid 发 SIGKILL（与旧实现一样），并如实记下后代没有处理", async () => {
    const world = makeWorld(tree());
    const result = await killPosixTree(100, {}, broken(world));
    expect(world.signals).toEqual([{ pid: 100, signal: "SIGKILL" }]);
    expect(result.converged).toBe(false);
    expect(result.failed).toEqual([{ pid: 100, reason: expect.stringContaining("not its descendants") }]);
    expect(world.isRunning(101)).toBe(true);
  });

  it("没有 expect 但有宽限：先 SIGTERM、等、仍活着再 SIGKILL（只对这一个 pid）", async () => {
    const world = makeWorld(tree());
    world.ignoreTerm.add(100);
    await killPosixTree(100, { graceMs: 100 }, broken(world));
    expect(world.signalsTo(100)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(world.isRunning(100)).toBe(false);
  });

  it("带 expect：身份无从核对，什么都不动，如实记下", async () => {
    const world = makeWorld(tree());
    const result = await killPosixTree(100, { expect: sim(100, SELF) }, broken(world));
    expect(world.signals).toEqual([]);
    expect(result.failed).toEqual([{ pid: 100, name: "p100", reason: expect.stringContaining("could not verify") }]);
  });

  it("读不了表时同样拒绝对 pid ≤ 1、自己、父进程发信号", async () => {
    const world = makeWorld(tree());
    for (const pid of [0, 1, SELF, PARENT]) await killPosixTree(pid, {}, broken(world));
    expect(world.signals).toEqual([]);
  });
});
