import { mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@shared/constants";
import { silentLogger } from "./logger";
import { SettingsStore } from "./settings";

async function home(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-retention-settings-"));
  return { dir, file: join(dir, "settings.json") };
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));
const keysOf = async (file: string): Promise<string[]> => Object.keys((await readJson(file)) as Record<string, unknown>);
const OFF = { keepDays: null, keepCount: null };

describe("the retention policy in settings.json", () => {
  it("is off when there is no file or no such key, and reading it does not create a file", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.retention()).toEqual(OFF);
    expect(await readdir(dir)).toEqual([]);
  });

  it("is saved at the top level and is still there after a restart", async () => {
    const { file } = await home();
    const first = await SettingsStore.open(file, silentLogger);

    await first.setRetention({ keepDays: 30, keepCount: null });
    expect(first.retention()).toEqual({ keepDays: 30, keepCount: null });
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {}, retention: { keepDays: 30, keepCount: null } });

    await first.setRetention({ keepDays: 14, keepCount: 200 });
    expect((await SettingsStore.open(file, silentLogger)).retention()).toEqual({ keepDays: 14, keepCount: 200 });
  });

  it("accepts both ends of the allowed range", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setRetention({ keepDays: 1, keepCount: 1 });
    expect(store.retention()).toEqual({ keepDays: 1, keepCount: 1 });
    await store.setRetention({ keepDays: LIMITS.retention.maxKeepDays, keepCount: LIMITS.retention.maxKeepCount });
    expect(store.retention()).toEqual({ keepDays: LIMITS.retention.maxKeepDays, keepCount: LIMITS.retention.maxKeepCount });
  });

  it("turning both limits off removes the key: the file goes back to what it was before the feature existed", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setRetention({ keepDays: 30, keepCount: 5 });
    await store.setRetention(OFF);

    expect(store.retention()).toEqual(OFF);
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
    expect(await keysOf(file)).not.toContain("retention");
  });

  it("rejects values that are not whole numbers in range (or null), says which field, and changes nothing", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setRetention({ keepDays: 30, keepCount: null });
    const before = await readFile(file, "utf8");
    const bad: Array<[string, unknown]> = [
      ["keepDays", 0],
      ["keepDays", -3],
      ["keepDays", 1.5],
      ["keepDays", LIMITS.retention.maxKeepDays + 1],
      ["keepDays", "7"],
      ["keepDays", undefined],
      ["keepCount", 0],
      ["keepCount", LIMITS.retention.maxKeepCount + 1],
      ["keepCount", Number.NaN],
    ];

    for (const [field, value] of bad) {
      const next = { keepDays: 30, keepCount: null, [field]: value } as unknown as { keepDays: number | null; keepCount: number | null };
      await expect(store.setRetention(next), `${field}=${String(value)}`).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining(field) });
    }

    expect(store.retention()).toEqual({ keepDays: 30, keepCount: null });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("does not write anything when the value is the one already stored", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);

    await store.setRetention(OFF);
    expect(await readdir(dir)).toEqual([]);

    await store.setRetention({ keepDays: 30, keepCount: 10 });
    await unlink(file);
    await store.setRetention({ keepDays: 30, keepCount: 10 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("shares the file with the other settings: nobody loses anything, unknown keys survive, and the key order is fixed", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { codex: { allowedModels: ["a"] } }, futureKey: { keep: true } }));
    const store = await SettingsStore.open(file, silentLogger);

    await store.setRetention({ keepDays: 30, keepCount: null });
    await store.setConcurrency(5);
    await store.setProfile("fixer", { harness: "codex" });

    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { codex: { allowedModels: ["a"] } },
      profiles: { fixer: { harness: "codex" } },
      maxConcurrentRuns: 5,
      retention: { keepDays: 30, keepCount: null },
      futureKey: { keep: true },
    });
    expect(await keysOf(file)).toEqual(["version", "harnesses", "profiles", "maxConcurrentRuns", "retention", "futureKey"]);

    await store.setConcurrency(null);
    await store.setAllowedModels("codex", null);
    expect(await readJson(file)).toMatchObject({ retention: { keepDays: 30, keepCount: null }, futureKey: { keep: true } });
  });

  it("keeps fields it does not know inside the retention object, even when the limits are turned off", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: {}, retention: { keepDays: 7, keepCount: null, scope: "roots" } }));
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.retention()).toEqual({ keepDays: 7, keepCount: null });

    await store.setRetention({ keepDays: 10, keepCount: 5 });
    expect(await readJson(file)).toMatchObject({ retention: { keepDays: 10, keepCount: 5, scope: "roots" } });

    await store.setRetention(OFF);
    expect(await readJson(file)).toMatchObject({ retention: { keepDays: null, keepCount: null, scope: "roots" } });
    expect(store.retention()).toEqual(OFF);
  });

  it("reads a missing limit as no limit", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: {}, retention: { keepDays: 7 } }));
    expect((await SettingsStore.open(file, silentLogger)).retention()).toEqual({ keepDays: 7, keepCount: null });
  });

  it("treats a value in the file that makes no sense as off, says so, and leaves the file alone until the user fixes it", async () => {
    for (const bad of [{ keepDays: 0 }, { keepDays: "soon" }, { keepCount: -1 }, { keepDays: 2.5 }, "weekly", 7, []]) {
      const { file } = await home();
      const raw = JSON.stringify({ version: 1, harnesses: {}, retention: bad });
      await writeFile(file, raw);
      const warn = vi.fn();

      const store = await SettingsStore.open(file, { ...silentLogger, warn });

      expect(store.retention(), JSON.stringify(bad)).toEqual(OFF);
      expect(warn, JSON.stringify(bad)).toHaveBeenCalledWith(expect.stringContaining("invalid retention"), expect.anything());
      expect(await readFile(file, "utf8")).toBe(raw);

      // 用户正是在修它：可以直接写；写合法的值替换掉坏值。
      await store.setRetention({ keepDays: 30, keepCount: null });
      expect(await readJson(file), JSON.stringify(bad)).toMatchObject({ retention: { keepDays: 30, keepCount: null } });
    }
  });

  it("removes a broken retention value when asked to turn the policy off", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: {}, retention: { keepDays: 0 } }));
    const store = await SettingsStore.open(file, silentLogger);

    await store.setRetention(OFF);

    expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
  });

  it("refuses to change anything when the whole file cannot be read, and leaves the file as it is", async () => {
    const { file } = await home();
    await writeFile(file, "{ this is not json");
    const store = await SettingsStore.open(file, silentLogger);

    expect(store.retention()).toEqual(OFF);
    await expect(store.setRetention({ keepDays: 30, keepCount: null })).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(file, "utf8")).toBe("{ this is not json");
  });
});
