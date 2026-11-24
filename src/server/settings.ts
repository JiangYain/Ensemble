import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { retentionFault } from "@shared/archive";
import { CONCURRENCY_RULE, isConcurrencyValue } from "@shared/concurrency";
import { errorMessage } from "@shared/format";
import { isModelId } from "@shared/models";
import { describeNameFault, normalizeProfileName, PROFILE_FIELD_MAX, PROFILE_LIMIT, profileNameFault, type ProfileEntry, type ProfileSpec, type ProfilesView } from "@shared/profiles";
import type { ConcurrencySetting, ConcurrencyValue, RetentionSettings } from "@shared/protocol";
import type { HarnessId, ModelSettingsView } from "@shared/types";
import { writeFileAtomic } from "./atomic-file";
import { EnsembleError, type ErrorCode } from "./errors";
import type { Logger } from "./logger";
import {
  asObject,
  emptyFile,
  encodeFile,
  isAccessLevel,
  isBounded,
  normalizeEfforts,
  parseFile,
  type Efforts,
  type HarnessSettings,
  type ProfileFields,
  type Profiles,
  type RetentionFields,
  type SettingsFile,
  type StoredProfile,
  type StoredRetention,
} from "./settings-file";

/**
 * 用户在配置页里做的取舍，持久化在状态目录的 settings.json。
 *
 * 放在服务端而不是浏览器里：Codex、Cursor 等不同宿主拉起的 MCP 桥和网页连的是同一个服务，
 * 它们看到的必须是同一份设置；服务重启、换一个浏览器、换一个宿主都不应该丢。
 *
 * 目前有三项，都属于“某个执行端开放给主 Agent 的东西”，一起读写、一起落盘：
 * - allowedModels：开放的模型；
 * - allowedEfforts：按模型 id 记录允许选用的推理档位（旧文件没有这一项，等于档位不设限）；
 * - userDefaultModel：用户指定的默认模型（旧文件没有这一项，等于沿用执行端自己的默认）。它与 allowedModels 一起落盘，
 *   是为了让“新名单把它排除在外”与“清掉它”发生在同一次写入里：任何时刻磁盘上都不会有“默认模型没被开放”的中间状态
 *   （手改文件造成的除外——那种失效由规则层如实说明，见 shared/models.ts）。
 * 文件里认不出的执行端条目、条目里认不出的字段原样保留，不会因为这一版不认识就被抹掉。
 *
 * 顶层还有 `profiles`（委派角色：名字 → 执行端 / 模型 / 推理强度 / 访问权限，规则见 shared/profiles.ts），与 `harnesses` 同级、
 * 同一个文件、同一条写盘队列——两类设置的写入互相看得到对方最新的内容，谁也不会用旧快照把对方的改动写丢。没有角色时不写这个键，
 * 文件与没有这项功能之前完全一样。顶层认不出的键（以后的版本、别的功能加的）同样原样保留：对任何顶层键都成立，不是只认得 `profiles`。
 * 新增一个顶层设置时：在 settings-file.ts 的 KNOWN_TOP_LEVEL 里登记、在 parseFile 里取出、在 serialize 里写出，再在这里写一个 plan 函数、
 * 经同一个 `update` 提交。
 *
 * 顶层 `maxConcurrentRuns` 是全局并发运行数上限：正整数（1–1000），或字符串 "unlimited"（不设上限）；没有这个键＝用户没指定，
 * 回落到环境变量 / 内置默认（合成规则见 concurrency.ts）。它与执行端、角色同文件、同一条写盘队列，用上面那套方式新增。
 * 与前两类设置不同的是：写入成功之后改变的是正在运行的服务本身（立即生效，不重启），所以通知走 onConcurrencyChange。
 * 文件里写了但不合格的值（负数、小数、0、非数字、超出范围）按“没指定”处理：服务照常启动，文件里的原值原样保留、不静默改写——
 * 改别的设置时它也随整份文件原样写回——直到用户在页面里重新设置，或点“恢复默认”（删掉这个键）才被覆盖。
 *
 * 顶层 `retention` 是历史会话的留存策略：`{ keepDays, keepCount }`，null＝这一项不限；没有这个键或两项都是 null＝关闭（默认关闭）。
 * 它只决定“多久之后自动归档”，永远不会删除会话（规则见 shared/archive.ts 的 planRetention，执行见 retention.ts）。
 * 与并发上限同一套处理：同文件、同一条写盘队列；文件里写了但不合格的值（0、负数、小数、过大、非数字）按“关闭”处理、
 * 原值原样保留，直到用户在页面里重新保存；保存成两项都不限时删掉这个键。与并发上限不同，改动不需要通知任何人——
 * 清扫器每次开始时现读设置，保存入口（PUT /api/retention）自己随即触发一次清扫。
 *
 * 分工：文件内容的编解码（解析、保留认不出的内容、写回）在 settings-file.ts；这里管读、提交的取值检查，
 * 以及“排队、落盘、替换内存、通知”这唯一一个提交点（`update`）。五种写入（执行端设置、角色新增或改写、角色改名、并发上限、留存策略）
 * 各自只写一个 plan 函数：轮到自己时拿到当前的整份设置（内存里最近一次落盘的那份，不重新读盘，见 `update`），
 * 返回下一版加上要通知谁，或者返回 undefined 表示没有变化；
 * 落盘、替换内存、通知，以及监听器抛错的隔离，都不在它们手里。
 */

