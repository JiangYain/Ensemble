import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { killTree } from "./process";
import { defaultProcessTools, snapshotTree, sweepOrphans } from "./process-tree";
import { CAN_RUN_REAL_TREES, cleanupRealProcesses, isRunning, startBystander, startTree, waitFor } from "./process-tree.fakes";

// 真实进程树（Linux / macOS）：用 process.execPath 起多层 node 进程，验证 killTree 与孤儿清理在真实系统上的行为。
// Windows 与其它平台跳过。这些测试是为“之后在真实 Linux 上验证”准备的：编写时没有运行过，macOS 更是至今没有可用的环境。
// 只结束自己起的那棵树；每个进程都有寿命上限，清理（cleanupRealProcesses）也只动“起始标记没变”的进程。
//
// 在 Linux / macOS 上单独运行：
//   npx vitest run --project node src/server/executors/process-tree.posix.test.ts src/server/executors/process-list.test.ts
// 容器里若没有会回收孤儿的 init（例如不带 --init 的 docker run），被杀掉的孤儿会一直是僵尸：本文件的判断（isRunning）与被测代码都不把僵尸当作活着，
// 但别的测试里用 process.kill(pid, 0) 判断“进程是否还在”的写法会因此误报，那是环境问题。

afterEach(cleanupRealProcesses);

const byNumber = (values: number[]): number[] => [...values].sort((a, b) => a - b);

