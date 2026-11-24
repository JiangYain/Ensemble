import { retentionFault } from "@shared/archive";
import { isConcurrencyValue } from "@shared/concurrency";
import { isModelId } from "@shared/models";
import { PROFILE_FIELD_MAX, type ProfileSpec } from "@shared/profiles";
import type { ConcurrencyValue, RetentionSettings } from "@shared/protocol";
import type { AccessLevel } from "@shared/types";

/**
 * settings.json 与内存里的 `SettingsFile` 之间的编解码（读写与提交过程在 settings.ts 的 SettingsStore）。
 * 这里只回答“文件里是什么样子”，不回答“用户这一次想把它改成什么”：后者（提交的取值检查、判重、下一版怎么算）留在 settings.ts，
 * 两边不混在一起。
 *
 * 解码的共同原则：认不出的东西原样留着、写回时原样写出，不会因为这一版不认识、或者局部损坏就被抹掉——
 * - 顶层认不出的键进 `rest`；执行端、角色、留存条目里认不出的字段留在条目自己的 `value` 里；
 * - 条目整个不合格，或并发上限、留存这两项的值不合格：存成 `{ ok: false, value }`，`value` 是文件里的原值，读者看到的是“无效”；
 * - 只有整份文件无法使用（不是合法的 JSON、不是对象、版本不认识、harnesses 或 profiles 不是对象）才整体拒绝，
 *   由调用方留着原文件，不拿一份空设置去覆盖用户的文件。
 */

export type Efforts = Record<string, string[]>;
export type HarnessSettings = Record<string, unknown> & { allowedModels?: string[]; allowedEfforts?: Efforts; userDefaultModel?: string };
export type StoredEntry = { ok: true; value: HarnessSettings } | { ok: false; value: unknown };
export type Entries = Map<string, StoredEntry>;
/** 角色条目：认得的字段按类型留着、认不出的字段原样保留；整条不合格的原样留着，读者看到的是“无效”。 */
export type ProfileFields = Record<string, unknown> & ProfileSpec;
export type StoredProfile = { ok: true; value: ProfileFields } | { ok: false; value: unknown };
export type Profiles = Map<string, StoredProfile>;
/** 并发上限在文件里的样子：认得的值按值留着；写了但不合格的原样留着，读者看到的是“无效”（与执行端、角色条目同一套处理）。 */
export type StoredConcurrency = { ok: true; value: ConcurrencyValue } | { ok: false; value: unknown };
/** 留存策略在文件里的样子：认得的两项按取值留着、认不出的字段原样保留；整个值不合格的原样留着，读者看到的是“关闭”。 */
export type RetentionFields = Record<string, unknown> & RetentionSettings;
export type StoredRetention = { ok: true; value: RetentionFields } | { ok: false; value: unknown };

/**
 * 文件的全部内容：整份读入、整份写回，每次写盘都基于内存里最近一次落盘的整份（不重新读盘）——所以改执行端的设置不会带丢角色，反过来也一样。
 * `rest` 是这一版不认识的顶层键，原样存、原样写回。
 */
export interface SettingsFile {
  harnesses: Entries;
  profiles: Profiles;
  /** 没有这一项（undefined）＝文件里没有 maxConcurrentRuns 这个键。 */
  maxConcurrentRuns?: StoredConcurrency;
  /** 没有这一项（undefined）＝文件里没有 retention 这个键（留存关闭）。 */
  retention?: StoredRetention;
  rest: ReadonlyMap<string, unknown>;
}

const VERSION = 1;
/** 这一版认得的顶层键；其余的进 `rest`。 */
const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set(["version", "harnesses", "profiles", "maxConcurrentRuns", "retention"]);

/** 没有文件时的设置：什么都没有指定（与只有 `{ "version": 1 }` 的文件解出来的一样）。每次返回新的一份，调用方各拿各的。 */
export function emptyFile(): SettingsFile {
  return { harnesses: new Map(), profiles: new Map(), rest: new Map() };
}