export type SettingsListener = (harness: HarnessId) => void;
export type ProfilesListener = () => void;
export type ConcurrencyListener = () => void;

/** 文件里并发上限这一项此刻的样子：有效的存值，或问题（见 ConcurrencySetting.issue）；两者不会同时出现。 */
export interface StoredConcurrencyView {
  value?: ConcurrencyValue;
  issue?: ConcurrencySetting["issue"];
}

/** 文件里的四块设置（分区）：执行端的模型设置、角色、并发上限、留存策略。 */
type Area = "models" | "roles" | "concurrency" | "retention";

const unreadable = (what: string): string => `Ensemble could not read settings.json. Restore a valid settings file and restart Ensemble before changing ${what}.`;

/**
 * 整个文件读不了时，各块拒绝改动的方式。错误码与文案都是对外的行为，不合并成一个默认值：
 * 文案四块各写各的（读的一侧也各有各的说法：modelSettings / profilesView / concurrency / retention），错误码分两类——
 * 模型与角色是 model_settings_unavailable，并发上限与留存是 conflict。
 * 后两块不用 model_settings_unavailable：它的文案和网页上的提示都是“模型设置”，它们不是。
 * 角色没有这样分开，沿用 model_settings_unavailable（带 profile 的委派在设置读不了时也拒绝成这个码，见 profiles.ts；
 * settings-file.test.ts 钉住了这份对应），所以页面上保存角色失败的提示标题是“模型设置不可用”，括号里才是写着 roles 的服务端原文。
 * 要把角色换成别的码，得连同网页的提示与这些测试一起改；这里没有动。
 */
const UNAVAILABLE: Record<Area, { code: ErrorCode; message: string }> = {
  models: { code: "model_settings_unavailable", message: unreadable("model settings") },
  roles: { code: "model_settings_unavailable", message: unreadable("roles") },
  concurrency: { code: "conflict", message: unreadable("the concurrency limit") },
  retention: { code: "conflict", message: unreadable("the retention policy") },
};

/** 落盘之后要通知谁（留存策略没有订阅者，不通知）。 */
type Notice = { kind: "model"; harness: HarnessId } | { kind: "profiles" } | { kind: "concurrency" };

/** 一项修改算出来的结果：下一版整份文件，加上落盘之后要通知谁。 */
interface Change {
  /** 这次修改之后的整份文件：基于传入的当前内容复制出来，不改动它——落盘失败时内存里的当前内容必须原样不变。 */
  next: SettingsFile;
  notice?: Notice;
}

