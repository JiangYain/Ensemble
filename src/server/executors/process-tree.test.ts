import { describe, expect, it, vi } from "vitest";
import {
  defaultProcessTools,
  descendantsOf,
  listWindowsProcesses,
  parseProcessList,
  posixProcessTools,
  snapshotTree,
  sweepOrphans,
  SWEEP_MARGIN_MS,
  type ProcInfo,
  type ProcessTools,
} from "./process-tree";
import { baseline, makeWorld, PARENT, SELF, sim } from "./process-world.fakes";

const T0 = Date.UTC(2026, 10, 16, 1, 0, 0);
const proc = (pid: number, ppid: number, offsetMs: number, name = "x.exe"): ProcInfo => ({ pid, ppid, created: T0 + offsetMs, name });

/** 假的进程表：list 返回“当前”的表，kill 记录被结束的 pid（并把它从表里去掉）。 */
function fakeTools(initial: ProcInfo[]): { tools: ProcessTools; table: ProcInfo[]; killed: number[]; failOn: Set<number> } {
  const state = { table: [...initial], killed: [] as number[], failOn: new Set<number>() };
  const tools: ProcessTools = {
    list: vi.fn(async () => [...state.table]),
    kill: vi.fn(async (pid: number) => {
      if (state.failOn.has(pid)) throw new Error(`taskkill failed for ${pid}`);
      state.killed.push(pid);
      state.table = state.table.filter((entry) => entry.pid !== pid);
    }),
  };
  return Object.assign(state, { tools });
}

describe("parseProcessList", () => {
  it("每行 pid|ppid|FILETIME|name；创建时间换算成 UTC 毫秒，名字里的竖线保留，坏行跳过", () => {
    const ticks = (BigInt(T0) + 11_644_473_600_000n) * 10_000n;
    expect(parseProcessList(`4|0|${ticks}|System\r\n123|4|0|odd|name.exe\nbroken line\n\n`)).toEqual([
      { pid: 4, ppid: 0, created: T0, name: "System" },
      { pid: 123, ppid: 4, created: 0, name: "odd|name.exe" },
    ]);
  });
});

describe("descendantsOf", () => {
  it("沿 ppid 向下找全部后代，不含根自己，也不含无关进程；有环不会死循环", () => {
    const all = [proc(100, 1, 0), proc(110, 100, 0), proc(111, 110, 0), proc(120, 100, 0), proc(200, 1, 0), proc(2, 3, 0), proc(3, 2, 0)];
    expect(descendantsOf(100, all).map((entry) => entry.pid).sort()).toEqual([110, 111, 120]);
    // 环（pid 复用造成的陈旧 ppid）：根 2 的后代是 3，3 的子进程 2 已经见过。
    expect(descendantsOf(2, all).map((entry) => entry.pid)).toEqual([3]);
  });
});

