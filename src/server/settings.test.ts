import { mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger";
import { SettingsStore } from "./settings";

async function home(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-settings-"));
  return { dir, file: join(dir, "settings.json") };
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));

describe("持久化的设置", () => {
  it("没有文件就是没有任何限制，也不会凭空写出一个文件", async () => {
    const { dir, file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.modelSettings("cursor")).toEqual({});
    expect(await readdir(dir)).toEqual([]);
  });

  it("保存后落到磁盘，重新打开（相当于服务重启）仍然是同一份", async () => {
    const { file } = await home();
    const first = await SettingsStore.open(file, silentLogger);
    await first.setAllowedModels("cursor", ["composer-2", "deepseek-v41-flash-1017"]);
    await first.setAllowedModels("codex", []);

    const second = await SettingsStore.open(file, silentLogger);
    expect(second.modelSettings("cursor")).toEqual({ allowedModels: ["composer-2", "deepseek-v41-flash-1017"] });
    // 空名单也是一种明确的取舍（一个都不开放），重启后不能变回“没有限制”。
    expect(second.modelSettings("codex")).toEqual({ allowedModels: [] });
    expect(second.modelSettings("pi")).toEqual({});
    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { cursor: { allowedModels: ["composer-2", "deepseek-v41-flash-1017"] }, codex: { allowedModels: [] } },
    });
  });

  it("去掉限制后条目也随之清掉，文件里不留空壳", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("cursor", ["a"]);
    await store.setAllowedModels("cursor", null);
    expect(store.modelSettings("cursor")).toEqual({});
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
  });

  it("名单去重、保持写入的顺序；没有变化时不写盘也不通知", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onChange(changed);

    await store.setAllowedModels("pi", ["b", "a", "b"]);
    expect(store.modelSettings("pi")).toEqual({ allowedModels: ["b", "a"] });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("pi");

    const before = await readFile(file, "utf8");
    await store.setAllowedModels("pi", ["b", "a"]);
    await store.setAllowedModels("claude", null);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("连续快速的修改按先后依次落盘，最后一次为准，文件始终是完整的", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const all = Array.from({ length: 12 }, (_, index) => store.setAllowedModels("cursor", Array.from({ length: index + 1 }, (_, n) => `m${n}`)));
    await Promise.all(all);
    const expected = Array.from({ length: 12 }, (_, n) => `m${n}`);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: expected });
    expect(await readJson(file)).toEqual({ version: 1, harnesses: { cursor: { allowedModels: expected } } });
  });

  it("文件里这一版不认识的执行端条目，改别的设置时原样保留", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { future: { allowedModels: ["x"], note: "keep me" } } }));
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("cursor", ["a"]);
    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { future: { allowedModels: ["x"], note: "keep me" }, cursor: { allowedModels: ["a"] } },
    });
  });

  it("写盘失败就抛出：内存里的设置不变，也不通知，页面看到的不会和磁盘分叉", async () => {
    const { dir } = await home();
    // 上级路径是一个普通文件，建目录与写文件都会失败。
    const blocker = join(dir, "blocker");
    const store = await SettingsStore.open(join(blocker, "settings.json"), silentLogger);
    await writeFile(blocker, "x");
    const changed = vi.fn();
    store.onChange(changed);

    await expect(store.setAllowedModels("cursor", ["a"])).rejects.toThrow(/Could not save settings/);
    expect(store.modelSettings("cursor")).toEqual({});
    expect(changed).not.toHaveBeenCalled();
  });

  it("一次失败不会卡住后面的修改", async () => {
    const { dir } = await home();
    const blocker = join(dir, "blocker");
    const store = await SettingsStore.open(join(blocker, "settings.json"), silentLogger);
    await writeFile(blocker, "x");
    await expect(store.setAllowedModels("cursor", ["a"])).rejects.toThrow();
    await unlink(blocker);
    await store.setAllowedModels("cursor", ["b"]);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["b"] });
  });
});

