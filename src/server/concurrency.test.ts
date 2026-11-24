import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyControl, decideConcurrency } from "./concurrency";
import { silentLogger, type Logger } from "./logger";
import { UNLIMITED_RUNS, type EnvLimit } from "./run-slots";
import { SettingsStore, type StoredConcurrencyView } from "./settings";
import { ManualExecutor, delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, until } from "./testing";

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownTrackedEnvs();
});

const inherited = (max: number, source: EnvLimit["source"] = "default"): EnvLimit => ({ max, source });

describe("decideConcurrency", () => {
  it("falls back to the built-in default when nothing else says anything", () => {
    expect(decideConcurrency({ pinned: undefined, stored: {}, inherited: inherited(20) })).toEqual({
      max: 20,
      setting: { source: "default", inherited: { max: 20, source: "default" } },
    });
  });

  it("uses the environment when the user has not chosen, and says it came from there", () => {
    expect(decideConcurrency({ pinned: undefined, stored: {}, inherited: inherited(6, "env") })).toEqual({
      max: 6,
      setting: { source: "env", inherited: { max: 6, source: "env" } },
    });
    expect(decideConcurrency({ pinned: undefined, stored: {}, inherited: inherited(UNLIMITED_RUNS, "env") }).max).toBe(UNLIMITED_RUNS);
  });

  it("lets the user's number win over the environment, and keeps the environment as the place 'restore default' returns to", () => {
    expect(decideConcurrency({ pinned: undefined, stored: { value: 8 }, inherited: inherited(6, "env") })).toEqual({
      max: 8,
      setting: { source: "settings", stored: 8, inherited: { max: 6, source: "env" } },
    });
  });

  it("reads the user's 'unlimited' as 0, the one way a running service says 'no limit'", () => {
    const decision = decideConcurrency({ pinned: undefined, stored: { value: "unlimited" }, inherited: inherited(6, "env") });
    expect(decision.max).toBe(UNLIMITED_RUNS);
    expect(decision.setting).toEqual({ source: "settings", stored: "unlimited", inherited: { max: 6, source: "env" } });
  });

  it("lets whoever started the service win over everything, and still reports what is stored (present, but not in effect)", () => {
    expect(decideConcurrency({ pinned: 2, stored: { value: 8 }, inherited: inherited(6, "env") })).toEqual({
      max: 2,
      setting: { source: "startup", stored: 8, inherited: { max: 6, source: "env" } },
    });
  });

  it("treats 0 from whoever started the service as an explicit 'no limit', not as 'not given'", () => {
    const decision = decideConcurrency({ pinned: UNLIMITED_RUNS, stored: { value: 8 }, inherited: inherited(6, "env") });
    expect(decision.max).toBe(UNLIMITED_RUNS);
    expect(decision.setting.source).toBe("startup");
  });

  it("treats an invalid stored value and an unreadable file as 'nothing stored' and reports why", () => {
    expect(decideConcurrency({ pinned: undefined, stored: { issue: "invalid_value" }, inherited: inherited(6, "env") })).toEqual({
      max: 6,
      setting: { source: "env", inherited: { max: 6, source: "env" }, issue: "invalid_value" },
    });
    expect(decideConcurrency({ pinned: undefined, stored: { issue: "unreadable_file" }, inherited: inherited(20) })).toEqual({
      max: 20,
      setting: { source: "default", inherited: { max: 20, source: "default" }, issue: "unreadable_file" },
    });
  });

  it("does not pass on the text an unusable environment variable was ignored for", () => {
    const decision = decideConcurrency({ pinned: undefined, stored: {}, inherited: { max: 20, source: "default", ignored: "abc" } });
    expect(decision.setting.inherited).toEqual({ max: 20, source: "default" });
    expect(JSON.stringify(decision)).not.toContain("abc");
  });

  describe("every combination", () => {
    const pinnedCases: Array<number | undefined> = [undefined, 3, UNLIMITED_RUNS];
    const storedCases: StoredConcurrencyView[] = [{}, { value: 8 }, { value: "unlimited" }, { issue: "invalid_value" }, { issue: "unreadable_file" }];
    const inheritedCases: EnvLimit[] = [inherited(20), inherited(6, "env"), inherited(UNLIMITED_RUNS, "env")];

    it("follows startup > settings > environment > default, and always reports the same facts about the other layers", () => {
      for (const pinned of pinnedCases) {
        for (const stored of storedCases) {
          for (const base of inheritedCases) {
            const decision = decideConcurrency({ pinned, stored, inherited: base });
            const label = JSON.stringify({ pinned, stored, base });
            if (pinned !== undefined) {
              expect(decision.max, label).toBe(pinned);
              expect(decision.setting.source, label).toBe("startup");
            } else if (stored.value !== undefined) {
              expect(decision.max, label).toBe(stored.value === "unlimited" ? UNLIMITED_RUNS : stored.value);
              expect(decision.setting.source, label).toBe("settings");
            } else {
              expect(decision.max, label).toBe(base.max);
              expect(decision.setting.source, label).toBe(base.source);
            }
            expect(decision.setting.inherited, label).toEqual({ max: base.max, source: base.source });
            expect(decision.setting.stored, label).toEqual(stored.value);
            expect(decision.setting.issue, label).toEqual(stored.issue);
          }
        }
      }
    });
  });
});