describe("取消后的孤儿清理", () => {
  const DSH = 100;
  /** 工具调用开始的时刻（我们收到 tool_call 通知的时间）。 */
  const since = T0 + 100;

  // 取消前：dsh(100) 下有更早留下的后台作业(110→111)、这次的工具 shell(120) 与它的子孙、dsh 自己的 MCP 子进程(140)。
  const before = [
    proc(DSH, 1, -60_000, "node.exe"),
    proc(110, DSH, -30_000, "pwsh.exe"),
    proc(111, 110, -29_000, "ping.exe"),
    proc(120, DSH, 0, "pwsh.exe"),
    proc(121, 120, 0, "conhost.exe"),
    proc(122, 120, 200, "ping.exe"),
    proc(123, 120, 100, "cmd.exe"),
    proc(124, 123, 200, "ping.exe"),
    proc(130, 1, 0, "other.exe"),
    proc(140, DSH, 1_000, "mcp.exe"),
  ];
  // 取消后：dsh 只结束了 shell(120) 和它的 conhost(121)。
  const after = before.filter((entry) => entry.pid !== 120 && entry.pid !== 121);

  it("快照：只留晚于最早进行中工具（含余量）创建的后代，conhost 与无关进程不算", async () => {
    const { tools } = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, tools);
    expect(snapshot.members.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([120, 122, 123, 124, 140]);
    expect(SWEEP_MARGIN_MS).toBeGreaterThan(0);
  });

  it("只结束父进程已经没了的孤儿：shell 的孙子被清掉；dsh 的子进程、更早的后台作业、无关进程都不动", async () => {
    const fake = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, fake.tools);
    fake.table = [...after];
    const result = await sweepOrphans(snapshot, fake.tools);
    expect(result.killed.map((entry) => entry.pid)).toEqual([122, 123]);
    expect(fake.killed).toEqual([122, 123]);
    // 124 的父进程 123 在快照时还活着，它跟着 123 的进程树一起结束，不单独处理。
    expect(fake.killed).not.toContain(124);
    expect(fake.killed).not.toContain(140);
    expect(fake.killed).not.toContain(111);
    expect(fake.killed).not.toContain(130);
  });

  it("pid 被复用成别的进程（创建时间不同）时不能误杀", async () => {
    const fake = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, fake.tools);
    fake.table = after.map((entry) => (entry.pid === 122 ? { ...entry, created: entry.created + 5_000 } : entry));
    const result = await sweepOrphans(snapshot, fake.tools);
    expect(result.killed.map((entry) => entry.pid)).toEqual([123]);
  });

  it("没有任何进程被取消牵连时什么也不杀；没有候选时连进程表都不用再查", async () => {
    const fake = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, fake.tools);
    expect((await sweepOrphans(snapshot, fake.tools)).killed).toEqual([]);
    expect(fake.killed).toEqual([]);

    const empty = fakeTools([proc(DSH, 1, -60_000, "node.exe")]);
    const emptySnapshot = await snapshotTree(DSH, since, empty.tools);
    expect(emptySnapshot.members).toEqual([]);
    vi.mocked(empty.tools.list).mockClear();
    await sweepOrphans(emptySnapshot, empty.tools);
    expect(empty.tools.list).not.toHaveBeenCalled();
  });

  it("一个进程结束失败不影响其它：失败的单独列出", async () => {
    const fake = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, fake.tools);
    fake.table = [...after];
    fake.failOn.add(122);
    const result = await sweepOrphans(snapshot, fake.tools);
    expect(result.killed.map((entry) => entry.pid)).toEqual([123]);
    expect(result.failed).toEqual([{ proc: expect.objectContaining({ pid: 122 }), error: "taskkill failed for 122" }]);
  });

  it("快照里认不出父进程的候选不动", async () => {
    const fake = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, fake.tools);
    snapshot.known.delete(120);
    fake.table = [...after];
    const result = await sweepOrphans(snapshot, fake.tools);
    expect(result.killed.map((entry) => entry.pid)).toEqual([]);
  });
});