describe.skipIf(!CAN_RUN_REAL_TREES)("真实进程树：killTree", () => {
  it("结束整棵树（根、子、孙全部消失），旁观的无关进程不受影响", async () => {
    const tree = await startTree(2);
    const bystander = startBystander();
    const all = [...tree.pids().values()];
    expect(all).toHaveLength(7);
    for (const pid of all) expect(isRunning(pid)).toBe(true);

    await killTree(tree.rootPid);

    await waitFor(() => all.every((pid) => !isRunning(pid)), 10_000, "the whole tree to be gone");
    expect(isRunning(bystander)).toBe(true);
  }, 60_000);

  it("默认强制、不拖延：整棵树（包括忽略 SIGTERM 的）立刻结束，不再有旧实现里 1.5 秒的 SIGTERM 宽限", async () => {
    const tree = await startTree(1, "stubborn");
    const all = [...tree.pids().values()];
    expect(all).toHaveLength(3);

    const startedAt = Date.now();
    await killTree(tree.rootPid);
    // 旧实现要先 SIGTERM、等满 1.5 秒（而且只结束根）；这里只要求快于那 1.5 秒。阈值是估的，机器很慢时可能需要放宽。
    expect(Date.now() - startedAt).toBeLessThan(1_400);

    await waitFor(() => all.every((pid) => !isRunning(pid)), 10_000, "the stubborn tree to be gone");
  }, 60_000);

  it("graceMs：进程在宽限内退出就提前返回，不等满宽限", async () => {
    const tree = await startTree(1);
    const all = [...tree.pids().values()];

    const startedAt = Date.now();
    await killTree(tree.rootPid, { graceMs: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    await waitFor(() => all.every((pid) => !isRunning(pid)), 10_000, "the tree to exit on SIGTERM");
  }, 60_000);

  it("graceMs：忽略 SIGTERM 的进程等满宽限后被强制结束，整棵树都不留", async () => {
    const tree = await startTree(1, "stubborn");
    const all = [...tree.pids().values()];

    const startedAt = Date.now();
    await killTree(tree.rootPid, { graceMs: 400 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);

    await waitFor(() => all.every((pid) => !isRunning(pid)), 10_000, "the stubborn tree to be forced out");
  }, 60_000);

  it("结束过程中还在 fork 的树（根每 40 毫秒起一个新子进程）：结束之后一个都不留，包括刚起来的", async () => {
    const tree = await startTree(0, "storm");
    // 等到风暴进行到一半（已经有几个子进程写下了日志）再动手。
    await waitFor(() => tree.pids().size >= 4, 30_000, "a few storm children");

    await killTree(tree.rootPid);

    // 给漏网的（如果有）足够的时间起来并写下自己的 pid，再逐个检查；它们的寿命只有 6 秒，所以这里不能等太久。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const all = [...tree.pids().values()];
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const pid of all) expect(isRunning(pid), `pid ${pid} should be gone`).toBe(false);
  }, 60_000);

  it("目标已经退出：什么都不做，也不抛错", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await expect(killTree(child.pid)).resolves.toBeUndefined();
  }, 30_000);
});

describe.skipIf(!CAN_RUN_REAL_TREES)("真实进程树：取消后的孤儿清理", () => {
  it("中间进程被杀后留下的孤儿被清掉；父进程仍活着的兄弟分支、根、无关进程都不动", async () => {
    const tools = defaultProcessTools();
    expect(tools).toBeDefined();
    const startedAt = Date.now();
    const tree = await startTree(2);
    const bystander = startBystander();
    const pid = (label: string): number => {
      const found = tree.pids().get(label);
      if (found === undefined) throw new Error(`no process ${label}`);
      return found;
    };

    // 取消之前：对整棵树拍快照（候选是晚于 startedAt 创建的后代：两个子进程与四个孙进程）。
    const snapshot = await snapshotTree(tree.rootPid, startedAt, tools!);
    expect(byNumber(snapshot.members.map((entry) => entry.pid))).toEqual(byNumber([pid("ra"), pid("rb"), pid("raa"), pid("rab"), pid("rba"), pid("rbb")]));

    // “取消”：只杀掉中间进程 ra（像 dsh 只结束工具的那层 shell）——它的两个孩子 raa、rab 失去父进程，被系统收养。
    process.kill(pid("ra"), "SIGKILL");
    await waitFor(() => !isRunning(pid("ra")), 10_000, "the middle process to be gone");

    const result = await sweepOrphans(snapshot, tools!);
    expect(result.failed).toEqual([]);
    expect(byNumber(result.killed.map((entry) => entry.pid))).toEqual(byNumber([pid("raa"), pid("rab")]));

    await waitFor(() => !isRunning(pid("raa")) && !isRunning(pid("rab")), 10_000, "the orphans to be gone");
    // 父进程仍活着的分支（rb 与它的孩子）、根、无关进程原样在运行。
    for (const label of ["r", "rb", "rba", "rbb"]) expect(isRunning(pid(label)), label).toBe(true);
    expect(isRunning(bystander)).toBe(true);
  }, 60_000);

  it("没有孤儿时什么都不做：取消前后树没变，一个进程都不杀", async () => {
    const tools = defaultProcessTools();
    const startedAt = Date.now();
    const tree = await startTree(1);
    const all = [...tree.pids().values()];
    const snapshot = await snapshotTree(tree.rootPid, startedAt, tools!);
    expect(snapshot.members).toHaveLength(2);

    const result = await sweepOrphans(snapshot, tools!);
    expect(result).toEqual({ killed: [], failed: [] });
    for (const pid of all) expect(isRunning(pid)).toBe(true);
  }, 60_000);

  it("身份对不上时不动：交给 kill 的“当初看到的样子”里起始标记不是这个进程的，进程原样活着；对得上才结束", async () => {
    const tools = defaultProcessTools();
    const tree = await startTree(0);
    const info = (await tools!.list()).find((entry) => entry.pid === tree.rootPid);
    expect(info?.startMark).toBeTruthy();

    await tools!.kill(tree.rootPid, { ...info!, startMark: "not-this-process" });
    expect(isRunning(tree.rootPid)).toBe(true);

    await tools!.kill(tree.rootPid, info);
    await waitFor(() => !isRunning(tree.rootPid), 10_000, "the process to be ended once its identity matches");
  }, 60_000);

  it("默认工具读到的进程表里有自己，父进程对得上，并且能沿 ppid 找到刚起的树", async () => {
    const tools = defaultProcessTools();
    const tree = await startTree(1);
    const all = await tools!.list();
    expect(all.find((entry) => entry.pid === process.pid)?.ppid).toBe(process.ppid);
    const children = all.filter((entry) => entry.ppid === tree.rootPid).map((entry) => entry.pid);
    expect(byNumber(children)).toEqual(byNumber([tree.pids().get("ra")!, tree.pids().get("rb")!]));
  }, 60_000);
});
