import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROFILE_LIMIT, type ProfileSpec } from "@shared/profiles";
import { silentLogger } from "./logger";
import { SettingsStore } from "./settings";

/**
 * 委派角色（settings.json 顶层的 `profiles`）的存储层。规则本身（名字、字段、可用性）在 shared/profiles.ts；
 * 这里只钉存储该守的承诺：只动一个角色、落盘成功之后才生效并通知、坏条目不丢不改、认不出的东西原样保留。
 * 这些测试从不碰真实的设置文件：每个用例一个临时目录。
 */

async function home(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-profiles-"));
  return { dir, file: join(dir, "settings.json") };
}

const readJson = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
const keysOf = async (file: string): Promise<string[]> => Object.keys(await readJson(file));
const profilesIn = async (file: string): Promise<Record<string, unknown>> => (await readJson(file))["profiles"] as Record<string, unknown>;
const names = (store: SettingsStore): string[] => store.profilesView().entries.map((entry) => entry.name);

async function seeded(contents: unknown): Promise<{ dir: string; file: string; store: SettingsStore }> {
  const { dir, file } = await home();
  await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return { dir, file, store: await SettingsStore.open(file, silentLogger) };
}

describe("角色的持久化", () => {
  it("没有文件就是没有角色，也不会凭空写出一个文件", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.profilesView()).toEqual({ entries: [] });
    expect(await readdir(dir)).toEqual([]);
  });

  it("新增后落在顶层 profiles（与 harnesses 同级、version 仍是 1），重新打开（相当于服务重启）仍是同一份", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onProfilesChange(changed);

    await store.setProfile("verify", { harness: "codex", model: "gpt-5", effort: "high", access: "read_only" }, { create: true });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.profilesView()).toEqual({ entries: [{ name: "verify", harness: "codex", model: "gpt-5", effort: "high", access: "read_only" }] });
    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: {},
      profiles: { verify: { harness: "codex", model: "gpt-5", effort: "high", access: "read_only" } },
    });
    expect((await SettingsStore.open(file, silentLogger)).profilesView()).toEqual(store.profilesView());
  });

  it("只有执行端也行：省略的字段就是“不固定”，文件里不写 null 或空串", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setProfile("scout", { harness: "pi" });
    expect(store.profilesView().entries).toEqual([{ name: "scout", harness: "pi" }]);
    expect(await profilesIn(file)).toEqual({ scout: { harness: "pi" } });
  });

  it("整条改写：这次给出的取值就是全部，没给的字段被去掉；条目里认不出的字段原样保留", async () => {
    const { file, store } = await seeded({
      version: 1,
      harnesses: {},
      profiles: { verify: { harness: "codex", model: "m1", effort: "high", access: "read_only", note: "keep me" } },
    });
    await store.setProfile("verify", { harness: "codex", model: "m2" });
    expect(store.profilesView().entries).toEqual([{ name: "verify", harness: "codex", model: "m2" }]);
    expect(await profilesIn(file)).toEqual({ verify: { harness: "codex", model: "m2", note: "keep me" } });
  });

  it("没有变化时不写盘也不通知（重复点击、两个标签页设成同一个值）", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setProfile("verify", { harness: "codex", model: "m" });
    const changed = vi.fn();
    store.onProfilesChange(changed);
    const before = await readFile(file, "utf8");

    await store.setProfile("verify", { harness: "codex", model: "m" });
    await store.setProfile("ghost", null);
    expect(changed).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  describe("名字", () => {
    it("去掉首尾空白、转小写后存下来；查找（改、删）对大小写宽容", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await store.setProfile("  Verify-2 ", { harness: "pi" });
      expect(names(store)).toEqual(["verify-2"]);

      await store.setProfile("VERIFY-2", { harness: "codex" });
      expect(store.profilesView().entries).toEqual([{ name: "verify-2", harness: "codex" }]);

      await store.setProfile("Verify-2", null);
      expect(names(store)).toEqual([]);
      expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
    });

    it.each([
      ["", /cannot be empty/],
      ["   ", /cannot be empty/],
      ["a".repeat(25), /at most 24/],
      ["has space", /lowercase letters/],
      ["_leading", /lowercase letters/],
      ["-leading", /lowercase letters/],
      ["角色", /lowercase letters/],
      ["2024", /digits only/],
    ])("名字 %j 不合规：拒绝并说明原因，什么也没有写", async (name, message) => {
      const { dir, file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await expect(store.setProfile(name, { harness: "pi" })).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(message) });
      expect(names(store)).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    });

    it("合规的边界：24 个字符、含数字与连字符与下划线、数字开头但不全是数字", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      for (const name of ["a".repeat(24), "r2-d2_x", "9lives", "a"]) await store.setProfile(name, { harness: "pi" }, { create: true });
      expect(names(store)).toEqual(["a".repeat(24), "r2-d2_x", "9lives", "a"]);
      expect(Object.keys(await profilesIn(file))).toEqual(names(store));
    });

    it("名字可以叫 constructor、valueof、hasownproperty：只用 Map 与 fromEntries 处理，不会撞上对象原型", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      for (const name of ["constructor", "valueof", "tostring", "hasownproperty"]) await store.setProfile(name, { harness: "pi", model: name }, { create: true });
      expect(names(store)).toEqual(["constructor", "valueof", "tostring", "hasownproperty"]);

      const reopened = await SettingsStore.open(file, silentLogger);
      expect(reopened.profilesView().entries[0]).toEqual({ name: "constructor", harness: "pi", model: "constructor" });
      await reopened.setProfile("constructor", null);
      expect(names(reopened)).toEqual(["valueof", "tostring", "hasownproperty"]);
      expect(Object.hasOwn(await profilesIn(file), "constructor")).toBe(false);
    });

    it("手改文件写进来的 __proto__ 键：读得出来、标为名字无效、不污染原型，写回时原样保留", async () => {
      const { file, store } = await seeded('{"version":1,"harnesses":{},"profiles":{"__proto__":{"harness":"codex"},"ok":{"harness":"pi"}}}');
      expect(store.profilesView().entries).toEqual([
        { name: "__proto__", harness: "codex", invalid: "name" },
        { name: "ok", harness: "pi" },
      ]);
      expect(({} as { harness?: string }).harness).toBeUndefined();

      await store.setProfile("fresh", { harness: "pi" }, { create: true });
      const raw = await readFile(file, "utf8");
      expect(raw).toContain('"__proto__"');
      expect(Object.keys(await profilesIn(file))).toEqual(["__proto__", "ok", "fresh"]);
    });
  });

  describe("顺序", () => {
    it("按创建顺序保留：改某一个不挪位置，新的排最后", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      for (const name of ["zeta", "alpha", "mid"]) await store.setProfile(name, { harness: "codex" }, { create: true });
      await store.setProfile("alpha", { harness: "pi" });
      expect(names(store)).toEqual(["zeta", "alpha", "mid"]);
      expect(Object.keys(await profilesIn(file))).toEqual(["zeta", "alpha", "mid"]);

      await store.setProfile("omega", { harness: "pi" });
      expect(Object.keys(await profilesIn(file))).toEqual(["zeta", "alpha", "mid", "omega"]);
    });

    it("连续快速的修改按先后依次落盘，文件始终是完整的，与执行端设置的写入互不丢失", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await Promise.all([
        store.setProfile("one", { harness: "codex" }, { create: true }),
        store.setAllowedModels("codex", ["a"]),
        store.setProfile("two", { harness: "pi" }, { create: true }),
        store.setAllowedModels("pi", ["b"]),
        store.setProfile("one", null),
        store.setProfile("three", { harness: "codex" }, { create: true }),
      ]);
      expect(names(store)).toEqual(["two", "three"]);
      expect(await readJson(file)).toEqual({
        version: 1,
        harnesses: { codex: { allowedModels: ["a"] }, pi: { allowedModels: ["b"] } },
        profiles: { two: { harness: "pi" }, three: { harness: "codex" } },
      });
    });

    it("同时发出的修改轮到自己时才读基线：新增、改名、再用旧名字新增，各自看到的是前一项落盘之后的角色表", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await Promise.all([
        store.setProfile("draft", { harness: "pi" }, { create: true }),
        store.renameProfile("draft", "final"),
        store.setProfile("draft", { harness: "codex" }, { create: true }),
      ]);
      expect(store.profilesView().entries).toEqual([
        { name: "final", harness: "pi" },
        { name: "draft", harness: "codex" },
      ]);
      expect(Object.keys(await profilesIn(file))).toEqual(["final", "draft"]);
    });
  });

  describe("新增（create）、删除与上限", () => {
    it("create 不会覆盖已有的角色：两个标签页同时用同一个名字新增，后到的被拒绝", async () => {
      const { store } = await seeded({ version: 1, harnesses: {} });
      await store.setProfile("verify", { harness: "codex" }, { create: true });
      await expect(store.setProfile("VERIFY", { harness: "pi" }, { create: true })).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringMatching(/already exists/),
      });
      expect(store.profilesView().entries).toEqual([{ name: "verify", harness: "codex" }]);
    });

    it("删除：删最后一个后 profiles 键也不留，文件回到没有这项功能之前的样子", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await store.setProfile("a", { harness: "codex" }, { create: true });
      await store.setProfile("b", { harness: "pi" }, { create: true });
      await store.setProfile("a", null);
      expect(names(store)).toEqual(["b"]);
      await store.setProfile("b", null);
      expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
    });

    it("删不存在的角色是幂等的：不算错，也不会凭空写出文件", async () => {
      const { dir, file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      const changed = vi.fn();
      store.onProfilesChange(changed);
      await store.setProfile("ghost", null);
      expect(changed).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual([]);
    });

    it("数量上限 20 只拦新增：到了上限仍可以改、可以删；手改文件超过上限的同样如此", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      for (let index = 0; index < PROFILE_LIMIT; index += 1) await store.setProfile(`r${index}`, { harness: "codex" }, { create: true });
      await expect(store.setProfile("extra", { harness: "codex" }, { create: true })).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringMatching(/At most 20/),
      });
      await expect(store.setProfile("extra", { harness: "codex" })).rejects.toMatchObject({ code: "invalid_request" });
      await store.setProfile("r0", { harness: "pi" });
      await store.setProfile("r1", null);
      expect(store.profilesView().entries).toHaveLength(PROFILE_LIMIT - 1);

      const crowded = Object.fromEntries(Array.from({ length: PROFILE_LIMIT + 2 }, (_, index) => [`c${index}`, { harness: "codex" }]));
      const { store: handEdited } = await seeded({ version: 1, harnesses: {}, profiles: crowded });
      expect(handEdited.profilesView().entries).toHaveLength(PROFILE_LIMIT + 2);
      await handEdited.setProfile("c0", { harness: "pi" });
      await handEdited.setProfile("c1", null);
      await expect(handEdited.setProfile("extra", { harness: "pi" })).rejects.toMatchObject({ code: "invalid_request" });
    });

    const badShapes: Array<[ProfileSpec, RegExp]> = [
      [{ harness: "h".repeat(101) }, /harness id/],
      [{ harness: " codex" }, /harness id/],
      [{ harness: "codex", model: "" }, /model id/],
      [{ harness: "codex", model: "m".repeat(201) }, /model id/],
      [{ harness: "codex", effort: "x".repeat(41) }, /effort/],
      [{ harness: "codex", effort: " high" }, /effort/],
      [{ harness: "codex", access: "admin" as never }, /"full" or "read_only"/],
    ];
    it.each(badShapes)("字段形状不合格 %j：拒绝，不写盘（“此刻能不能用”是读的时候的事，写入只看形状）", async (spec, message) => {
      const { dir, file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await expect(store.setProfile("verify", spec)).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(message) });
      expect(await readdir(dir)).toEqual([]);
    });

    it("写入只看形状：不认识的执行端、不在名单里的模型都能存（它们此刻能不能用由读的时候评估）", async () => {
      const { store } = await seeded({ version: 1, harnesses: { codex: { allowedModels: ["only-this"] } } });
      await store.setProfile("later", { harness: "future-harness", model: "not-open", effort: "turbo", access: "full" });
      expect(store.profilesView().entries).toEqual([{ name: "later", harness: "future-harness", model: "not-open", effort: "turbo", access: "full" }]);
    });
  });

  describe("改名", () => {
    it("保持原来的位置与内容，旧名字不再出现；一次写入、一次通知", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await store.setProfile("a", { harness: "codex" }, { create: true });
      await store.setProfile("b", { harness: "pi", model: "m", access: "read_only" }, { create: true });
      await store.setProfile("c", { harness: "codex" }, { create: true });
      const changed = vi.fn();
      store.onProfilesChange(changed);

      await store.renameProfile("b", "Bee");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(store.profilesView().entries).toEqual([
        { name: "a", harness: "codex" },
        { name: "bee", harness: "pi", model: "m", access: "read_only" },
        { name: "c", harness: "codex" },
      ]);
      expect(Object.keys(await profilesIn(file))).toEqual(["a", "bee", "c"]);
    });

    it("改成同一个名字（含大小写不同）什么也不做；没有原名字、新名字不合规或已被占用都拒绝", async () => {
      const { file } = await home();
      const store = await SettingsStore.open(file, silentLogger);
      await store.setProfile("a", { harness: "codex" }, { create: true });
      await store.setProfile("b", { harness: "pi" }, { create: true });
      const changed = vi.fn();
      store.onProfilesChange(changed);
      const before = await readFile(file, "utf8");

      await store.renameProfile("a", "A");
      expect(changed).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(before);

      await expect(store.renameProfile("a", "b")).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/already exists/) });
      await expect(store.renameProfile("ghost", "x")).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/no role named/) });
      await expect(store.renameProfile("a", "not ok")).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/lowercase letters/) });
      await expect(store.renameProfile("a", "123")).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/digits only/) });
      expect(names(store)).toEqual(["a", "b"]);
      expect(await readFile(file, "utf8")).toBe(before);
    });
  });

  describe("文件被手改之后", () => {
    const hand = {
      version: 1,
      harnesses: {},
      profiles: {
        good: { harness: "codex", model: "m" },
        "broken-string": "oops",
        "no-harness": { model: "x" },
        "bad-access": { harness: "codex", access: "admin" },
        "bad-model": { harness: "codex", model: 42 },
        future: { harness: "future-harness", model: "x" },
        "Bad Name": { harness: "pi" },
      },
    };

    it("坏条目被标出来（整条无效 / 名字无效），其余照常；不认识的执行端不算坏，只是此刻用不了；打开时不改写文件", async () => {
      const { file } = await home();
      await writeFile(file, JSON.stringify(hand));
      const before = await readFile(file, "utf8");
      const store = await SettingsStore.open(file, silentLogger);

      expect(store.profilesView()).toEqual({
        entries: [
          { name: "good", harness: "codex", model: "m" },
          { name: "broken-string", invalid: "entry" },
          { name: "no-harness", invalid: "entry" },
          { name: "bad-access", invalid: "entry" },
          { name: "bad-model", invalid: "entry" },
          { name: "future", harness: "future-harness", model: "x" },
          { name: "Bad Name", harness: "pi", invalid: "name" },
        ],
      });
      expect(await readFile(file, "utf8")).toBe(before);
    });

    it("写别的角色时，坏条目原样写回（不丢、不改、不“顺手修好”）", async () => {
      const { file, store } = await seeded(hand);
      await store.setProfile("fresh", { harness: "pi" }, { create: true });
      const written = await profilesIn(file);
      expect(written["broken-string"]).toBe("oops");
      expect(written["no-harness"]).toEqual({ model: "x" });
      expect(written["bad-access"]).toEqual({ harness: "codex", access: "admin" });
      expect(written["bad-model"]).toEqual({ harness: "codex", model: 42 });
      expect(written["Bad Name"]).toEqual({ harness: "pi" });
      expect(Object.keys(written)).toEqual([...Object.keys(hand.profiles), "fresh"]);
    });

    it("用户在设置里把它改好或删掉：整条被新内容替换（没有可信的旧字段可带）；名字无效的先改名", async () => {
      const { file, store } = await seeded(hand);
      await store.setProfile("no-harness", { harness: "codex" });
      await store.setProfile("broken-string", null);
      await store.renameProfile("Bad Name", "fixed");

      const view = store.profilesView().entries;
      expect(view.find((entry) => entry.name === "no-harness")).toEqual({ name: "no-harness", harness: "codex" });
      expect(view.some((entry) => entry.name === "broken-string")).toBe(false);
      expect(view.find((entry) => entry.name === "fixed")).toEqual({ name: "fixed", harness: "pi" });
      expect(Object.keys(await profilesIn(file))).toEqual(["good", "no-harness", "bad-access", "bad-model", "future", "fixed"]);
    });

    it("名字无效的条目可以按原样的名字删除（不会成为谁也改不动的僵尸）", async () => {
      const { store } = await seeded(hand);
      await store.setProfile("Bad Name", null);
      expect(names(store)).not.toContain("Bad Name");
    });
  });

  describe("读不了的设置文件", () => {
    it.each([
      ["不是合法的 JSON", "{ nope"],
      ["不是对象", "[]"],
      ["版本不认识", JSON.stringify({ version: 2, harnesses: {}, profiles: { a: { harness: "codex" } } })],
      ["profiles 不是对象", JSON.stringify({ version: 1, harnesses: {}, profiles: ["a"] })],
      ["profiles 是字符串", JSON.stringify({ version: 1, harnesses: {}, profiles: "a" })],
    ])("%s：角色表是“不可用”而不是“没有角色”；任何写入都被拒绝，文件原样不动", async (_label, contents) => {
      const { file, store } = await seeded(contents);
      expect(store.profilesView()).toEqual({ entries: [], unavailable: "unreadable_file" });

      await expect(store.setProfile("verify", { harness: "codex" }, { create: true })).rejects.toMatchObject({ code: "model_settings_unavailable" });
      await expect(store.setProfile("verify", null)).rejects.toMatchObject({ code: "model_settings_unavailable" });
      await expect(store.renameProfile("a", "b")).rejects.toMatchObject({ code: "model_settings_unavailable" });
      expect(await readFile(file, "utf8")).toBe(contents);
    });
  });

  describe("其余内容原样保留", () => {
    it("顶层认不出的键、执行端的设置，改角色时原样带着；顶层键顺序固定为 version、harnesses、profiles、其余", async () => {
      const { file, store } = await seeded({
        version: 1,
        harnesses: { codex: { allowedModels: ["a"], userDefaultModel: "a" } },
        futureKey: { keep: true },
        another: [1, 2],
      });
      await store.setProfile("verify", { harness: "codex" }, { create: true });
      expect(await readJson(file)).toEqual({
        version: 1,
        harnesses: { codex: { allowedModels: ["a"], userDefaultModel: "a" } },
        profiles: { verify: { harness: "codex" } },
        futureKey: { keep: true },
        another: [1, 2],
      });
      expect(await keysOf(file)).toEqual(["version", "harnesses", "profiles", "futureKey", "another"]);
    });

    it("反过来：改执行端的模型设置不会带丢角色", async () => {
      const { file, store } = await seeded({ version: 1, harnesses: {}, profiles: { verify: { harness: "codex", note: "keep" } } });
      await store.setAllowedModels("codex", ["a"]);
      await store.setAllowedModels("codex", null);
      expect(await profilesIn(file)).toEqual({ verify: { harness: "codex", note: "keep" } });
    });
  });

  describe("通知与写盘失败", () => {
    it("落盘成功之后才通知；监听器抛错不影响写入，也不挡住后面的监听器", async () => {
      const { file } = await home();
      const warn = vi.fn();
      const store = await SettingsStore.open(file, { ...silentLogger, warn });
      const first = vi.fn(() => {
        throw new Error("boom");
      });
      // 监听器里抛出的断言会被存储层吞掉（只记日志），所以只在这里把“通知发出那一刻看到了什么”记下来，出了监听器再断言。
      const seen: Array<{ memory: string[]; disk: string[] }> = [];
      const second = vi.fn(() => {
        const disk = JSON.parse(readFileSync(file, "utf8")) as { profiles?: Record<string, unknown> };
        seen.push({ memory: names(store), disk: Object.keys(disk.profiles ?? {}) });
      });
      store.onProfilesChange(first);
      const off = store.onProfilesChange(second);

      await store.setProfile("verify", { harness: "codex" }, { create: true });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      // 通知发出时，磁盘与内存都已经是新的。
      expect(seen).toEqual([{ memory: ["verify"], disk: ["verify"] }]);
      expect(warn).toHaveBeenCalledWith("profiles listener failed", expect.anything());
      expect(await profilesIn(file)).toEqual({ verify: { harness: "codex" } });

      off();
      await store.setProfile("verify", null);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("写盘失败就抛出：内存里的角色不变、不通知；一次失败不会卡住后面的修改", async () => {
      const { dir } = await home();
      // 上级路径是一个普通文件，建目录与写文件都会失败。
      const blocker = join(dir, "blocker");
      const store = await SettingsStore.open(join(blocker, "settings.json"), silentLogger);
      await writeFile(blocker, "x");
      const changed = vi.fn();
      store.onProfilesChange(changed);

      await expect(store.setProfile("verify", { harness: "codex" }, { create: true })).rejects.toThrow(/Could not save settings/);
      expect(store.profilesView()).toEqual({ entries: [] });
      expect(changed).not.toHaveBeenCalled();

      await unlink(blocker);
      await store.setProfile("verify", { harness: "codex" }, { create: true });
      expect(names(store)).toEqual(["verify"]);
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("跨分区排队、前一次写盘失败：后面的修改仍基于没被它改动的内存状态，失败的那一项不会出现在磁盘上", async () => {
      const { dir } = await home();
      const blocker = join(dir, "blocker");
      const file = join(blocker, "settings.json");
      // 失败被记日志的那一刻把拦路的文件搬走：排在后面的写入要等这一次失败之后才轮到，那时目录已经建得出来。
      let armed = true;
      const log = {
        ...silentLogger,
        error: () => {
          if (!armed) return;
          armed = false;
          rmSync(blocker, { force: true });
        },
      };
      const store = await SettingsStore.open(file, log);
      await writeFile(blocker, "x");
      const profilesChanged = vi.fn();
      const limitChanged = vi.fn();
      store.onProfilesChange(profilesChanged);
      store.onConcurrencyChange(limitChanged);

      const [failed, retried, limited] = await Promise.allSettled([
        store.setProfile("scout", { harness: "pi" }, { create: true }),
        // 若前一次失败的修改污染了基线，这里的 create 会因为“已存在”被拒。
        store.setProfile("scout", { harness: "codex" }, { create: true }),
        store.setConcurrency(4),
      ]);
      expect(failed?.status).toBe("rejected");
      expect(failed?.status === "rejected" ? String(failed.reason) : "").toMatch(/Could not save settings/);
      expect(retried?.status).toBe("fulfilled");
      expect(limited?.status).toBe("fulfilled");

      expect(store.profilesView()).toEqual({ entries: [{ name: "scout", harness: "codex" }] });
      expect(store.concurrency()).toEqual({ value: 4 });
      expect(profilesChanged).toHaveBeenCalledTimes(1);
      expect(limitChanged).toHaveBeenCalledTimes(1);
      expect(await readJson(file)).toEqual({ version: 1, harnesses: {}, profiles: { scout: { harness: "codex" } }, maxConcurrentRuns: 4 });
      expect(await readdir(blocker)).toEqual(["settings.json"]);
    });
  });
});