describe("每个模型允许的推理档位", () => {
  it("和模型名单一起落盘，重启后仍是同一份；旧文件（没有这一项）等于档位不设限", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { codex: { allowedModels: ["gpt-a"] } } }));
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.modelSettings("codex")).toEqual({ allowedModels: ["gpt-a"] });

    await store.setAllowedModels("codex", ["gpt-a", "gpt-b"], { "gpt-a": ["low", "high", "low"] });
    expect(store.modelSettings("codex")).toEqual({ allowedModels: ["gpt-a", "gpt-b"], allowedEfforts: { "gpt-a": ["low", "high"] } });
    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { codex: { allowedModels: ["gpt-a", "gpt-b"], allowedEfforts: { "gpt-a": ["low", "high"] } } },
    });
    expect((await SettingsStore.open(file, silentLogger)).modelSettings("codex")).toEqual(store.modelSettings("codex"));
  });

  it("省略档位表示不改动（旧版页面只发模型名单）；传空对象清空；模型不设限时档位记录仍保留", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("cursor", ["a"], { a: ["low"], closed: ["max"] });
    await store.setAllowedModels("cursor", ["a", "b"]);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["a", "b"], allowedEfforts: { a: ["low"], closed: ["max"] } });

    // 关闭的模型的记录也留着，重新开放时沿用；去掉模型限制并不会顺带丢掉档位。
    await store.setAllowedModels("cursor", null);
    expect(store.modelSettings("cursor")).toEqual({ allowedEfforts: { a: ["low"], closed: ["max"] } });

    await store.setAllowedModels("cursor", null, {});
    expect(store.modelSettings("cursor")).toEqual({});
    expect(await readJson(file)).toEqual({ version: 1, harnesses: {} });
  });

  it("没有变化时不写盘也不通知", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onChange(changed);
    await store.setAllowedModels("pi", ["a"], { a: ["low", "high"] });
    const before = await readFile(file, "utf8");
    await store.setAllowedModels("pi", ["a"], { a: ["low", "high"] });
    await store.setAllowedModels("pi", ["a"]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("写入时拒绝空档位列表与不合格的名字：开放的模型不能没有任何档位，旧设置也不被改动", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("pi", ["a"], { a: ["low"] });
    for (const bad of [{ a: [] }, { a: [" low"] }, { a: [""] }, { " a": ["low"] }] as Array<Record<string, string[]>>) {
      await expect(store.setAllowedModels("pi", ["a", "b"], bad)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(store.modelSettings("pi")).toEqual({ allowedModels: ["a"], allowedEfforts: { a: ["low"] } });
  });

  it("文件里的档位记录不合格时，这个执行端按损坏处理（阻断委派），重新保存即可修复，别的执行端不受影响", async () => {
    const { file } = await home();
    const bad: Array<[string, unknown]> = [
      ["档位列表是空的", { allowedEfforts: { a: [] } }],
      ["档位不是字符串", { allowedEfforts: { a: ["low", 3] } }],
      ["记录不是映射", { allowedEfforts: ["low"] }],
    ];
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { ...Object.fromEntries(bad.map(([, entry], index) => [`h${index}`, entry])), pi: { allowedEfforts: { a: ["low"] } } } }));
    const store = await SettingsStore.open(file, silentLogger);
    for (const index of bad.keys()) expect(store.modelSettings(`h${index}` as never)).toEqual({ modelSettingsIssue: "invalid_entry" });
    expect(store.modelSettings("pi")).toEqual({ allowedEfforts: { a: ["low"] } });

    // 旧版页面（不带档位）重新保存也能修好：损坏的档位记录不当作“不改动”留下。
    await store.setAllowedModels("h0" as never, ["a"]);
    expect(store.modelSettings("h0" as never)).toEqual({ allowedModels: ["a"] });
  });
});

/**
 * `__proto__` 对模型 id 来说是合法的名字：JSON.parse 把它读成普通的自有属性，但对普通对象写 `obj["__proto__"] = …`
 * 改的是原型，限制会悄悄消失。所以这里的文件内容直接写文本、期望值用 Object.fromEntries 构造——
 * 对象字面量里的 `"__proto__": …` 同样是在设原型，会把要验证的东西自己丢掉。
 */
