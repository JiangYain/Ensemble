import { mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger";
import { SettingsStore } from "./settings";

async function home(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-concurrency-settings-"));
  return { dir, file: join(dir, "settings.json") };
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));
const keysOf = async (file: string): Promise<string[]> => Object.keys((await readJson(file)) as Record<string, unknown>);

describe("并发上限的持久化", () => {
  it("没有文件、没有这个键，就是没指定；也不会凭空写出一个文件", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.concurrency()).toEqual({});
    expect(await readdir(dir)).toEqual([]);
  });

  it("指定一个数、改成不限制，都落在顶层的 maxConcurrentRuns，重新打开（相当于服务重启）仍是同一份", async () => {
    const { file } = await home();
    const first = await SettingsStore.open(file, silentLogger);

    await first.setConcurrency(8);
    expect(first.concurrency()).toEqual({ value: 8 });
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {}, maxConcurrentRuns: 8 });
    expect((await SettingsStore.open(file, silentLogger)).concurrency()).toEqual({ value: 8 });

    await first.setConcurrency("unlimited");
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {}, maxConcurrentRuns: "unlimited" });
    expect((await SettingsStore.open(file, silentLogger)).concurrency()).toEqual({ value: "unlimited" });
  });

  it("取值范围的两端都收：1 和 1000", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setConcurrency(1);
    expect(store.concurrency()).toEqual({ value: 1 });
    await store.setConcurrency(1000);
    expect(store.concurrency()).toEqual({ value: 1000 });
  });

  it("“恢复默认”就是删掉这个键：文件里不留 null 或空壳", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setConcurrency(3);
    await store.setConcurrency(null);
    expect(store.concurrency()).toEqual({});
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
    expect(await keysOf(file)).not.toContain("maxConcurrentRuns");
  });

  it("和执行端、角色同一个文件：互相写的时候谁也不丢，认不出的顶层键原样保留，顶层键顺序固定", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { codex: { allowedModels: ["a"] } }, futureKey: { keep: true } }));
    const store = await SettingsStore.open(file, silentLogger);

    await store.setConcurrency(5);
    await store.setAllowedModels("pi", ["p"]);
    await store.setProfile("fixer", { harness: "codex" });
    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { codex: { allowedModels: ["a"] }, pi: { allowedModels: ["p"] } },
      profiles: { fixer: { harness: "codex" } },
      maxConcurrentRuns: 5,
      futureKey: { keep: true },
    });
    expect(await keysOf(file)).toEqual(["version", "harnesses", "profiles", "maxConcurrentRuns", "futureKey"]);

    await store.setConcurrency(null);
    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { codex: { allowedModels: ["a"] }, pi: { allowedModels: ["p"] } },
      profiles: { fixer: { harness: "codex" } },
      futureKey: { keep: true },
    });

    // 反过来：先有这个键，再去改别的设置，它也在。
    await store.setConcurrency(12);
    await store.setAllowedModels("codex", null);
    expect(await readJson(file)).toMatchObject({ maxConcurrentRuns: 12, profiles: { fixer: { harness: "codex" } }, futureKey: { keep: true } });
  });

  it("没有变化时不写盘也不通知：同一个值再设一次，或本来就没有时恢复默认", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onConcurrencyChange(changed);

    await store.setConcurrency(null);
    expect(changed).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);

    await store.setConcurrency(4);
    expect(changed).toHaveBeenCalledTimes(1);
    const before = await readFile(file, "utf8");
    await store.setConcurrency(4);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(before);

    await store.setConcurrency("unlimited");
    expect(changed).toHaveBeenCalledTimes(2);
    await store.setConcurrency("unlimited");
    expect(changed).toHaveBeenCalledTimes(2);

    await store.setConcurrency(null);
    expect(changed).toHaveBeenCalledTimes(3);
    await store.setConcurrency(null);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("改别的设置不触发并发上限的通知", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onConcurrencyChange(changed);
    await store.setAllowedModels("cursor", ["a"]);
    await store.setProfile("fixer", { harness: "codex" });
    expect(changed).not.toHaveBeenCalled();
  });

  const invalidValues: unknown[] = [0, -1, 1.5, 1001, Number.NaN, Infinity, "8", "Unlimited", "", true, [], {}];
  it.each(invalidValues.map((value): [unknown] => [value]))("不接受 %j：抛 invalid_request，已存的设置与文件都不变", async (bad) => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setConcurrency(6);
    const before = await readFile(file, "utf8");
    const changed = vi.fn();
    store.onConcurrencyChange(changed);

    await expect(store.setConcurrency(bad as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(store.concurrency()).toEqual({ value: 6 });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["settings.json"]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("写盘失败就抛出：内存里的设置不变，也不通知；一次失败不会卡住后面的修改", async () => {
    const { dir } = await home();
    // 上级路径是一个普通文件，建目录与写文件都会失败。
    const blocker = join(dir, "blocker");
    const store = await SettingsStore.open(join(blocker, "settings.json"), silentLogger);
    await writeFile(blocker, "x");
    const changed = vi.fn();
    store.onConcurrencyChange(changed);

    await expect(store.setConcurrency(9)).rejects.toThrow(/Could not save settings/);
    expect(store.concurrency()).toEqual({});
    expect(changed).not.toHaveBeenCalled();

    await unlink(blocker);
    await store.setConcurrency(9);
    expect(store.concurrency()).toEqual({ value: 9 });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("连续快速的修改按先后依次落盘，最后一次为准，文件始终是完整的", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await Promise.all([
      store.setConcurrency(1),
      store.setConcurrency(2),
      store.setConcurrency("unlimited"),
      store.setConcurrency(null),
      store.setConcurrency(4),
    ]);
    expect(store.concurrency()).toEqual({ value: 4 });
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {}, maxConcurrentRuns: 4 });
  });

  it("监听者抛错只记日志，不影响设置也不影响别的监听者；取消订阅后不再通知", async () => {
    const { file } = await home();
    const warn = vi.fn();
    const store = await SettingsStore.open(file, { ...silentLogger, warn });
    const second = vi.fn();
    store.onConcurrencyChange(() => {
      throw new Error("listener bug");
    });
    const unsubscribe = store.onConcurrencyChange(second);

    await store.setConcurrency(2);
    expect(store.concurrency()).toEqual({ value: 2 });
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("concurrency listener failed", expect.anything());

    unsubscribe();
    await store.setConcurrency(3);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("通知发出时 concurrency() 已经是新值（服务靠它读到新上限）", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const seen: unknown[] = [];
    store.onConcurrencyChange(() => void seen.push(store.concurrency()));
    await store.setConcurrency(7);
    await store.setConcurrency("unlimited");
    await store.setConcurrency(null);
    expect(seen).toEqual([{ value: 7 }, { value: "unlimited" }, {}]);
  });
});

describe("文件里写了不合格的并发上限", () => {
  const bad: Array<[string, unknown]> = [
    ["0（不限要写 unlimited）", 0],
    ["负数", -2],
    ["小数", 2.5],
    ["超出范围", 1001],
    ["数字写成字符串", "8"],
    ["大小写不对的 unlimited", "Unlimited"],
    ["null", null],
    ["布尔值", true],
    ["数组", [4]],
    ["对象", { max: 4 }],
  ];

  it.each(bad)("%s：按没指定处理、服务照常打开并记一条警告；文件里的原值原样保留，改别的设置时也随整份文件写回", async (_label, value) => {
    const { file } = await home();
    const raw = JSON.stringify({ version: 1, harnesses: { codex: { allowedModels: ["a"] } }, maxConcurrentRuns: value });
    await writeFile(file, raw);
    const warn = vi.fn();
    const store = await SettingsStore.open(file, { ...silentLogger, warn });

    expect(store.concurrency()).toEqual({ issue: "invalid_value" });
    expect(store.modelSettings("codex")).toEqual({ allowedModels: ["a"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("maxConcurrentRuns"), expect.anything());
    expect(await readFile(file, "utf8")).toBe(raw);

    await store.setAllowedModels("pi", ["p"]);
    expect(await readJson(file)).toMatchObject({ maxConcurrentRuns: value, harnesses: { codex: { allowedModels: ["a"] }, pi: { allowedModels: ["p"] } } });
    expect(store.concurrency()).toEqual({ issue: "invalid_value" });
  });

  it("用户在页面里重新设置才覆盖它；“恢复默认”则把它删掉（旧值无效也要删：用户正是点它来修）", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: {}, maxConcurrentRuns: -2 }));
    const first = await SettingsStore.open(file, silentLogger);
    await first.setConcurrency(7);
    expect(first.concurrency()).toEqual({ value: 7 });
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {}, maxConcurrentRuns: 7 });

    await writeFile(file, JSON.stringify({ version: 1, harnesses: {}, maxConcurrentRuns: "many" }));
    const second = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    second.onConcurrencyChange(changed);
    await second.setConcurrency(null);
    expect(second.concurrency()).toEqual({});
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
  });
});

describe("读不了的设置文件与并发上限", () => {
  const unusable: Array<[string, string]> = [
    ["不是合法的 JSON", "{ not json"],
    ["版本不认识", JSON.stringify({ version: 2, harnesses: {}, maxConcurrentRuns: 3 })],
    ["执行端设置不是映射", JSON.stringify({ version: 1, harnesses: [], maxConcurrentRuns: 3 })],
  ];

  it.each(unusable)("%s：并发上限按没指定处理并标明原因，改动被拒绝（conflict），文件原样保留，重启后也不放开", async (_label, content) => {
    const { dir, file } = await home();
    await writeFile(file, content);
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onConcurrencyChange(changed);

    expect(store.concurrency()).toEqual({ issue: "unreadable_file" });
    await expect(store.setConcurrency(5)).rejects.toMatchObject({ code: "conflict" });
    await expect(store.setConcurrency(null)).rejects.toMatchObject({ code: "conflict" });
    expect(changed).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["settings.json"]);
    expect(await readFile(file, "utf8")).toBe(content);
    expect((await SettingsStore.open(file, silentLogger)).concurrency()).toEqual({ issue: "unreadable_file" });
  });
});