/**
 * 一项设置自己的修改：轮到它时才拿到当前的整份设置（内存里最近一次落盘的那份，见 `update`），返回下一版与通知；
 * 返回 undefined＝没有变化（不写盘、不通知）；抛错＝拒绝（什么也不写）。只算，不碰存储。
 */
type Plan = (current: SettingsFile) => Change | undefined;

export class SettingsStore {
  /**
   * 当前的整份设置：启动时读入，之后只在落盘成功之后才被替换，所以它就是最近一次落盘的那一份（写盘时不会重新读盘，见 `update`）。
   * undefined：已有文件无法读取或无法识别，不能当成一份空设置。
   */
  private data: SettingsFile | undefined;
  /** 写盘排队：同一时刻只有一次写，后来的在前一次落盘（或失败）后基于最新状态再写。 */
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<SettingsListener>();
  private readonly profileListeners = new Set<ProfilesListener>();
  private readonly concurrencyListeners = new Set<ConcurrencyListener>();

  private constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  /** 读取失败时保留原文件，并让服务仍能展示已有会话。 */
  static async open(file: string, log: Logger): Promise<SettingsStore> {
    const store = new SettingsStore(file, log);
    await store.load();
    return store;
  }

  modelSettings(harness: HarnessId): ModelSettingsView {
    if (!this.data) return { modelSettingsIssue: "unreadable_file" };
    const entry = this.data.harnesses.get(harness);
    if (entry?.ok === false) return { modelSettingsIssue: "invalid_entry" };
    const { allowedModels, allowedEfforts, userDefaultModel } = entry?.value ?? {};
    return {
      ...(allowedModels === undefined ? {} : { allowedModels: [...allowedModels] }),
      ...(allowedEfforts === undefined ? {} : { allowedEfforts: cloneEfforts(allowedEfforts) }),
      ...(userDefaultModel === undefined ? {} : { userDefaultModel }),
    };
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 角色表变了（落盘之后）通知一次：网页靠它在多个标签页之间保持一致。 */
  onProfilesChange(listener: ProfilesListener): () => void {
    this.profileListeners.add(listener);
    return () => this.profileListeners.delete(listener);
  }

  /**
   * 并发上限这一项在文件里此刻的样子：有效的存值；或问题——整个文件读不出来（服务按“没指定”处理，也不允许在页面里改），
   * 或写了但无效（没有 `value`，同样按“没指定”处理，文件里的原值原样留着）。没写这个键时两者都没有。
   */
  concurrency(): StoredConcurrencyView {
    if (!this.data) return { issue: "unreadable_file" };
    const stored = this.data.maxConcurrentRuns;
    if (!stored) return {};
    return stored.ok ? { value: stored.value } : { issue: "invalid_value" };
  }

  /**
   * 指定并发上限：正整数或 "unlimited"；`null` 删掉这个键（回到环境变量 / 内置默认）。落盘成功之后才生效并通知，
   * 写失败就抛出、内存里的设置不变——页面上看到的与磁盘上的不会分叉。
   * 新值与已存的相同就什么也不做（不写盘、不通知）：重复点击、两个标签页同时设成同一个值。
   * 文件整个读不了时拒绝（与执行端、角色同一条规矩：不拿一份空设置去覆盖用户的文件）；
   * 文件里的旧值无效时可以直接写（用户正是在修它），“恢复默认”也会把它删掉。
   */
  setConcurrency(value: ConcurrencyValue | null): Promise<void> {
    return this.update("concurrency", (current) => planConcurrency(current, value));
  }

  /** 并发上限的设置变了（落盘之后）通知一次：服务靠它把新上限交给 SessionManager，并推给所有页面。 */
  onConcurrencyChange(listener: ConcurrencyListener): () => void {
    this.concurrencyListeners.add(listener);
    return () => this.concurrencyListeners.delete(listener);
  }

  /**
   * 当前的留存策略（只归档、不删除）。没有这个键、值不合格、文件整个读不出来，都等于“关闭”（两项都是 null）——
   * 留存是自动整理，拿不准时宁可什么也不做。
   */
  retention(): RetentionSettings {
    const stored = this.data?.retention;
    return stored?.ok ? { keepDays: stored.value.keepDays, keepCount: stored.value.keepCount } : { keepDays: null, keepCount: null };
  }

  /**
   * 保存留存策略：两项都必须给（null＝这一项不限）；取值规则只有 shared/archive.ts 的 retentionFault 一处。
   * 两项都不限时删掉这个键（文件回到没有这项功能之前的样子）。落盘成功之后才生效，写失败就抛出、内存里的设置不变。
   * 新值与已存的相同就什么也不做（不写盘）。文件整个读不了时拒绝（不拿一份空设置去覆盖用户的文件）；
   * 文件里的旧值无效时可以直接写（用户正是在修它）。
   */
  setRetention(value: RetentionSettings): Promise<void> {
    return this.update("retention", (current) => planRetention(current, value));
  }

  /** 角色表（按创建顺序）。文件整个读不了时是“不可用”，不是“没有角色”。 */
  profilesView(): ProfilesView {
    if (!this.data) return { entries: [], unavailable: "unreadable_file" };
    return { entries: [...this.data.profiles].map(([name, stored]) => entryView(name, stored)) };
  }

  /**
   * 新增或整条改写一个角色；`null` 删除。名字规范化（去空白、转小写）后落盘，查找时对大小写宽容。
   * - 整条改写：这次给出的取值就是全部（没给的字段＝不固定、会被去掉），条目里认不出的字段原样保留；
   * - `create`：名字已存在就拒绝。网页的“新增”带上它，两个标签页同时用同一个名字新增时，后到的不会悄悄覆盖先到的；
   * - 删除不存在的角色不算错（幂等：重复点击、两个标签页同时删），也不写盘、不通知；
   * - 数量上限只在新增时检查：手改文件超过上限的，仍可以改、可以删。
   * 每次只动一个角色，从不整表覆盖；与 setAllowedModels 走同一条写盘队列，落盘成功之后才生效并通知。
   */
  setProfile(name: string, profile: ProfileSpec | null, options: { create?: boolean } = {}): Promise<void> {
    return this.update("roles", (current) => planProfile(current, name, profile, options.create === true));
  }

  /**
   * 改名：保持原来的位置，旧名字与新名字不会同时出现在任何一次落盘里（一次写入完成）。
   * 没有原名字拒绝为 not_found（404，`details.name` 是请求里原样写的名字）；新名字不合规或已被占用拒绝为 invalid_request（400）；
   * 改成同一个名字什么也不做。
   */
  renameProfile(from: string, to: string): Promise<void> {
    return this.update("roles", (current) => planRename(current, from, to));
  }

  /**
   * 保存某个执行端开放的模型；`null` 去掉限制。`efforts` 是按模型 id 的完整档位记录（每项非空），
   * 省略表示不改动已有记录（旧版页面只会发模型名单），传 `{}` 则清空。
   * `userDefault` 是用户指定的默认模型：字符串＝指定（有限制时必须在这次的名单里），`null`＝清掉（回到执行端自己的默认），
   * 省略＝不改动。已指定的默认被这次的名单排除在外（含空名单）时，在同一次写入里清掉；不设限（`null` 名单）则保留。
   * 落盘成功之后才生效并通知，写失败就抛出、内存里的设置不变，这样页面上看到的与磁盘上的不会分叉。
   */
  setAllowedModels(harness: HarnessId, allowed: readonly string[] | null, efforts?: Readonly<Record<string, readonly string[]>>, userDefault?: string | null): Promise<void> {
    return this.update("models", (current) => planModels(current, harness, allowed, efforts, userDefault));
  }

  /**
   * 所有设置写入共用的提交点，只有这里落盘、替换内存、通知：
   * 先排队——同一时刻只有一次写，后来的在前一次落盘（或失败）之后才轮到；轮到时取内存里的当前整份设置（`this.data`）交给 `plan` 算下一版，
   * 不重新读盘。`this.data` 只在 `open` 读入文件时和这里落盘成功之后才被替换（写失败不动它），所以它就是最近一次落盘的那一份：
   * 不论前一次是哪一项设置、成功还是失败，后一次看到的基线都是对的。
   * 前提是这个文件只有本进程在写（同一个状态目录靠服务锁只起一个服务，见 service.ts 的 acquireLock）。服务运行期间手改 settings.json，
   * 本进程看不到，下一次写入还会把内存里的整份写回、盖掉手改的内容；手改要在服务停止时做，下次启动才会读入。
   * 落盘成功之后才替换内存、再同步通知；写失败就抛出，内存里的设置不变，页面上看到的与磁盘上的不会分叉。
   */
  private update(area: Area, plan: Plan): Promise<void> {
    const run = this.writing.then(async () => {
      const current = this.data;
      if (!current) {
        const { code, message } = UNAVAILABLE[area];
        throw new EnsembleError(code, message);
      }
      const change = plan(current);
      if (change === undefined) return;
      await this.persist(change.next);
      this.data = change.next;
      this.notify(change.notice);
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  /** 通知订阅者：一个订阅者抛错只记日志，不影响后面的订阅者，也不影响已经落盘的设置。 */
  private notify(notice: Notice | undefined): void {
    if (notice === undefined) return;
    switch (notice.kind) {
      case "model": {
        const { harness } = notice;
        this.fire(this.listeners, "settings listener failed", (listener) => listener(harness));
        break;
      }
      case "profiles":
        this.fire(this.profileListeners, "profiles listener failed", (listener) => listener());
        break;
      case "concurrency":
        // 这一类遍历订阅者的快照（原来就是这样），另两类遍历订阅者集合本身；保持不变。
        this.fire([...this.concurrencyListeners], "concurrency listener failed", (listener) => listener());
        break;
    }
  }

  private fire<Listener>(listeners: Iterable<Listener>, failure: string, call: (listener: Listener) => void): void {
    for (const listener of listeners) {
      try {
        call(listener);
      } catch (error) {
        this.log.warn(failure, { error });
      }
    }
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.data = emptyFile();
      else this.log.error("settings file could not be read; new delegations are blocked", { file: this.file, error });
      return;
    }
    const parsed = parseFile(raw);
    if (!parsed.ok) {
      this.log.error("settings file could not be used; new delegations are blocked", { file: this.file, reason: parsed.reason });
      return;
    }
    this.data = parsed.data;
    const invalid = [...this.data.harnesses].filter(([, entry]) => !entry.ok).map(([id]) => id);
    if (invalid.length > 0) this.log.warn("invalid model settings; new delegations to these harnesses are blocked", { harnesses: invalid });
    const invalidProfiles = [...this.data.profiles].filter(([name, entry]) => !entry.ok || profileNameFault(name) !== undefined).map(([name]) => name);
    if (invalidProfiles.length > 0) this.log.warn("invalid role entries; they cannot be used until fixed in Settings", { profiles: invalidProfiles });
    if (this.data.maxConcurrentRuns?.ok === false) {
      this.log.warn("invalid maxConcurrentRuns in settings; it is ignored (the environment or built-in default applies) and the file is left unchanged", { value: quoted(this.data.maxConcurrentRuns.value) });
    }
    if (this.data.retention?.ok === false) {
      this.log.warn("invalid retention in settings; retention is off and the file is left unchanged", { value: quoted(this.data.retention.value) });
    }
    this.log.info("settings loaded", { harnesses: this.data.harnesses.size, profiles: this.data.profiles.size });
  }

  /**
   * 整份写盘，用 writeFileAtomic：先写同目录下独一无二的临时文件再改名，读取方（以及下次启动）永远看不到写了一半的内容；
   * Windows 上目标被别的进程短暂占用时改名会报 EPERM / EBUSY / EACCES，它会重试，最终失败时清掉临时文件。
   * 它不建目录，所以目录在这里先建好。
   */
  private async persist(contents: SettingsFile): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, encodeFile(contents));
    } catch (error) {
      this.log.error("settings could not be saved", { file: this.file, error });
      throw new Error(`Could not save settings: ${errorMessage(error)}`);
    }
  }
}