describe("模型 id 恰好叫 __proto__", () => {
  const map = (...pairs: Array<[string, string[]]>): Record<string, string[]> => Object.fromEntries(pairs);
  const keysOf = (efforts: Record<string, string[]> | undefined): string[] => Object.keys(efforts ?? {});
  const entry = (text: string): string => `{"version":1,"harnesses":{"pi":{"allowedModels":["__proto__","a"],"allowedEfforts":${text}}}}`;
  const storedEfforts = async (file: string, harness: string): Promise<Array<[string, string[]]>> => {
    const parsed = (await readJson(file)) as { harnesses: Record<string, { allowedEfforts?: Record<string, string[]> }> };
    return Object.entries(parsed.harnesses[harness]?.allowedEfforts ?? {});
  };

  it("读取、规范化、保存、重启后读回：这条限制都在，普通名字不受影响", async () => {
    const { file } = await home();
    await writeFile(file, entry('{"__proto__":["high","low","high"],"a":["low"],"constructor":["max"]}'));
    const first = await SettingsStore.open(file, silentLogger);
    const view = first.modelSettings("pi");
    expect(view.allowedModels).toEqual(["__proto__", "a"]);
    expect(keysOf(view.allowedEfforts)).toEqual(["__proto__", "a", "constructor"]);
    expect(view.allowedEfforts).toEqual(map(["__proto__", ["high", "low"]], ["a", ["low"]], ["constructor", ["max"]]));

    // 改别的（只发模型名单，档位不动）重新落盘：这条记录不能在写回时丢掉。
    await first.setAllowedModels("pi", ["__proto__"]);
    expect(await storedEfforts(file, "pi")).toEqual([["__proto__", ["high", "low"]], ["a", ["low"]], ["constructor", ["max"]]]);
    const second = await SettingsStore.open(file, silentLogger);
    expect(second.modelSettings("pi")).toEqual(first.modelSettings("pi"));
    expect(keysOf(second.modelSettings("pi").allowedEfforts)).toEqual(["__proto__", "a", "constructor"]);
  });

  it("通过更新接口写入：唯一的一条限制叫它，也不会被当成空映射；没变化不写盘，改了它的档位才写", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    store.onChange(changed);

    await store.setAllowedModels("cursor", null, map(["__proto__", ["high", "low", "high"]]));
    expect(keysOf(store.modelSettings("cursor").allowedEfforts)).toEqual(["__proto__"]);
    expect(store.modelSettings("cursor").allowedEfforts).toEqual(map(["__proto__", ["high", "low"]]));
    expect(await storedEfforts(file, "cursor")).toEqual([["__proto__", ["high", "low"]]]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await SettingsStore.open(file, silentLogger)).modelSettings("cursor")).toEqual(store.modelSettings("cursor"));

    const before = await readFile(file, "utf8");
    await store.setAllowedModels("cursor", null, map(["__proto__", ["high", "low"]]));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(before);

    await store.setAllowedModels("cursor", null, map(["__proto__", ["low"]]));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await storedEfforts(file, "cursor")).toEqual([["__proto__", ["low"]]]);

    // 键数一样、只是名字换成别的：不能被当成同一份。
    await store.setAllowedModels("cursor", null, map(["a", ["low"]]));
    expect(changed).toHaveBeenCalledTimes(3);
    expect(keysOf(store.modelSettings("cursor").allowedEfforts)).toEqual(["a"]);
    expect(await storedEfforts(file, "cursor")).toEqual([["a", ["low"]]]);
  });

  it("允许的模型名单里叫它同样往返；它不合格时整体仍无效，不会被跳过", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("pi", ["__proto__", "a"], map(["a", ["low"]]));
    expect(store.modelSettings("pi")).toEqual({ allowedModels: ["__proto__", "a"], allowedEfforts: { a: ["low"] } });

    const rejected = [map(["__proto__", []]), map(["a", ["low"]], ["__proto__", [" high"]]), map(["__proto__", ["high"]], ["b", []])];
    for (const bad of rejected) await expect(store.setAllowedModels("pi", ["a"], bad)).rejects.toMatchObject({ code: "invalid_request" });
    expect(store.modelSettings("pi")).toEqual({ allowedModels: ["__proto__", "a"], allowedEfforts: { a: ["low"] } });

    const harnesses = {
      empty: '{"allowedEfforts":{"__proto__":[]}}',
      notList: '{"allowedEfforts":{"a":["low"],"__proto__":"high"}}',
      fine: '{"allowedEfforts":{"__proto__":["high"]}}',
    };
    await writeFile(file, `{"version":1,"harnesses":{${Object.entries(harnesses).map(([name, text]) => `"${name}":${text}`).join(",")}}}`);
    const reopened = await SettingsStore.open(file, silentLogger);
    expect(reopened.modelSettings("empty" as never)).toEqual({ modelSettingsIssue: "invalid_entry" });
    expect(reopened.modelSettings("notList" as never)).toEqual({ modelSettingsIssue: "invalid_entry" });
    expect(keysOf(reopened.modelSettings("fine" as never).allowedEfforts)).toEqual(["__proto__"]);
  });

  it("空映射仍然等于没有记录（读文件、写入两条路径一样）", async () => {
    const { file } = await home();
    await writeFile(file, entry("{}"));
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.modelSettings("pi")).toEqual({ allowedModels: ["__proto__", "a"] });

    await store.setAllowedModels("pi", ["a"], map(["__proto__", ["low"]]));
    expect(keysOf(store.modelSettings("pi").allowedEfforts)).toEqual(["__proto__"]);
    await store.setAllowedModels("pi", ["a"], {});
    expect(store.modelSettings("pi")).toEqual({ allowedModels: ["a"] });
    expect(await storedEfforts(file, "pi")).toEqual([]);
  });
});