// ───────────────────────── 共用的小判断（文件解析与提交校验都用） ─────────────────────────

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 长度受限的非空文本（执行端、模型、推理强度）：与委派请求里同名字段的规则一致。 */
export function isBounded(value: unknown, max: number): value is string {
  return isModelId(value) && value.length <= max;
}

export function isAccessLevel(value: unknown): value is AccessLevel {
  return value === "full" || value === "read_only";
}

/**
 * 档位记录的解析边界：入参来自文件或请求体，还没验证过。先验证并收集键值对，最后用 Object.fromEntries 构造——
 * 不能写 `result[id] = …`：模型 id 可以叫 `__proto__`，对普通对象这样赋值改的是原型，这条限制会悄悄消失，
 * 从“有限制”退化成“没有记录 = 不设限”。
 * 每个模型的档位去重并保持给定顺序；空映射等于没有记录（undefined）；任何一项不合格整体视为无效。
 */
export function normalizeEfforts(value: unknown): Efforts | undefined | "invalid" {
  const map = asObject(value);
  if (!map) return "invalid";
  const pairs: Array<[string, string[]]> = [];
  for (const [id, list] of Object.entries(map)) {
    if (!isModelId(id) || !Array.isArray(list) || list.length === 0 || !list.every(isModelId)) return "invalid";
    pairs.push([id, [...new Set<string>(list)]]);
  }
  return pairs.length === 0 ? undefined : Object.fromEntries(pairs);
}

// ───────────────────────── 解码 ─────────────────────────

export function parseHarness(value: unknown): StoredEntry {
  const entry = asObject(value);
  if (!entry) return { ok: false, value };
  const { allowedModels, allowedEfforts, userDefaultModel, ...fields } = entry;
  const settings: HarnessSettings = { ...fields };
  if (userDefaultModel !== undefined) {
    if (!isModelId(userDefaultModel)) return { ok: false, value };
    settings.userDefaultModel = userDefaultModel;
  }
  if (allowedModels !== undefined) {
    if (!Array.isArray(allowedModels) || !allowedModels.every(isModelId)) return { ok: false, value };
    settings.allowedModels = [...new Set<string>(allowedModels)];
  }
  if (allowedEfforts !== undefined) {
    const efforts = normalizeEfforts(allowedEfforts);
    if (efforts === "invalid") return { ok: false, value };
    if (efforts !== undefined) settings.allowedEfforts = efforts;
  }
  return { ok: true, value: settings };
}

/** 文件里的一条角色：执行端必须是合格文本；模型、强度、访问权限没有就是“不固定”，写了就必须合格，否则整条无效（交给用户改好或删掉）。 */
export function parseProfile(value: unknown): StoredProfile {
  const entry = asObject(value);
  if (!entry) return { ok: false, value };
  const { harness, model, effort, access, ...fields } = entry;
  if (!isBounded(harness, PROFILE_FIELD_MAX.harness)) return { ok: false, value };
  if (model !== undefined && !isBounded(model, PROFILE_FIELD_MAX.model)) return { ok: false, value };
  if (effort !== undefined && !isBounded(effort, PROFILE_FIELD_MAX.effort)) return { ok: false, value };
  if (access !== undefined && !isAccessLevel(access)) return { ok: false, value };
  return {
    ok: true,
    value: {
      harness,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(access === undefined ? {} : { access }),
      ...fields,
    },
  };
}

/**
 * 文件里的并发上限：合法的取值（见 shared/concurrency.ts）按值留着；其余一切（负数、小数、0、超范围、字符串、null、数组……）
 * 都是“无效”，原值原样留着、写回时原样写出，读者看到的是“无效”而不是被悄悄抹掉或改成别的值。
 */
export function parseConcurrency(value: unknown): StoredConcurrency {
  return isConcurrencyValue(value) ? { ok: true, value } : { ok: false, value };
}