describe.skipIf(process.platform !== "win32")("Windows 进程表（真实 CIM）", () => {
  it("能列出当前进程，父进程与创建时间都对得上", async () => {
    const all = await listWindowsProcesses(30_000);
    const self = all.find((entry) => entry.pid === process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBe(process.ppid);
    const startedAt = Date.now() - process.uptime() * 1000;
    expect(Math.abs((self?.created ?? 0) - startedAt)).toBeLessThan(10_000);
    expect(descendantsOf(process.ppid, all).some((entry) => entry.pid === process.pid)).toBe(true);
  }, 60_000);

  it("Windows 上有默认工具", () => {
    expect(defaultProcessTools()).toBeDefined();
  });
});

describe("defaultProcessTools 的平台矩阵", () => {
  it.each(["win32", "linux", "darwin"] as const)("%s 有工具", (platform) => {
    const tools = defaultProcessTools(platform);
    expect(tools).toBeDefined();
    expect(typeof tools?.list).toBe("function");
    expect(typeof tools?.kill).toBe("function");
  });

  it.each(["freebsd", "openbsd", "netbsd", "sunos", "aix", "android", "haiku", "cygwin"] as const)("%s 没有（不清理，也不声称支持）", (platform) => {
    expect(defaultProcessTools(platform)).toBeUndefined();
  });

  it("不传平台参数时看当前平台", () => {
    expect(defaultProcessTools() !== undefined).toBe(["win32", "linux", "darwin"].includes(process.platform));
  });
});

describe("POSIX 式重新挂靠：孤儿现存的 ppid 变成 init（1）或 subreaper", () => {
  const DSH = 100;
  const since = T0 + 100;
  // 取消前：dsh(100) 下有更早的后台作业(110→111)、这次的工具 shell(120) 与它的子孙、dsh 自己的子进程(140)；130 与 dsh 无关。
  const before = [
    proc(DSH, 1, -60_000, "node"),
    proc(110, DSH, -30_000, "bash"),
    proc(111, 110, -29_000, "sleep"),
    proc(120, DSH, 0, "sh"),
    proc(122, 120, 200, "sleep"),
    proc(123, 120, 100, "sh"),
    proc(124, 123, 200, "sleep"),
    proc(125, 124, 300, "sleep"),
    proc(130, 1, 0, "other"),
    proc(140, DSH, 1_000, "mcp"),
  ];
  /** 取消后：dsh 只结束了 shell(120)；失去父进程的 122、123 被 adopter 收养（ppid 改成它），124、125 仍挂在原来的父进程下。 */
  const afterCancel = (adopter: number): ProcInfo[] =>
    before.filter((entry) => entry.pid !== 120).map((entry) => (entry.pid === 122 || entry.pid === 123 ? { ...entry, ppid: adopter } : entry));

  it.each([1, 999])("现存的 ppid 是 %s 也照样只结束孤儿；父进程活着的子孙、兄弟分支、dsh 自己的子进程、无关进程都不碰", async (adopter) => {
    const fake = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, fake.tools);
    fake.table = afterCancel(adopter);
    const result = await sweepOrphans(snapshot, fake.tools);
    expect(result.killed.map((entry) => entry.pid)).toEqual([122, 123]);
    expect(fake.killed).toEqual([122, 123]);
    // 124、125 的父进程在快照时还活着：它们随 123 的进程树一起结束，不单独处理。
    for (const pid of [110, 111, 124, 125, 130, 140]) expect(fake.killed).not.toContain(pid);
  });

  it("sweepOrphans 把快照里看到的样子一起交给 kill（POSIX 据此再核对一次身份）", async () => {
    const fake = fakeTools(before);
    const snapshot = await snapshotTree(DSH, since, fake.tools);
    fake.table = afterCancel(1);
    await sweepOrphans(snapshot, fake.tools);
    expect(fake.tools.kill).toHaveBeenCalledWith(122, expect.objectContaining({ pid: 122, ppid: 120, name: "sleep" }));
    expect(fake.tools.kill).toHaveBeenCalledWith(123, expect.objectContaining({ pid: 123, ppid: 120, name: "sh" }));
  });

  describe("身份用原始起始标记（startMark），不用换算出来的创建时间", () => {
    const mark = (pid: number, ppid: number, offsetMs: number, name: string): ProcInfo => ({ ...proc(pid, ppid, offsetMs, name), startMark: `tick-${pid}` });
    const tree = [mark(DSH, 1, -60_000, "node"), mark(120, DSH, 0, "sh"), mark(122, 120, 200, "sleep")];

    it("校时让换算出来的创建时间整体偏移、起始标记不变：同一个进程仍是同一个，活着的父进程不会被认成已死、它的子进程不会被误杀", async () => {
      const fake = fakeTools(tree);
      const snapshot = await snapshotTree(DSH, since, fake.tools);
      fake.table = tree.map((entry) => ({ ...entry, created: entry.created + 3_600_000 }));
      const result = await sweepOrphans(snapshot, fake.tools);
      expect(result.killed).toEqual([]);
      expect(fake.killed).toEqual([]);
    });

    it("父进程的 pid 被别的进程占用（起始标记不同）：原来的父进程已经没了，它还活着的子进程才是孤儿", async () => {
      const fake = fakeTools(tree);
      const snapshot = await snapshotTree(DSH, since, fake.tools);
      fake.table = tree.map((entry) => (entry.pid === 120 ? { ...entry, startMark: "tick-reused", name: "stranger" } : entry));
      const result = await sweepOrphans(snapshot, fake.tools);
      expect(result.killed.map((entry) => entry.pid)).toEqual([122]);
    });

    it("候选自己的 pid 被别的进程占用（起始标记不同）：绝不能杀", async () => {
      const fake = fakeTools(tree);
      const snapshot = await snapshotTree(DSH, since, fake.tools);
      fake.table = [tree[0]!, { ...tree[2]!, ppid: 1, startMark: "tick-reused", name: "stranger" }];
      const result = await sweepOrphans(snapshot, fake.tools);
      expect(result.killed).toEqual([]);
      expect(fake.killed).toEqual([]);
    });
  });
});