describe("读不了的设置文件", () => {
  const unusable: Array<[string, string]> = [
    ["不是合法的 JSON", "{ not json"],
    ["版本不认识", JSON.stringify({ version: 2, harnesses: {} })],
    ["执行端设置不是映射", JSON.stringify({ version: 1, harnesses: [] })],
  ];

  it.each(unusable)("%s：保留原文件，禁止委派和改写，重启后也不放开", async (_label, content) => {
    const { dir, file } = await home();
    await writeFile(file, content);
    const error = vi.fn();
    const store = await SettingsStore.open(file, { ...silentLogger, error });

    expect(store.modelSettings("cursor")).toEqual({ modelSettingsIssue: "unreadable_file" });
    expect(error).toHaveBeenCalledTimes(1);
    await expect(store.setAllowedModels("cursor", ["a"])).rejects.toMatchObject({ code: "model_settings_unavailable" });
    expect(await readdir(dir)).toEqual(["settings.json"]);
    expect(await readFile(file, "utf8")).toBe(content);
    expect((await SettingsStore.open(file, silentLogger)).modelSettings("pi")).toEqual({ modelSettingsIssue: "unreadable_file" });
  });

  it("只有损坏的执行端需要修复，保存其他名单不会覆盖它", async () => {
    const { file } = await home();
    const malformed = { allowedModels: ["bad", 3], futureOption: "keep me" };
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { codex: malformed, pi: { allowedModels: [] }, cursor: null } }));
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.modelSettings("codex")).toEqual({ modelSettingsIssue: "invalid_entry" });
    expect(store.modelSettings("cursor")).toEqual({ modelSettingsIssue: "invalid_entry" });
    expect(store.modelSettings("pi")).toEqual({ allowedModels: [] });
    expect(store.modelSettings("claude")).toEqual({});

    await store.setAllowedModels("pi", ["pi-small"]);
    expect(await readJson(file)).toMatchObject({ harnesses: { codex: malformed, cursor: null, pi: { allowedModels: ["pi-small"] } } });

    await store.setAllowedModels("codex", null);
    expect(store.modelSettings("codex")).toEqual({});
    expect(await readJson(file)).toMatchObject({ harnesses: { codex: { futureOption: "keep me" } } });
  });

  it("空的 harnesses、没有 harnesses 字段都是合法的", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1 }));
    expect((await SettingsStore.open(file, silentLogger)).modelSettings("cursor")).toEqual({});
    await writeFile(file, JSON.stringify({ version: 1, harnesses: {} }));
    expect((await SettingsStore.open(file, silentLogger)).modelSettings("cursor")).toEqual({});
  });
});

