import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@shared/constants";
import { PROFILE_FIELD_MAX } from "@shared/profiles";
import { silentLogger } from "./logger";
import { SettingsStore } from "./settings";
import { asObject, emptyFile, encodeFile, isBounded, parseConcurrency, parseFile, parseHarness, parseProfile, parseRetention, serialize, type SettingsFile } from "./settings-file";

/**
 * settings.json 的编解码（settings-file.ts）与 SettingsStore 的提交点。
 * 编解码只用内存里的文本，不碰文件；提交点的用例每个一个临时目录，从不碰真实的设置文件。
 * 钉住的承诺：认不出的内容与局部损坏的内容原样保留、写回时不丢不改；整个文件不可用时四项各按各的方式拒绝；
 * 落盘走 writeFileAtomic（失败时不留临时文件、并发的写各用各的临时文件）。
 */

async function home(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-settings-file-"));
  return { dir, file: join(dir, "settings.json") };
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));

function parsedData(raw: string): SettingsFile {
  const parsed = parseFile(raw);
  if (!parsed.ok) throw new Error(`expected a usable settings file, got: ${parsed.reason}`);
  return parsed.data;
}

describe("settings.json 的解码与编码（settings-file.ts）", () => {
  it("只有 version 的文件就是一份空设置，与没有文件时一样；写回时只有 version 与 harnesses", () => {
    expect(parseFile('{"version":1}')).toEqual({ ok: true, data: emptyFile() });
    // 每次都是新的一份：各调用方各拿各的，不会共用同一张表。
    expect(emptyFile().harnesses).not.toBe(emptyFile().harnesses);
    expect(serialize(emptyFile())).toEqual({ version: 1, harnesses: {} });
    expect(Object.keys(serialize(emptyFile()))).toEqual(["version", "harnesses"]);
    expect(encodeFile(emptyFile())).toBe('{\n  "version": 1,\n  "harnesses": {}\n}\n');
  });

  const unusable: Array<[string, string, string]> = [
    ["不是合法的 JSON", "{ not json", "not valid JSON"],
    ["顶层是数组", "[]", "not an object"],
    ["顶层是 null", "null", "not an object"],
    ["没有 version", JSON.stringify({ harnesses: {} }), "unsupported settings version"],
    ["version 不认识", JSON.stringify({ version: 2, harnesses: {} }), "unsupported settings version"],
    ["version 写成字符串", JSON.stringify({ version: "1", harnesses: {} }), "unsupported settings version"],
    ["harnesses 是数组", JSON.stringify({ version: 1, harnesses: [] }), "harnesses is not an object"],
    ["harnesses 是 null", JSON.stringify({ version: 1, harnesses: null }), "harnesses is not an object"],
    ["profiles 是字符串", JSON.stringify({ version: 1, harnesses: {}, profiles: "a" }), "profiles is not an object"],
    ["harnesses 与 profiles 都不对时先说 harnesses", JSON.stringify({ version: 1, harnesses: 3, profiles: 3 }), "harnesses is not an object"],
  ];
  it.each(unusable)("%s：整份文件不可用，并写明原因", (_label, raw, reason) => {
    expect(parseFile(raw)).toEqual({ ok: false, reason });
  });

  it("认不出的顶层键与条目里认不出的字段原样保留；写回时顶层键的顺序固定，认不出的排在最后", () => {
    const raw = JSON.stringify({
      futureTop: { keep: [1, 2] },
      retention: { keepDays: 7, keepCount: null, scope: "roots" },
      maxConcurrentRuns: 8,
      profiles: { verify: { harness: "codex", model: "m", note: "keep me" } },
      harnesses: { codex: { allowedModels: ["a"], userDefaultModel: "a", futureOption: { keep: true } } },
      another: "x",
      version: 1,
    });
    const body = serialize(parsedData(raw));

    expect(Object.keys(body)).toEqual(["version", "harnesses", "profiles", "maxConcurrentRuns", "retention", "futureTop", "another"]);
    expect(body).toEqual({
      version: 1,
      harnesses: { codex: { allowedModels: ["a"], userDefaultModel: "a", futureOption: { keep: true } } },
      profiles: { verify: { harness: "codex", model: "m", note: "keep me" } },
      maxConcurrentRuns: 8,
      retention: { keepDays: 7, keepCount: null, scope: "roots" },
      futureTop: { keep: [1, 2] },
      another: "x",
    });
  });

  it("局部损坏的内容留着文件里的原值：标为无效，写回时原样写出，不会被悄悄修好或抹掉；各条目的先后保持文件里的顺序", () => {
    const broken = {
      harnesses: { codex: { allowedModels: ["bad", 3], futureOption: "keep me" }, cursor: null, pi: { allowedModels: ["ok"] } },
      profiles: { oops: "oops", "no-harness": { model: "x" }, "bad-access": { harness: "codex", access: "admin" }, fine: { harness: "pi" } },
      maxConcurrentRuns: -2,
      retention: { keepDays: 0 },
    };
    const data = parsedData(JSON.stringify({ version: 1, ...broken }));

    expect([...data.harnesses.keys()]).toEqual(["codex", "cursor", "pi"]);
    expect(data.harnesses.get("codex")).toEqual({ ok: false, value: broken.harnesses.codex });
    expect(data.harnesses.get("cursor")).toEqual({ ok: false, value: null });
    expect(data.harnesses.get("pi")).toEqual({ ok: true, value: { allowedModels: ["ok"] } });
    expect([...data.profiles.keys()]).toEqual(["oops", "no-harness", "bad-access", "fine"]);
    expect(data.profiles.get("oops")).toEqual({ ok: false, value: "oops" });
    expect(data.profiles.get("no-harness")).toEqual({ ok: false, value: { model: "x" } });
    expect(data.profiles.get("bad-access")).toEqual({ ok: false, value: { harness: "codex", access: "admin" } });
    expect(data.profiles.get("fine")).toEqual({ ok: true, value: { harness: "pi" } });
    expect(data.maxConcurrentRuns).toEqual({ ok: false, value: -2 });
    expect(data.retention).toEqual({ ok: false, value: { keepDays: 0 } });

    expect(serialize(data)).toEqual({ version: 1, ...broken });
  });

  it("键写了但值是 null，也算“写了但无效”：留着原值，不当作没写", () => {
    const data = parsedData('{"version":1,"maxConcurrentRuns":null,"retention":null}');
    expect(data.maxConcurrentRuns).toEqual({ ok: false, value: null });
    expect(data.retention).toEqual({ ok: false, value: null });
    expect(JSON.stringify(serialize(data))).toBe('{"version":1,"harnesses":{},"maxConcurrentRuns":null,"retention":null}');
  });

  it("执行端 id 与角色名叫 __proto__ 也只是普通的名字：读得进、写得回，在写出的对象里是自己的键而不是改了原型", () => {
    const raw = '{"version":1,"harnesses":{"__proto__":{"allowedModels":["a"]}},"profiles":{"__proto__":{"harness":"pi"}}}';
    const data = parsedData(raw);
    const body = serialize(data);

    expect([...data.harnesses.keys()]).toEqual(["__proto__"]);
    expect([...data.profiles.keys()]).toEqual(["__proto__"]);
    expect(Object.hasOwn(body["harnesses"] as object, "__proto__")).toBe(true);
    expect(Object.hasOwn(body["profiles"] as object, "__proto__")).toBe(true);
    expect(JSON.stringify(body)).toBe(raw);
  });

  it("编码出来的文本再解码，内容不变：写盘之后重启读到的就是写出去的", () => {
    const raw = JSON.stringify({
      version: 1,
      harnesses: { codex: { allowedModels: ["a", "b"], allowedEfforts: { a: ["low", "high"] }, userDefaultModel: "b" }, broken: { allowedModels: 3 } },
      profiles: { verify: { harness: "codex", model: "a", access: "read_only", note: "keep" } },
      maxConcurrentRuns: "unlimited",
      retention: { keepDays: 30, keepCount: 5 },
      futureTop: [1, 2],
    });
    const first = parsedData(raw);
    const text = encodeFile(first);

    expect(text.startsWith('{\n  "version": 1,\n  "harnesses": {')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(serialize(parsedData(text))).toEqual(serialize(first));
  });

  describe("各块的解码", () => {
    it("执行端条目：名单去重、档位空映射等于没有记录、认不出的字段原样留着", () => {
      expect(parseHarness({ allowedModels: ["a", "b", "a"], allowedEfforts: {}, userDefaultModel: "b", future: 1 })).toEqual({
        ok: true,
        value: { allowedModels: ["a", "b"], userDefaultModel: "b", future: 1 },
      });
      expect(parseHarness({})).toEqual({ ok: true, value: {} });
      // 空名单是一种明确的取舍（一个都不开放），不是“没有限制”。
      expect(parseHarness({ allowedModels: [] })).toEqual({ ok: true, value: { allowedModels: [] } });
    });

    it("执行端条目不合格（不是对象、名单、默认模型或档位不合格）：整条无效，留着原值", () => {
      const bad: unknown[] = [
        null,
        "x",
        ["a"],
        { allowedModels: "a" },
        { allowedModels: [" a"] },
        { allowedModels: ["a", 3] },
        { userDefaultModel: "" },
        { userDefaultModel: " a" },
        { userDefaultModel: null },
        { allowedEfforts: { a: [] } },
        { allowedEfforts: { a: ["low", 3] } },
        { allowedEfforts: ["low"] },
      ];
      for (const entry of bad) expect(parseHarness(entry), JSON.stringify(entry)).toEqual({ ok: false, value: entry });
    });

    it("档位记录里的模型 id 叫 __proto__：作为普通的键留着，顺序不变", () => {
      const parsed = parseHarness(JSON.parse('{"allowedEfforts":{"__proto__":["high","low","high"],"a":["low"]}}'));
      expect(parsed.ok).toBe(true);
      const efforts = parsed.ok ? parsed.value.allowedEfforts : undefined;
      expect(Object.keys(efforts ?? {})).toEqual(["__proto__", "a"]);
      expect(JSON.stringify(efforts)).toBe('{"__proto__":["high","low"],"a":["low"]}');
    });

    it("角色条目：只有执行端也行，写了的字段必须合格，认不出的字段原样留着", () => {
      expect(parseProfile({ harness: "pi" })).toEqual({ ok: true, value: { harness: "pi" } });
      expect(parseProfile({ harness: "codex", model: "m", effort: "high", access: "read_only", note: "keep" })).toEqual({
        ok: true,
        value: { harness: "codex", model: "m", effort: "high", access: "read_only", note: "keep" },
      });
      const edge = { harness: "h".repeat(PROFILE_FIELD_MAX.harness), model: "m".repeat(PROFILE_FIELD_MAX.model), effort: "e".repeat(PROFILE_FIELD_MAX.effort) };
      expect(parseProfile(edge)).toEqual({ ok: true, value: edge });
    });

    it("角色条目不合格：整条无效，留着原值", () => {
      const bad: unknown[] = [
        null,
        "oops",
        ["codex"],
        {},
        { model: "x" },
        { harness: "" },
        { harness: " codex" },
        { harness: "h".repeat(PROFILE_FIELD_MAX.harness + 1) },
        { harness: "codex", model: 42 },
        { harness: "codex", model: "m".repeat(PROFILE_FIELD_MAX.model + 1) },
        { harness: "codex", effort: "" },
        { harness: "codex", effort: "x".repeat(PROFILE_FIELD_MAX.effort + 1) },
        { harness: "codex", access: "admin" },
        { harness: "codex", access: null },
      ];
      for (const entry of bad) expect(parseProfile(entry), JSON.stringify(entry)).toEqual({ ok: false, value: entry });
    });

    it("并发上限：1 到上限的整数与 unlimited 按值留着，其余一切是“无效”并留着原值", () => {
      const { min, max } = LIMITS.concurrentRunsSetting;
      for (const value of [min, 8, max, "unlimited"]) expect(parseConcurrency(value)).toEqual({ ok: true, value });
      for (const value of [0, -2, 2.5, max + 1, "8", "Unlimited", "", null, true, [4], { max: 4 }]) {
        expect(parseConcurrency(value), JSON.stringify(value)).toEqual({ ok: false, value });
      }
    });

    it("留存策略：缺省的一项就是不限，认不出的字段留着；不合格的整个无效并留着原值", () => {
      expect(parseRetention({})).toEqual({ ok: true, value: { keepDays: null, keepCount: null } });
      expect(parseRetention({ keepDays: 7 })).toEqual({ ok: true, value: { keepDays: 7, keepCount: null } });
      expect(parseRetention({ keepDays: null, keepCount: 5, scope: "roots" })).toEqual({ ok: true, value: { keepDays: null, keepCount: 5, scope: "roots" } });
      const bad: unknown[] = [{ keepDays: 0 }, { keepDays: "soon" }, { keepCount: -1 }, { keepDays: 2.5 }, { keepDays: LIMITS.retention.maxKeepDays + 1 }, "weekly", 7, [], null];
      for (const value of bad) expect(parseRetention(value), JSON.stringify(value)).toEqual({ ok: false, value });
    });

    it("共用的小判断：只认普通对象；文本不能为空、不能首尾带空白、不能超长", () => {
      const plain = { a: 1 };
      expect(asObject(plain)).toBe(plain);
      for (const other of [null, undefined, [], ["a"], "x", 3, true]) expect(asObject(other)).toBeUndefined();

      expect(isBounded("abc", 3)).toBe(true);
      expect(isBounded("abcd", 3)).toBe(false);
      for (const other of ["", " a", "a ", 1, null, undefined]) expect(isBounded(other, 3)).toBe(false);
    });
  });
});

describe("SettingsStore 的提交点：落盘", () => {
  it("落盘的是 encodeFile 的文本（缩进两格、末尾换行），目录里只有 settings.json", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setConcurrency(5);

    expect(await readFile(file, "utf8")).toBe('{\n  "version": 1,\n  "harnesses": {},\n  "maxConcurrentRuns": 5\n}\n');
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });

  it("四块设置同时排队：按先后依次落盘，每一块都在最终的文件里，目录里不留临时文件", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await Promise.all([
      store.setAllowedModels("cursor", ["a"]),
      store.setProfile("scout", { harness: "pi" }),
      store.setConcurrency(3),
      store.setRetention({ keepDays: 14, keepCount: null }),
      store.setAllowedModels("cursor", ["a", "b"]),
    ]);

    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { cursor: { allowedModels: ["a", "b"] } },
      profiles: { scout: { harness: "pi" } },
      maxConcurrentRuns: 3,
      retention: { keepDays: 14, keepCount: null },
    });
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });

  it("改名这一步失败时临时文件被清掉，不留 settings.json.<pid>.tmp 之类的残余；内存里的设置不变，也不通知", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onChange(changed);
    // 目标位置被一个非空目录占着：临时文件写得出来，改名覆盖它必然失败（POSIX 是 EISDIR，Windows 是 EPERM，后者会先重试几次再放弃）。
    await mkdir(file);
    await writeFile(join(file, "keep.txt"), "x");

    await expect(store.setAllowedModels("cursor", ["a"])).rejects.toThrow(/Could not save settings/);

    expect(await readdir(dir)).toEqual(["settings.json"]);
    expect(await readdir(file)).toEqual(["keep.txt"]);
    expect(store.modelSettings("cursor")).toEqual({});
    expect(changed).not.toHaveBeenCalled();
  });

  it("两个存储实例同时写同一个文件：都成功，文件是完整的 JSON，不留临时文件（各次写盘用各自的临时文件名）", async () => {
    const { dir, file } = await home();
    const first = await SettingsStore.open(file, silentLogger);
    const second = await SettingsStore.open(file, silentLogger);

    await Promise.all([first.setConcurrency(3), second.setRetention({ keepDays: 7, keepCount: null })]);

    expect(await readdir(dir)).toEqual(["settings.json"]);
    expect(await readJson(file)).toMatchObject({ version: 1, harnesses: {} });
  });

  it("留存策略写盘失败：内存里的设置不变；一次失败不会卡住后面的修改；留存没有订阅者，其余三类也不被惊动", async () => {
    const { dir } = await home();
    // 上级路径是一个普通文件，建目录与写文件都会失败。
    const blocker = join(dir, "blocker");
    const store = await SettingsStore.open(join(blocker, "settings.json"), silentLogger);
    await writeFile(blocker, "x");
    const anyone = vi.fn();
    store.onChange(anyone);
    store.onProfilesChange(anyone);
    store.onConcurrencyChange(anyone);

    await expect(store.setRetention({ keepDays: 30, keepCount: null })).rejects.toThrow(/Could not save settings/);
    expect(store.retention()).toEqual({ keepDays: null, keepCount: null });

    await unlink(blocker);
    await store.setRetention({ keepDays: 30, keepCount: null });
    expect(store.retention()).toEqual({ keepDays: 30, keepCount: null });
    expect(anyone).not.toHaveBeenCalled();
  });
});