// ───────────────────────── 各项设置的修改（只算下一版，不碰存储） ─────────────────────────

function planModels(
  current: SettingsFile,
  harness: HarnessId,
  allowed: readonly string[] | null,
  efforts: Readonly<Record<string, readonly string[]>> | undefined,
  userDefault: string | null | undefined,
): Change | undefined {
  if (allowed?.some((id) => !isModelId(id))) {
    throw new EnsembleError("invalid_request", "Model ids must be non-empty and cannot start or end with whitespace.");
  }
  const nextEfforts = efforts === undefined ? undefined : normalizeEfforts(efforts);
  if (nextEfforts === "invalid") {
    throw new EnsembleError("invalid_request", "Each model's allowed efforts must be a non-empty list of non-empty names without leading or trailing whitespace.");
  }
  const next = allowed === null ? undefined : [...new Set(allowed)];
  if (typeof userDefault === "string") {
    if (!isModelId(userDefault)) {
      throw new EnsembleError("invalid_request", "The default model id must be non-empty and cannot start or end with whitespace.");
    }
    if (next !== undefined && !next.includes(userDefault)) {
      throw new EnsembleError("model_not_allowed", `Model "${userDefault}" cannot be the default: it is not among the allowed models.`, { requested: userDefault, allowed: next });
    }
  }
  const previous = current.harnesses.get(harness);
  // 损坏的条目里的旧档位、旧默认不能当作“不改动”留下来，否则永远修不好。
  const keptEfforts = previous?.ok === false ? undefined : previous?.value.allowedEfforts;
  const keptDefault = previous?.ok === false ? undefined : previous?.value.userDefaultModel;
  const resultEfforts = efforts === undefined ? keptEfforts : nextEfforts;
  const requestedDefault = userDefault === undefined ? keptDefault : userDefault ?? undefined;
  // 新名单把默认模型排除在外：同一次写入里清掉，磁盘上不留“默认没被开放”的状态。
  const resultDefault = requestedDefault !== undefined && next !== undefined && !next.includes(requestedDefault) ? undefined : requestedDefault;
  if (previous?.ok !== false && sameList(previous?.value.allowedModels, next) && sameEfforts(keptEfforts, resultEfforts) && keptDefault === resultDefault) return undefined;

  const harnesses = new Map(current.harnesses);
  const { allowedModels: _models, allowedEfforts: _efforts, userDefaultModel: _default, ...fields } = asObject(previous?.value) ?? {};
  const entry: HarnessSettings = {
    ...fields,
    ...(next === undefined ? {} : { allowedModels: next }),
    ...(resultEfforts === undefined ? {} : { allowedEfforts: resultEfforts }),
    ...(resultDefault === undefined ? {} : { userDefaultModel: resultDefault }),
  };
  if (Object.keys(entry).length === 0) harnesses.delete(harness);
  else harnesses.set(harness, { ok: true, value: entry });

  // 基于当前的整份文件改，角色与认不出的顶层键原样带着。
  return { next: { ...current, harnesses }, notice: { kind: "model", harness } };
}

