import { describe, expect, it } from "vitest";
import { OpenCodeShells, isKillablePid } from "./opencode-shells";

const SESSION = "ses_mine";

const info = (id: string, pid: number | undefined, sessionID = SESSION) => ({ id, pid, status: "running", metadata: { sessionID } });

interface Options {
  /** `GET /api/shell` 的返回内容；传 Error 表示服务没有回应。 */
  listed?: unknown[] | Error;
  /** 仍然活着的进程；缺省全都已经退出。 */
  live?: Set<number>;
  /** 杀进程要花的时间：返回一个由测试自己放行的 Promise。 */
  gate?: Promise<void>;
  kill?: (pid: number) => Promise<void>;
}

function setup(options: Options = {}) {
  const killed: number[] = [];
  const live = options.live ?? new Set<number>();
  const shells = new OpenCodeShells({
    sessionId: () => SESSION,
    list: async () => {
      if (options.listed instanceof Error) throw options.listed;
      return { location: { directory: "C:\\work" }, data: options.listed ?? [] };
    },
    // 默认的“杀”：根进程立刻消失，但 taskkill 本身要等 gate 才算收尾（机器忙时它能拖上好几秒）。
    kill: options.kill ?? (async (pid) => {
      killed.push(pid);
      live.delete(pid);
      await options.gate;
    }),
    alive: (pid) => live.has(pid),
  });
  return { shells, killed, live };
}

describe("OpenCodeShells", () => {
  it("kills the union of what the events showed and what the server lists, once each, and nothing that is not a running shell of this session", async () => {
    const { shells, killed } = setup({
      listed: [
        info("sh_a", 111), // 事件里也看到过：只杀一次
        info("sh_hidden", 444), // 事件还没处理到，只有登记表知道
        { ...info("sh_done", 555), status: "exited" },
        { ...info("sh_nopid", undefined) },
      ],
    });
    shells.created(info("sh_a", 111));
    shells.created(info("sh_other", 222, "ses_somebody_else"));
    shells.created(info("sh_gone", 333));
    shells.exited("sh_gone");

    const { settled } = await shells.killAll(200);
    await settled;
    expect(killed.sort((a, b) => a - b)).toEqual([111, 444]);
  });

  it("never kills a pid that could be the system, a process group or garbage", async () => {
    const dangerous = [0, 1, 2, 3, 4, -7, 1.5, Number.NaN];
    const { shells, killed } = setup({ listed: dangerous.map((pid, index) => info(`sh_${index}`, pid)) });
    for (const [index, pid] of dangerous.entries()) shells.created(info(`sh_ev${index}`, pid));

    await (await shells.killAll(100)).settled;
    expect(killed).toEqual([]);
    for (const pid of dangerous) expect(isKillablePid(pid)).toBe(false);
    expect(isKillablePid(undefined)).toBe(false);
    expect(isKillablePid(5)).toBe(true);
    expect(isKillablePid(24_680)).toBe(true);
  });

  it("returns as soon as the root processes are gone, without waiting for the kill to finish, and reports the cleanup through `settled`", async () => {
    const gate = Promise.withResolvers<void>();
    const { shells, killed, live } = setup({ listed: [info("sh_a", 111)], gate: gate.promise, live: new Set([111]) });

    const result = await shells.killAll(5_000);
    let settled = false;
    void result.settled.then(() => (settled = true));
    await Promise.resolve();
    expect(killed).toEqual([111]);
    expect(live.has(111)).toBe(false);
    // 根进程已经没了，调用方可以发中断了；taskkill 的收尾还没完。
    expect(settled).toBe(false);

    gate.resolve();
    await result.settled;
    expect(settled).toBe(true);
  });

  it("gives up waiting for a root that will not go away after the limit, so a stuck kill cannot hold the interrupt back forever", async () => {
    const gate = Promise.withResolvers<void>();
    const live = new Set([111]);
    const { shells } = setup({
      listed: [info("sh_a", 111)],
      live,
      // 根进程一直不退出，taskkill 也迟迟不返回。
      kill: async () => gate.promise,
    });

    const started = Date.now();
    const result = await shells.killAll(120);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(2_000);

    let settled = false;
    void result.settled.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await result.settled;
  });

  it("falls back to the pids seen in events when the server does not answer", async () => {
    const { shells, killed } = setup({ listed: new Error("connect ECONNREFUSED") });
    shells.created(info("sh_a", 111));
    await (await shells.killAll(100)).settled;
    expect(killed).toEqual([111]);
  });

  it("finishes the cleanup even when killing a process fails", async () => {
    const { shells } = setup({
      listed: [info("sh_a", 111)],
      kill: async () => {
        throw new Error("taskkill: access denied");
      },
    });
    const result = await shells.killAll(50);
    await expect(result.settled).resolves.toBeUndefined();
  });

  it("ends a shell that appears while a cancel is in progress instead of tracking it, and tracks shells again after the cancel is over", async () => {
    const { shells, killed } = setup();
    shells.halt();
    shells.created(info("sh_late", 777));
    await Promise.resolve();
    expect(killed).toEqual([777]);

    shells.resume();
    shells.created(info("sh_next", 888));
    expect(killed).toEqual([777]);
    await (await shells.killAll(50)).settled;
    expect(killed).toEqual([777, 888]);
  });

  it("keeps ending new shells once the session is closing, even if a cancel finishes afterwards", async () => {
    const { shells, killed } = setup();
    shells.finish();
    shells.halt();
    shells.resume();
    shells.created(info("sh_after_close", 999));
    await Promise.resolve();
    expect(killed).toEqual([999]);
  });

  it("has nothing to kill for a shell that already exited", async () => {
    const { shells, killed } = setup();
    shells.created(info("sh_a", 111));
    shells.exited("sh_a");
    await (await shells.killAll(50)).settled;
    expect(killed).toEqual([]);
  });
});