describe("用户指定的默认模型（userDefaultModel）", () => {
  it("和名单一起落盘，重启后仍在；不设限时也能指定（条目里只有它）", async () => {
    const { file } = await home();
    const first = await SettingsStore.open(file, silentLogger);
    await first.setAllowedModels("cursor", ["a", "b"], undefined, "b");
    await first.setAllowedModels("pi", null, undefined, "p-large");

    const second = await SettingsStore.open(file, silentLogger);
    expect(second.modelSettings("cursor")).toEqual({ allowedModels: ["a", "b"], userDefaultModel: "b" });
    expect(second.modelSettings("pi")).toEqual({ userDefaultModel: "p-large" });
    expect(await readJson(file)).toEqual({
      version: 1,
      harnesses: { cursor: { allowedModels: ["a", "b"], userDefaultModel: "b" }, pi: { userDefaultModel: "p-large" } },
    });
  });

  it("旧文件（没有这个字段）照常工作；条目里这一版不认识的字段在改默认时原样保留", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { codex: { allowedModels: ["x", "y"], futureOption: { keep: true } } } }));
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.modelSettings("codex")).toEqual({ allowedModels: ["x", "y"] });

    await store.setAllowedModels("codex", ["x", "y"], undefined, "y");
    expect(await readJson(file)).toEqual({ version: 1, harnesses: { codex: { allowedModels: ["x", "y"], futureOption: { keep: true }, userDefaultModel: "y" } } });
  });

  it("省略＝不改动（旧版页面只发名单），null＝清掉；只清默认时条目里别的设置仍在", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("cursor", ["a", "b"], { a: ["low"] }, "a");

    await store.setAllowedModels("cursor", ["a", "b", "c"]);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["a", "b", "c"], allowedEfforts: { a: ["low"] }, userDefaultModel: "a" });

    await store.setAllowedModels("cursor", ["a", "b", "c"], undefined, null);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["a", "b", "c"], allowedEfforts: { a: ["low"] } });

    // 只剩默认、再把它清掉：条目随之消失，文件里不留空壳。
    await store.setAllowedModels("pi", null, undefined, "p");
    await store.setAllowedModels("pi", null, undefined, null);
    expect(store.modelSettings("pi")).toEqual({});
    expect(await readJson(file)).toEqual({ version: 1, harnesses: { cursor: { allowedModels: ["a", "b", "c"], allowedEfforts: { a: ["low"] } } } });
  });

  it("没有变化时不写盘也不通知；改了默认才通知", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    const changed = vi.fn();
    await store.setAllowedModels("cursor", ["a", "b"], undefined, "a");
    store.onChange(changed);
    const before = await readFile(file, "utf8");

    await store.setAllowedModels("cursor", ["a", "b"], undefined, "a");
    await store.setAllowedModels("cursor", ["a", "b"]);
    expect(changed).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(before);

    await store.setAllowedModels("cursor", ["a", "b"], undefined, "b");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("cursor");
  });

  it("新名单把默认模型排除在外时，同一次写入里清掉它（含空名单）；名单还包含它或回到不设限则保留", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("cursor", ["a", "b", "c"], undefined, "b");

    await store.setAllowedModels("cursor", ["a", "b"]);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["a", "b"], userDefaultModel: "b" });

    await store.setAllowedModels("cursor", null);
    expect(store.modelSettings("cursor")).toEqual({ userDefaultModel: "b" });

    await store.setAllowedModels("cursor", ["a", "b"]);
    await store.setAllowedModels("cursor", ["a", "c"]);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["a", "c"] });
    expect(await readJson(file)).toEqual({ version: 1, harnesses: { cursor: { allowedModels: ["a", "c"] } } });

    await store.setAllowedModels("cursor", ["a", "c"], undefined, "c");
    await store.setAllowedModels("cursor", []);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: [] });
  });

  it("排除与指定在同一次保存里：名单里没有它就拒绝，磁盘与内存都不变", async () => {
    const { file } = await home();
    const store = await SettingsStore.open(file, silentLogger);
    await store.setAllowedModels("cursor", ["a", "b"], undefined, "a");
    const before = await readFile(file, "utf8");
    const changed = vi.fn();
    store.onChange(changed);

    await expect(store.setAllowedModels("cursor", ["a", "b"], undefined, "z")).rejects.toMatchObject({ code: "model_not_allowed" });
    await expect(store.setAllowedModels("cursor", [], undefined, "a")).rejects.toMatchObject({ code: "model_not_allowed" });
    for (const bad of ["", " a", "a "]) {
      await expect(store.setAllowedModels("cursor", null, undefined, bad)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["a", "b"], userDefaultModel: "a" });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(changed).not.toHaveBeenCalled();
  });

  it("文件里的默认模型不合格（不是字符串、空串、首尾带空白）时，这个执行端按损坏处理，重新保存即可修复", async () => {
    const { file } = await home();
    const bad: unknown[] = [3, "", " a", null, ["a"]];
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { ...Object.fromEntries(bad.map((value, index) => [`h${index}`, { allowedModels: ["a"], userDefaultModel: value }])), pi: { userDefaultModel: "ok" } } }));
    const store = await SettingsStore.open(file, silentLogger);
    for (const index of bad.keys()) expect(store.modelSettings(`h${index}` as never)).toEqual({ modelSettingsIssue: "invalid_entry" });
    expect(store.modelSettings("pi")).toEqual({ userDefaultModel: "ok" });

    // 损坏条目里的旧默认不当作“不改动”留下。
    await store.setAllowedModels("h0" as never, ["a"]);
    expect(store.modelSettings("h0" as never)).toEqual({ allowedModels: ["a"] });
  });

  it("手改文件造成的“默认没在名单里”按原样读回，不在读取时悄悄清掉（由规则层说明失效）", async () => {
    const { file } = await home();
    await writeFile(file, JSON.stringify({ version: 1, harnesses: { cursor: { allowedModels: ["a"], userDefaultModel: "gone" } } }));
    const store = await SettingsStore.open(file, silentLogger);
    expect(store.modelSettings("cursor")).toEqual({ allowedModels: ["a"], userDefaultModel: "gone" });
  });
});