function planProfile(current: SettingsFile, rawName: string, profile: ProfileSpec | null, create: boolean): Change | undefined {
  if (profile === null) {
    const key = findKey(current.profiles, rawName);
    if (key === undefined) return undefined;
    const profiles = new Map(current.profiles);
    profiles.delete(key);
    return profilesChange(current, profiles);
  }

  const name = normalizeProfileName(rawName);
  const fault = profileNameFault(name);
  if (fault !== undefined) throw new EnsembleError("invalid_request", describeNameFault(fault));
  const spec = checkedSpec(profile);
  const previous = current.profiles.get(name);
  if (previous && create) throw new EnsembleError("invalid_request", `A role named "${name}" already exists.`, { name });
  if (!previous && current.profiles.size >= PROFILE_LIMIT) {
    throw new EnsembleError("invalid_request", `At most ${PROFILE_LIMIT} roles can be defined. Delete one before adding another.`);
  }
  // 原条目里认不出的字段带过去；原条目整条不合格时没有可信的字段，直接被这次的内容替换（用户正是在修它）。
  const { harness: _harness, model: _model, effort: _effort, access: _access, ...extras } = previous?.ok ? previous.value : ({} as ProfileFields);
  const value: ProfileFields = {
    harness: spec.harness,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    ...(spec.access === undefined ? {} : { access: spec.access }),
    ...extras,
  };
  if (previous?.ok && sameProfile(previous.value, value)) return undefined;

  // 已有的名字原位更新（Map 保持插入顺序），新名字排在最后：创建顺序就是展示顺序。
  const profiles = new Map(current.profiles);
  profiles.set(name, { ok: true, value });
  return profilesChange(current, profiles);
}