describe("ConcurrencyControl", () => {
  async function rig(options: { seed?: string; env?: EnvLimit; pinned?: number; log?: Logger } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "ensemble-concurrency-"));
    const file = join(dir, "settings.json");
    if (options.seed !== undefined) await writeFile(file, options.seed);
    const settings = await SettingsStore.open(file, silentLogger);
    const envLimit = options.env ?? inherited(1);
    // 与 startService 同一个顺序：先合成出启动时的上限交给 manager，再把控制器接上去。
    const initial = decideConcurrency({ pinned: options.pinned, stored: settings.concurrency(), inherited: envLimit });
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: initial.max });
    const control = new ConcurrencyControl({ manager: env.manager, settings, env: envLimit, pinned: options.pinned, log: options.log ?? silentLogger });
    return { dir, file, settings, exec, env, control };
  }

  it("gives the manager the new limit by the time set() resolves, and reports where it came from", async () => {
    const { control, env } = await rig({ env: inherited(1) });
    expect(control.view()).toEqual({ source: "default", inherited: { max: 1, source: "default" } });

    await control.set(4);
    expect(env.manager.capacity().max).toBe(4);
    expect(control.view()).toEqual({ source: "settings", stored: 4, inherited: { max: 1, source: "default" } });

    await control.set("unlimited");
    expect(env.manager.capacity().max).toBe(UNLIMITED_RUNS);
    expect(control.view()).toMatchObject({ source: "settings", stored: "unlimited" });
  });

  it("goes back to the environment's value, not to the built-in default, when the setting is cleared", async () => {
    const { control, env } = await rig({ env: inherited(6, "env") });
    await control.set(2);
    expect(env.manager.capacity().max).toBe(2);
    await control.set(null);
    expect(env.manager.capacity().max).toBe(6);
    expect(control.view()).toEqual({ source: "env", inherited: { max: 6, source: "env" } });
  });

  it("starts queued sessions when the limit goes up and interrupts nobody when it goes down", async () => {
    const { control, env, exec } = await rig({ env: inherited(1) });
    const delegate = delegatorFor("pi");
    for (const task of ["first", "second", "third"]) await delegate(env, { task });
    await until(() => exec.sessions.length === 1, 4000, "the first session opened");
    expect(env.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 2 });

    await control.set(3);
    await until(() => exec.sessions.length === 3, 4000, "the queued sessions opened");
    expect(env.manager.capacity()).toEqual({ occupied: 3, max: 3, waiting: 0 });

    await control.set(1);
    expect(env.manager.capacity()).toEqual({ occupied: 3, max: 1, waiting: 0 });
    expect(exec.sessions.flatMap((session) => session.cancelled)).toEqual([]);
  });

  it("picks up a change made straight on the settings store, whichever entrance made it", async () => {
    const { settings, env } = await rig({ env: inherited(1) });
    await settings.setConcurrency(7);
    expect(env.manager.capacity().max).toBe(7);
  });

  it("refuses to change anything when whoever started the service fixed the limit (409 conflict), and writes nothing", async () => {
    const { control, env, dir } = await rig({ env: inherited(6, "env"), pinned: 2 });
    expect(env.manager.capacity().max).toBe(2);
    await expect(control.set(9)).rejects.toMatchObject({ code: "conflict" });
    await expect(control.set(null)).rejects.toMatchObject({ code: "conflict" });
    expect(env.manager.capacity().max).toBe(2);
    expect(control.view().source).toBe("startup");
    expect(await readdir(dir)).toEqual([]);
  });

  it("explains an invalid value in the file, ignores it, and lets 'restore default' remove it", async () => {
    const { control, env, settings } = await rig({ seed: JSON.stringify({ version: 1, harnesses: {}, maxConcurrentRuns: -3 }), env: inherited(6, "env") });
    expect(env.manager.capacity().max).toBe(6);
    expect(control.view()).toEqual({ source: "env", inherited: { max: 6, source: "env" }, issue: "invalid_value" });

    await control.set(null);
    expect(settings.concurrency()).toEqual({});
    expect(control.view()).toEqual({ source: "env", inherited: { max: 6, source: "env" } });
  });

  it("explains an unreadable settings file, keeps the environment's limit, and refuses changes (409 conflict)", async () => {
    const { control, env } = await rig({ seed: "{ not json", env: inherited(6, "env") });
    expect(env.manager.capacity().max).toBe(6);
    expect(control.view()).toMatchObject({ source: "env", issue: "unreadable_file" });
    await expect(control.set(2)).rejects.toMatchObject({ code: "conflict" });
    expect(env.manager.capacity().max).toBe(6);
  });

  describe("listeners", () => {
    it("are told after the manager already has the new limit, once per real change", async () => {
      const { control, env } = await rig({ env: inherited(1) });
      const seen: number[] = [];
      control.onChange(() => void seen.push(env.manager.capacity().max));

      await control.set(3);
      await control.set(3);
      await control.set("unlimited");
      await control.set(null);
      expect(seen).toEqual([3, UNLIMITED_RUNS, 1]);
    });

    it("stop being told once they unsubscribe", async () => {
      const { control } = await rig();
      const listener = vi.fn();
      const unsubscribe = control.onChange(listener);
      await control.set(2);
      unsubscribe();
      await control.set(3);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("do not stop each other when one throws, and the failure is logged", async () => {
      const warn = vi.fn();
      const log: Logger = { ...silentLogger, warn, child: () => log };
      const { control } = await rig({ log });
      const after = vi.fn();
      control.onChange(() => {
        throw new Error("listener bug");
      });
      control.onChange(after);

      await control.set(2);
      expect(after).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("concurrency listener failed", expect.anything());
    });

    it("are still told, so the page does not stay on the old setting, when handing the limit to the manager fails", async () => {
      const { control, env } = await rig();
      vi.spyOn(env.manager, "setMaxConcurrentRuns").mockImplementation(() => {
        throw new Error("boom");
      });
      const listener = vi.fn();
      control.onChange(listener);

      await control.set(3);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