/**
 * 文件里的留存策略：必须是对象；keepDays / keepCount 缺省＝null（不限），写了就必须合格（null 或 1 到上限的整数）。
 * 认得的两项以外的字段原样保留；其余一切不合格的都是“无效”，原值原样留着、写回时原样写出。
 */
export function parseRetention(value: unknown): StoredRetention {
  const entry = asObject(value);
  if (!entry) return { ok: false, value };
  const { keepDays: rawDays, keepCount: rawCount, ...fields } = entry;
  const keepDays = rawDays ?? null;
  const keepCount = rawCount ?? null;
  if (retentionFault("keepDays", keepDays) !== undefined || retentionFault("keepCount", keepCount) !== undefined) return { ok: false, value };
  return { ok: true, value: { keepDays: keepDays as number | null, keepCount: keepCount as number | null, ...fields } };
}

export type ParsedFile = { ok: true; data: SettingsFile } | { ok: false; reason: string };

export function parseFile(raw: string): ParsedFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  const file = asObject(value);
  if (!file) return { ok: false, reason: "not an object" };
  if (file["version"] !== VERSION) return { ok: false, reason: "unsupported settings version" };
  // 没有这两个键等于空；有但不是对象，整份文件按“无法识别”处理（与 harnesses 一致：不拿一份残缺的当成空设置去覆盖用户的文件）。
  const harnesses: Record<string, unknown> | undefined = file["harnesses"] === undefined ? {} : asObject(file["harnesses"]);
  if (!harnesses) return { ok: false, reason: "harnesses is not an object" };
  const profiles: Record<string, unknown> | undefined = file["profiles"] === undefined ? {} : asObject(file["profiles"]);
  if (!profiles) return { ok: false, reason: "profiles is not an object" };
  // 并发上限与上面两项不同：值不合格不会让整份文件作废（上限落回环境变量 / 内置默认，其余设置照常），只把这一项记为无效。
  const maxConcurrentRuns = file["maxConcurrentRuns"];
  // 留存策略同理：值不合格只把这一项记为无效（按“关闭”处理），其余设置照常。
  const retention = file["retention"];
  return {
    ok: true,
    data: {
      harnesses: new Map(Object.entries(harnesses).map(([id, entry]) => [id, parseHarness(entry)])),
      profiles: new Map(Object.entries(profiles).map(([name, entry]) => [name, parseProfile(entry)])),
      ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: parseConcurrency(maxConcurrentRuns) }),
      ...(retention === undefined ? {} : { retention: parseRetention(retention) }),
      rest: new Map(Object.entries(file).filter(([key]) => !KNOWN_TOP_LEVEL.has(key))),
    },
  };
}

// ───────────────────────── 编码 ─────────────────────────

/**
 * 写回的整份内容：顶层键的顺序固定为 version、harnesses、profiles（有才写）、maxConcurrentRuns（有才写）、retention（有才写）、其余原样。
 * 用键值对数组再 Object.fromEntries 构造：角色名、执行端 id 都可能叫 `__proto__` 或 `constructor`，直接给对象赋值会出事。
 */
export function serialize({ harnesses, profiles, maxConcurrentRuns, retention, rest }: SettingsFile): Record<string, unknown> {
  const pairs: Array<[string, unknown]> = [
    ["version", VERSION],
    ["harnesses", Object.fromEntries([...harnesses].map(([id, entry]) => [id, entry.value]))],
  ];
  if (profiles.size > 0) pairs.push(["profiles", Object.fromEntries([...profiles].map(([name, entry]) => [name, entry.value]))]);
  if (maxConcurrentRuns !== undefined) pairs.push(["maxConcurrentRuns", maxConcurrentRuns.value]);
  if (retention !== undefined) pairs.push(["retention", retention.value]);
  pairs.push(...rest);
  return Object.fromEntries(pairs);
}

/** 写进磁盘的文本：整份、缩进两格、末尾一个换行。落盘的格式只此一处。 */
export function encodeFile(file: SettingsFile): string {
  return `${JSON.stringify(serialize(file), null, 2)}\n`;
}