describe("SettingsStore 的提交点：通知", () => {
  it("执行端设置：通知发出时读到的已经是新的；订阅者抛错只记日志，不挡住后面的订阅者，也不影响已经落盘的设置", async () => {
    const { file } = await home();
    const warn = vi.fn();
    const store = await SettingsStore.open(file, { ...silentLogger, warn });
    const seen: unknown[] = [];
    store.onChange(() => {
      throw new Error("listener bug");
    });
    store.onChange((harness) => {
      seen.push({ harness, view: store.modelSettings(harness) });
    });

    await store.setAllowedModels("cursor", ["a", "b"], undefined, "b");

    expect(seen).toEqual([{ harness: "cursor", view: { allowedModels: ["a", "b"], userDefaultModel: "b" } }]);
    expect(warn).toHaveBeenCalledWith("settings listener failed", expect.anything());
    expect(await readJson(file)).toEqual({ version: 1, harnesses: { cursor: { allowedModels: ["a", "b"], userDefaultModel: "b" } } });
  });

  it("留存策略的改动不通知任何订阅者（清扫器每次开始时自己现读设置）", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const anyone = vi.fn();
    store.onChange(anyone);
    store.onProfilesChange(anyone);
    store.onConcurrencyChange(anyone);

    await store.setRetention({ keepDays: 30, keepCount: null });

    expect(store.retention()).toEqual({ keepDays: 30, keepCount: null });
    expect(anyone).not.toHaveBeenCalled();
  });
});