function planRename(current: SettingsFile, rawFrom: string, rawTo: string): Change | undefined {
  const from = findKey(current.profiles, rawFrom);
  // 要改名的角色不存在是“资源不在”（404），与新名字不合规、已被占用这两种请求本身的问题（400）分开；details.name 仍是请求里原样写的名字。
  // 委派时按名字找不到角色是另一个错误码（profile_not_found，见 profiles.ts），不在这里。
  if (from === undefined) throw new EnsembleError("not_found", `There is no role named "${rawFrom}".`, { name: rawFrom });
  const to = normalizeProfileName(rawTo);
  const fault = profileNameFault(to);
  if (fault !== undefined) throw new EnsembleError("invalid_request", describeNameFault(fault));
  if (to === from) return undefined;
  if (current.profiles.has(to)) throw new EnsembleError("invalid_request", `A role named "${to}" already exists.`, { name: to });
  // 整张表按原顺序重建、只换这一个键：新名字写进去的同时旧名字就不在了，不存在“两个名字都在”的一次落盘。
  const profiles: Profiles = new Map([...current.profiles].map(([key, entry]) => [key === from ? to : key, entry]));
  return profilesChange(current, profiles);
}

/** 角色表的统一落点：整张表换成新的，其余原样带着（执行端设置、并发上限、留存、认不出的顶层键）。 */
function profilesChange(current: SettingsFile, profiles: Profiles): Change {
  return { next: { ...current, profiles }, notice: { kind: "profiles" } };
}