describe("posixProcessTools：用模拟的进程世界走完 快照 → 取消 → 清理", () => {
  const DSH = 100;
  const since = T0 + 100;
  /** init(1) → 宿主(5) → 我们(10) → dsh(100)；dsh 下有更早的后台作业(110)、这次的工具 shell(120) → 孙进程(122) → 曾孙(123)、dsh 自己的子进程(140)；无关进程 200。 */
  const build = () =>
    makeWorld([
      ...baseline(),
      sim(DSH, SELF, { created: T0 - 60_000, name: "dsh" }),
      sim(110, DSH, { created: T0 - 30_000, name: "bash" }),
      sim(120, DSH, { created: T0, name: "sh" }),
      sim(122, 120, { created: T0 + 200, name: "sleep" }),
      sim(123, 122, { created: T0 + 300, name: "sleep" }),
      sim(140, DSH, { created: T0 + 1_000, name: "mcp" }),
      sim(200, 1, { created: T0, name: "bystander" }),
    ]);

  it("dsh 只结束了 shell：孙进程被系统收养（ppid 变成 1）后仍被认出是孤儿并结束，连同它的后代；dsh、它的其它子进程、无关进程、自己与祖先都不受影响", async () => {
    const world = build();
    const tools = posixProcessTools("linux", world.deps);
    const snapshot = await snapshotTree(DSH, since, tools);
    world.remove(120);
    expect(world.procs.get(122)?.ppid).toBe(1);

    const result = await sweepOrphans(snapshot, tools);
    expect(result.failed).toEqual([]);
    expect(result.killed.map((entry) => entry.pid)).toEqual([122]);
    expect(world.isRunning(122)).toBe(false);
    expect(world.isRunning(123)).toBe(false);
    for (const pid of [DSH, 110, 140, 200, SELF, PARENT, 1]) expect(world.isRunning(pid)).toBe(true);
    expect([...new Set(world.signals.map((entry) => entry.pid))].sort((a, b) => a - b)).toEqual([122, 123]);
  });

  it("没有孤儿时什么都不做：不发任何信号", async () => {
    const world = build();
    const tools = posixProcessTools("darwin", world.deps);
    const snapshot = await snapshotTree(DSH, since, tools);
    const result = await sweepOrphans(snapshot, tools);
    expect(result).toEqual({ killed: [], failed: [] });
    expect(world.signals).toEqual([]);
  });

  it("孤儿的 pid 在快照之后被别的进程占用（起始标记不同）：原来的孤儿已经没了，占用者绝不能动", async () => {
    const world = build();
    const tools = posixProcessTools("linux", world.deps);
    const snapshot = await snapshotTree(DSH, since, tools);
    // shell、孙进程、曾孙都退出了，之后 122 这个 pid 被一个无关的新进程占用。
    world.remove(120);
    world.remove(123);
    world.remove(122);
    world.add(sim(122, 1, { startMark: "reused", name: "stranger", created: T0 + 5_000 }));
    const result = await sweepOrphans(snapshot, tools);
    expect(result.killed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(world.signalsTo(122)).toEqual([]);
    expect(world.signals).toEqual([]);
    expect(world.isRunning(122)).toBe(true);
  });

  it("结束失败（EPERM）如实抛出：sweepOrphans 记进 failed，不当成功；其余能结束的照常结束", async () => {
    const world = build();
    world.failOn(123, "SIGSTOP", "EPERM");
    const tools = posixProcessTools("linux", world.deps);
    const snapshot = await snapshotTree(DSH, since, tools);
    world.remove(120);
    const result = await sweepOrphans(snapshot, tools);
    expect(result.killed).toEqual([]);
    expect(result.failed).toEqual([{ proc: expect.objectContaining({ pid: 122 }), error: expect.stringContaining("EPERM") }]);
    expect(world.isRunning(122)).toBe(false);
    expect(world.isRunning(123)).toBe(true);
  });

  it("取消后读不了进程表：sweepOrphans 抛错（上层记 dsh.sweep_failed），不发任何信号", async () => {
    const world = build();
    let calls = 0;
    const list = async () => {
      calls += 1;
      if (calls > 1) throw new Error("proc unreadable");
      return world.deps.list();
    };
    const tools = posixProcessTools("linux", { ...world.deps, list });
    const snapshot = await snapshotTree(DSH, since, tools);
    world.remove(120);
    await expect(sweepOrphans(snapshot, tools)).rejects.toThrow("proc unreadable");
    expect(world.signals).toEqual([]);
  });

  it("读到清理那一刻才发现孤儿已经自己退出了：不算失败，也不动别的", async () => {
    const world = build();
    const tools = posixProcessTools("linux", world.deps);
    const snapshot = await snapshotTree(DSH, since, tools);
    world.remove(120);
    // sweepOrphans 读表时孤儿还在；kill 读表之前它自己退出了。
    let calls = 0;
    const racing = posixProcessTools("linux", {
      ...world.deps,
      list: async () => {
        calls += 1;
        if (calls === 2) world.remove(122);
        return world.deps.list();
      },
    });
    const result = await sweepOrphans(snapshot, racing);
    expect(result.failed).toEqual([]);
    expect(world.signals).toEqual([]);
    expect(world.isRunning(200)).toBe(true);
  });
});