describe("SettingsStore：整个文件读不了时，四项各按各的方式说明与拒绝", () => {
  const MESSAGES = {
    models: "Ensemble could not read settings.json. Restore a valid settings file and restart Ensemble before changing model settings.",
    roles: "Ensemble could not read settings.json. Restore a valid settings file and restart Ensemble before changing roles.",
    concurrency: "Ensemble could not read settings.json. Restore a valid settings file and restart Ensemble before changing the concurrency limit.",
    retention: "Ensemble could not read settings.json. Restore a valid settings file and restart Ensemble before changing the retention policy.",
  };
  const CONTENT = "{ not json";

  async function unreadable(): Promise<{ file: string; store: SettingsStore }> {
    const { file } = await home();
    await writeFile(file, CONTENT);
    return { file, store: await SettingsStore.open(file, silentLogger) };
  }

  it("读的一侧：模型设置、角色表、并发上限与留存策略各有各的说法，不统一成一个默认值", async () => {
    const { store } = await unreadable();
    expect(store.modelSettings("cursor")).toEqual({ modelSettingsIssue: "unreadable_file" });
    expect(store.profilesView()).toEqual({ entries: [], unavailable: "unreadable_file" });
    expect(store.concurrency()).toEqual({ issue: "unreadable_file" });
    expect(store.retention()).toEqual({ keepDays: null, keepCount: null });
  });

  it("写的一侧：错误码与文案各不相同（模型与角色是 model_settings_unavailable，并发上限与留存是 conflict），原文件原样不动", async () => {
    const { file, store } = await unreadable();
    await expect(store.setAllowedModels("cursor", ["a"])).rejects.toMatchObject({ code: "model_settings_unavailable", message: MESSAGES.models });
    await expect(store.setProfile("scout", { harness: "pi" })).rejects.toMatchObject({ code: "model_settings_unavailable", message: MESSAGES.roles });
    await expect(store.renameProfile("scout", "other")).rejects.toMatchObject({ code: "model_settings_unavailable", message: MESSAGES.roles });
    await expect(store.setConcurrency(3)).rejects.toMatchObject({ code: "conflict", message: MESSAGES.concurrency });
    await expect(store.setRetention({ keepDays: 7, keepCount: null })).rejects.toMatchObject({ code: "conflict", message: MESSAGES.retention });
    expect(await readFile(file, "utf8")).toBe(CONTENT);
  });

  it("文件读不了先于取值检查：取值本身也不合格时，说的仍是文件读不了", async () => {
    const { store } = await unreadable();
    await expect(store.setAllowedModels("cursor", [" bad"])).rejects.toMatchObject({ code: "model_settings_unavailable" });
    await expect(store.setProfile("Bad Name", { harness: "pi" })).rejects.toMatchObject({ code: "model_settings_unavailable" });
    await expect(store.setConcurrency(0 as never)).rejects.toMatchObject({ code: "conflict" });
    await expect(store.setRetention({ keepDays: 0, keepCount: null })).rejects.toMatchObject({ code: "conflict" });
  });
});