function planConcurrency(current: SettingsFile, value: ConcurrencyValue | null): Change | undefined {
  if (value !== null && !isConcurrencyValue(value)) {
    throw new EnsembleError("invalid_request", `The concurrency limit must be ${CONCURRENCY_RULE}, or null to restore the default.`);
  }
  const previous = current.maxConcurrentRuns;
  // 旧值无效时新值不可能与它“相同”（无效的值不是合法取值），所以只需要比较合法的旧值；
  // 清掉时：旧值无效也要删（用户正是点“恢复默认”来修它），只有本来就没有这个键才算没变。
  if (value === null ? previous === undefined : previous?.ok === true && previous.value === value) return undefined;

  return { next: { ...current, maxConcurrentRuns: value === null ? undefined : { ok: true, value } }, notice: { kind: "concurrency" } };
}

function planRetention(current: SettingsFile, value: RetentionSettings): Change | undefined {
  for (const field of ["keepDays", "keepCount"] as const) {
    const fault = retentionFault(field, value[field]);
    if (fault !== undefined) throw new EnsembleError("invalid_request", fault);
  }
  const previous = current.retention;
  const previousValid = previous?.ok === true ? previous.value : undefined;
  const clearing = value.keepDays === null && value.keepCount === null;
  // 合法的旧值与新值相同才算没变；两项都不限时，本来就没有这个键也算没变（旧值无效要删，用户正是在修它）。
  if (clearing ? previous === undefined : previousValid !== undefined && previousValid.keepDays === value.keepDays && previousValid.keepCount === value.keepCount) return undefined;

  // 认不出的字段（以后的版本加的）原样带过去；旧值整个无效时没有可信的字段，直接被这次的内容替换。
  const { keepDays: _days, keepCount: _count, ...extras } = previousValid ?? ({} as RetentionFields);
  const hasExtras = Object.keys(extras).length > 0;
  const retention: StoredRetention | undefined = clearing && !hasExtras ? undefined : { ok: true, value: { keepDays: value.keepDays, keepCount: value.keepCount, ...extras } };
  // 没有 notice：留存策略的改动不需要通知任何人，清扫器每次开始时现读设置。
  return { next: { ...current, retention } };
}

// ───────────────────────── 提交的取值检查与比较 ─────────────────────────

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]));
}

function sameEfforts(a: Efforts | undefined, b: Efforts | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameList(a[key], b[key]));
}

function cloneEfforts(efforts: Efforts): Efforts {
  return Object.fromEntries(Object.entries(efforts).map(([id, list]) => [id, [...list]]));
}

/** 写入前的取值检查：只看形状（文本、枚举、长度），“这个模型此刻能不能用”是读的时候的事（见 shared/profiles.ts 的 checkProfile）。 */
function checkedSpec(profile: ProfileSpec): ProfileSpec {
  if (!isBounded(profile.harness, PROFILE_FIELD_MAX.harness)) {
    throw new EnsembleError("invalid_request", `A role needs a harness id: non-empty, without leading or trailing whitespace, at most ${PROFILE_FIELD_MAX.harness} characters.`);
  }
  if (profile.model !== undefined && !isBounded(profile.model, PROFILE_FIELD_MAX.model)) {
    throw new EnsembleError("invalid_request", `A role's model id must be non-empty, without leading or trailing whitespace, at most ${PROFILE_FIELD_MAX.model} characters.`);
  }
  if (profile.effort !== undefined && !isBounded(profile.effort, PROFILE_FIELD_MAX.effort)) {
    throw new EnsembleError("invalid_request", `A role's effort must be non-empty, without leading or trailing whitespace, at most ${PROFILE_FIELD_MAX.effort} characters.`);
  }
  if (profile.access !== undefined && !isAccessLevel(profile.access)) {
    throw new EnsembleError("invalid_request", 'A role\'s access must be "full" or "read_only".');
  }
  return profile;
}

function sameProfile(a: ProfileSpec, b: ProfileSpec): boolean {
  return a.harness === b.harness && a.model === b.model && a.effort === b.effort && a.access === b.access;
}

/**
 * 按名字找表里的键：先原样、再按规范化后的写法。原样优先是为了手改文件造成的不规范名字（如大写、带空白）也能被删除或改名，
 * 否则这种条目会成为谁也改不动的“僵尸”。
 */
function findKey(profiles: Profiles, name: string): string | undefined {
  if (profiles.has(name)) return name;
  const key = normalizeProfileName(name);
  return profiles.has(key) ? key : undefined;
}

function entryView(name: string, stored: StoredProfile): ProfileEntry {
  if (!stored.ok) return { name, invalid: "entry" };
  const { harness, model, effort, access } = stored.value;
  return {
    name,
    harness,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(access === undefined ? {} : { access }),
    ...(profileNameFault(name) === undefined ? {} : { invalid: "name" as const }),
  };
}

/** 日志里引用文件里的坏值：截断，免得一个巨大的值灌满日志。 */
function quoted(value: unknown): string {
  return (JSON.stringify(value) ?? String(value)).slice(0, 80);
}
