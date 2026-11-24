import type { EnsembleEvent } from "./events";
import type { ContextRefReceipt } from "./handoff";
import type { ProfileEcho, ProfilesReport, ProfileSpec, ProfilesView } from "./profiles";
import type {
  AccessLevel,
  AttentionItem,
  ContextItem,
  DeliveryStage,
  HarnessId,
  HarnessInfo,
  MessageId,
  MessageKind,
  Notice,
  Origin,
  RunId,
  SessionId,
  SessionSummary,
} from "./types";
import type { QuestionId, QuestionOutcomeRecord, QuestionStatus } from "./questions";

/** 服务、MCP 桥与网页之间的 HTTP / SSE 协议。 */

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * 全局并发名额此刻的账目，数字都取自服务端真正在用的 RunSlots，不是网页自己推算的。
 * `max` 为 0 表示不设上限（此时 `waiting` 恒为 0）；调低上限之后 `occupied` 可以暂时大于 `max`：
 * 已经在跑的会话不会被中断，名额随它们自己结束慢慢收回。
 */
export interface Capacity {
  occupied: number;
  max: number;
  waiting: number;
}

/** 并发上限在设置里的写法（settings.json 与 PUT 请求体共用）：正整数，或 "unlimited"（不设上限）。 */
export type ConcurrencyValue = number | "unlimited";

/**
 * “并发上限”这项设置此刻的样子。此刻生效的上限本身是 `Capacity.max`，不在这里重复一份，所以网页把两者一起更新才不会错位
 * （SSE 的 `capacity` 消息和 `PUT /api/settings/concurrency` 的回执都是成对给的）。
 */
export interface ConcurrencySetting {
  /**
   * 生效的上限从哪来：`settings` 用户在设置里指定的；`env` 环境变量 ENSEMBLE_MAX_CONCURRENT_RUNS；`default` 内置默认；
   * `startup` 启动服务的进程（测试、嵌入）写死的，设置里改不动。
   */
  source: "settings" | "env" | "default" | "startup";
  /** 用户存在设置里的值；没指定就没有这个字段。`source` 为 `startup` 时它可能存在，但不生效。 */
  stored?: ConcurrencyValue;
  /** 没有用户指定的值时会落到的上限（“恢复默认”之后的结果）：环境变量可用时是它，否则是内置默认；`max` 为 0＝不设上限。 */
  inherited: { max: number; source: "env" | "default" };
  /**
   * 设置文件里的问题：`invalid_value` 文件里写了这一项但值无效（已忽略，文件原样保留，用户在页面里重新设置后才被覆盖）；
   * `unreadable_file` 整个设置文件读不出来（这里改不了，上限落回 `inherited`）。
   */
  issue?: "invalid_value" | "unreadable_file";
}

/** `max`：正整数或 "unlimited" 是指定，`null` 是清掉指定（回到环境变量 / 内置默认）。 */
export interface SetConcurrencyRequest {
  max: ConcurrencyValue | null;
}

export interface SetConcurrencyResponse {
  capacity: Capacity;
  concurrency: ConcurrencySetting;
}

export interface HealthBody {
  ok: true;
  service: "ensemble";
  version: string;
  protocol: number;
  pid: number;
  startedAt: string;
  /** max 为 0 表示不设并发上限。 */
  capacity: Capacity;
  /** 全部已知会话数：含冷（只在磁盘上、没有载入内存）与已归档的。 */
  sessions: number;
  /** 其中此刻常驻内存的会话数（诊断用）；老服务没有这个字段。 */
  sessionsHot?: number;
  /** 其中已归档的会话数（诊断用）；老服务没有这个字段。 */
  sessionsArchived?: number;
  /** 服务懂得的可协商功能（见 SERVICE_FEATURES）；老服务没有这个字段。 */
  features?: string[];
}

export interface StateSnapshot {
  rev: number;
  serverTime: string;
  version: string;
  protocol: number;
  sessions: SessionSummary[];
  harnesses: HarnessInfo[];
  capacity: Capacity;
  /** 并发上限这项设置的来源与用户存的值（上限本身是 capacity.max）。老服务没有这个字段。 */
  concurrency?: ConcurrencySetting;
  /** 开发/演示模式：存在模拟执行端。 */
  dev: boolean;
  /** 用户定义的委派角色（见 shared/profiles.ts）。老服务没有这个字段。 */
  profiles?: ProfilesView;
  /** 已归档的会话数（`sessions` 里不含已归档的，它们按需通过 `GET /api/sessions?archived=only` 取）。老服务没有这个字段。 */
  archivedCount?: number;
  /** 留存策略此刻的样子（见 RetentionSettings）。老服务没有这个字段。 */
  retention?: RetentionSettings;
}

export type StreamMessage =
  | { type: "hello"; rev: number; bootId: string; serverTime: string; version: string }
  | { type: "snapshot"; snapshot: StateSnapshot }
  | { type: "summary"; summary: SessionSummary }
  | { type: "events"; sessionId: SessionId; events: EnsembleEvent[] }
  | { type: "removed"; sessionId: SessionId }
  | { type: "harness"; info: HarnessInfo }
  /**
   * 名额的占用 / 等待变了，或并发上限的设置变了（可能来自另一个标签页）。成对给，网页一次更新两处；
   * 服务端按同一个合并窗口发，内容没变就不发，所以不会随每个会话事件刷屏。
   */
  | { type: "capacity"; capacity: Capacity; concurrency: ConcurrencySetting }
  /** 角色表整份（最多二十条，很小）：多个标签页、多个入口改动后保持一致。 */
  | { type: "profiles"; profiles: ProfilesView }
  | { type: "ping"; at: string };

export interface DelegateRequest {
  /**
   * 与 `profile` 至少给一个。两个都给时，显式的 `harness` 覆盖角色里的执行端
   * （并且不继承角色的模型与推理强度，它们属于角色原来的执行端）。
   */
  harness?: HarnessId;
  /** 用户在设置里定义的角色名；其中固定的取值作为默认，显式给的参数按字段覆盖。规则见 shared/profiles.ts 的 resolveDelegation。 */
  profile?: string;
  task: string;
  title?: string;
  cwd: string;
  model?: string;
  effort?: string;
  access?: AccessLevel;
  context?: ContextItem[];
  /** 仅 MCP 桥提供；不带它的请求（没有经过 MCP 桥，直接调用 HTTP 入口）由服务端标记为控制台来源。 */
  origin?: Origin;
  parentSessionId?: SessionId;
  /**
   * 汇聚：这件事依赖几个已有会话的结果（有序，去重，最多 LIMITS.maxParents 个，不能为空数组）。
   * 与 `parentSessionId` 同时给时，后者必须等于这里的第一项；会话的 `parentSessionId` 始终是第一个上级。
   * 老服务不认识这个字段（会被当作未知键忽略，只记录 `parentSessionId`）：先看 /api/health 的 features 里有没有 "multi-parent"。
   */
  parentSessionIds?: SessionId[];
  /**
   * 短时间内提交相同的委派会被当作重复，只返回已有的会话（见 `DelegateResponse.duplicate`）。
   * 确实要第二个一模一样的会话时设为 true；默认关闭。
   */
  allowDuplicate?: boolean;
}

export interface DelegateResponse {
  sessionId: SessionId;
  runId: RunId;
  messageId: MessageId;
  summary: SessionSummary;
  /**
   * 只在命中重复时出现：同一来源不久前提交过本质上相同的委派，这次没有新建会话，
   * 上面的 id 与摘要都是已有那个会话的；`ageMs` 是它已经创建了多久。
   */
  duplicate?: { ageMs: number };
  /**
   * 这次委派带了 `profile` 时出现：角色名与每个字段的取值来由（角色 / 显式 / 默认），以及角色里写了但这次没有用上的取值。
   * 只是这次调用的回执：不写进会话记录，网页上的会话也不显示它。角色在判重之前解析，所以命中重复时同样会带上（说明的是这次请求怎么解析的）。
   */
  profile?: ProfileEcho;
  /**
   * 只在这次委派的 `context` 里带了 `session` 条目、并且确实新建了会话时出现：每个被引用的会话一条，说明派发那一刻取到了什么
   * （取自第几次运行、字符数、文件数、有没有失败记录、被截断了没有……）。同样的事实也冻结在新会话的 `meta.task.context[i].sample` 里，页面读那一份。
   * 命中重复时没有新建任何东西，不带它（已有会话的记录里有）。老服务没有这个字段：先看 /api/health 的 features 里有没有 "context-session-ref"。
   */
  contextRefs?: ContextRefReceipt[];
}

/** `GET /api/harnesses`。`profiles` 带着每个角色此刻的评估结果（只有服务有角色功能时出现），MCP 的 `harnesses` 工具据此呈现。 */
export interface HarnessesResponse {
  harnesses: HarnessInfo[];
  profiles?: ProfilesReport;
}

/**
 * `PUT /api/profiles/:name`：新增或整条改写一个角色（给出的取值就是全部，没给的字段＝不固定）。
 * `create` 为 true 时名字已存在就拒绝（网页的“新增”用它，避免两个标签页用同一个名字时后到的悄悄覆盖先到的）。
 */
export type PutProfileRequest = ProfileSpec & { create?: boolean };

/** `POST /api/profiles/:name/rename`：改名，原位置不变。 */
export interface RenameProfileRequest {
  to: string;
}

/** 角色写入类接口的返回：生效后的整张角色表。 */
export interface ProfilesResponse {
  profiles: ProfilesView;
}

/**
 * 设置某个执行端开放给主 Agent 的模型与推理档位。`null` 表示去掉模型限制（目录里的全部模型都可选）。
 * `efforts` 按模型 id 记录允许的档位（每项非空）；没有某个模型的记录表示它的档位不设限。
 * 省略 `efforts` 表示不改动已有的档位记录，传 `{}` 清空。
 * `userDefaultModel` 是用户指定的默认模型：字符串＝指定（有限制时必须在 `allowed` 里，不设限时必须是执行端目录里的模型），
 * `null`＝恢复执行端自己的默认，省略＝不改动。新名单把已指定的默认模型排除在外时，服务端会一并清掉它。
 */
export interface SetAllowedModelsRequest {
  allowed: string[] | null;
  efforts?: Record<string, string[]>;
  userDefaultModel?: string | null;
}

export interface SetAllowedModelsResponse {
  /** 设置生效后该执行端的最新信息。 */
  harness: HarnessInfo;
}

export interface SendRequest {
  text: string;
  mode?: "auto" | "steer" | "follow_up";
  /** MCP 桥代表主 Agent 发送时提供，用来区分用户在网页上的干预。 */
  originKey?: string;
}

export interface SendResponse {
  messageId: MessageId;
  kind: MessageKind;
  runId?: RunId;
  stage: DeliveryStage;
  summary: SessionSummary;
}

export interface CancelResponse {
  interrupted: boolean;
  cancelledQueued: number;
  summary: SessionSummary;
}

// ───────────────────────── 提问（执行端的业务提问，不是授权；见 shared/questions.ts） ─────────────────────────

/**
 * `POST /api/sessions/:id/questions/:questionId/answer` 的请求体。`answer` 与 `answers` 二选一：
 * 只有一个问题时 `answer` 最简单；多个问题或多选用 `answers`（每个问题一项，按顺序；多选的一项是字符串数组）。
 * 答案是可选项的标签，或在允许时自己写的文字。
 */
export interface AnswerQuestionRequest {
  answer?: string | string[];
  answers?: (string | string[])[];
  /** MCP 桥代表主 Agent 回答时提供（同 SendRequest），用来与用户在网页上的回答区分。 */
  originKey?: string;
}

/** `POST /api/sessions/:id/questions/:questionId/decline`：不回答，让执行端自行判断。`note` 是附给执行端的一句话（可选）。 */
export interface DeclineQuestionRequest {
  note?: string;
  originKey?: string;
}

/** 回答或不回答之后的回执：只在这次操作确实生效时返回；提问已有结局或执行端已不再等待，则是错误（409）。 */
export interface QuestionResolvedResponse {
  questionId: QuestionId;
  status: Exclude<QuestionStatus, "open">;
  /** 与事件里记下的结局一致：谁、何时、回答了什么、回复是否已交给执行端。 */
  outcome: QuestionOutcomeRecord;
  summary: SessionSummary;
}

/**
 * 事后调整上级会话：`parentSessionId: null` 表示改回没有上级（直接挂在来源下）；
 * `parentSessionIds` 一次指定多个上级，整组替换会话原先的上级（汇聚，规则同 DelegateRequest.parentSessionIds）。
 * 两个字段至少给一个；都给时 `parentSessionId` 必须等于 `parentSessionIds` 的第一项。
 */
export interface RelinkRequest {
  parentSessionId?: SessionId | null;
  parentSessionIds?: SessionId[];
}

export interface RelinkResponse {
  /** 已经是这个上级时为 false，什么也没有改。 */
  changed: boolean;
  /** 因此层数跟着变的后代（不含被改的会话）。 */
  depthUpdated: SessionId[];
  /** 被改会话调整后的摘要。 */
  summary: SessionSummary;
}

// ───────────────────────── 归档与留存 ─────────────────────────

/** `POST /api/sessions/archive` 的请求体，也是取消归档的请求体（`UnarchiveRequest`）的基础。归档与取消归档都按子树 / 上级链处理，规则见 shared/archive.ts。 */
export interface ArchiveRequest {
  ids: SessionId[];
}

/**
 * `POST /api/sessions/unarchive` 的请求体：比归档多一个可选的 `exact`，撤销刚才那次归档时用（规则见 shared/archive.ts 的 UnarchiveOptions）。
 * 老服务不认识 `exact`、会把它当作没带，撤销时仍把整棵子树带回来；这不会报错，网页提示里如实写“一并恢复了几个”，所以没有为它新增 SERVICE_FEATURES。
 */
export interface UnarchiveRequest extends ArchiveRequest {
  /** 只恢复点名的会话（撤销用）；缺省或 false 是整棵子树加上级链。 */
  exact?: boolean;
}

/**
 * 某个 id 没有被处理的原因：
 * - not_found：没有这个会话；
 * - active：它（或它的下级）还没有结束（starting / queued / running / ready，或有待确认的消息），整棵不归档；
 * - already：已经是归档状态（归档时）；
 * - not_archived：本来就没有归档（取消归档时）。
 */
export type ArchiveSkipReason = "not_found" | "active" | "already" | "not_archived";

export interface ArchiveResponse {
  /** 实际发生变化的会话（含随上级一起归档的下级、取消归档时一并取消的上级链；取消归档带 `exact` 时只有点名的那些）。 */
  changed: SessionId[];
  skipped: { id: SessionId; reason: ArchiveSkipReason }[];
  /**
   * 归档时才有、且只在有会话因此留下时才有：本来会随被归档的上级一起走、却因为还跟随着没有归档的别的上级（汇聚）而留在原处的会话，
   * `follows` 是让它留下的那些上级。老服务没有这一项（也没有汇聚），老网页会忽略它。
   */
  kept?: { id: SessionId; follows: SessionId[] }[];
}

/**
 * 留存策略：只归档、永不删除。`null` = 不限；两项都是 `null` = 不自动归档（默认）。
 * keepDays：最后活动早于 N 天的已结束会话树归档；keepCount：未归档的会话树里只保留最近活动的 M 棵。
 */
export interface RetentionSettings {
  keepDays: number | null;
  keepCount: number | null;
}

/** `GET` / `PUT /api/retention` 的回执。lastSweep 是这个服务进程里最近一次清扫的结果（还没清扫过就没有）。 */
export interface RetentionResponse {
  retention: RetentionSettings;
  lastSweep?: { at: string; archived: number };
}

export type WaitMode = "any_settled" | "all_settled";

export interface WaitRequest {
  sessionIds: SessionId[];
  mode?: WaitMode;
  timeoutMs?: number;
  /** 提供后，若该发起端有未送达的干预通知，会提前返回。 */
  originKey?: string;
  /**
   * 等待期间有会话出现新的“值得留意”事项（静默、工具无响应、共写同一文件……）时是否提前返回，默认 true。
   * 只有等待开始之后新出现的才算；开始时就已存在的不会让同一个调用立刻返回，它们仍随会话摘要一起带回。
   * 提问（会话停下来等一个回答，不是授权）不受它影响：那是一个请求，不是“可能出了问题”的迹象，`false` 时它照样唤醒 wait。
   * 它的“新”也不以等待开始时的状态为基线，而是看这个发起端（originKey）是否已经被告知过——见 server/wait.ts。
   */
  attention?: boolean;
}

export type WaitReason = "settled" | "notice" | "attention" | "timeout";

export interface RaisedAttention {
  sessionId: SessionId;
  item: AttentionItem;
}

export interface WaitResponse {
  reason: WaitReason;
  sessions: SessionSummary[];
  /** 等待期间新出现的“值得留意”事项（不论最终以什么原因返回）。 */
  raised?: RaisedAttention[];
}

export interface CollectNoticesResponse {
  notices: Notice[];
}

export interface SessionDetail {
  summary: SessionSummary;
  events: EnsembleEvent[];
}

export interface EventsResponse {
  sessionId: SessionId;
  events: EnsembleEvent[];
  /** 当前最新的事件序号。 */
  lastSeq: number;
}

// ───────────────────────── Git ─────────────────────────

/**
 * 某个目录所在 Git 仓库的此刻状态。只读地取自本机的 `git`，每一项都是 git 实际报告的，没有推测；
 * git 没有给出的项（例如没有上游分支、还没有任何提交）就不出现。
 */
export interface GitSnapshot {
  /** 仓库工作区的根目录（`git rev-parse --show-toplevel`）。 */
  root: string;
  /** 当前分支名；游离 HEAD 时没有。 */
  branch?: string;
  /** HEAD 不在任何分支上。 */
  detached: boolean;
  /** 还没有任何提交的新仓库没有 HEAD 提交。 */
  head?: { sha: string; subject: string; committedAt: string };
  /** 当前分支跟踪的上游，以及相对它领先、落后的提交数。 */
  upstream?: { name: string; ahead: number; behind: number };
  /** 工作区改动：files 是有改动的文件数（一个文件只算一次），其余按类型分项，可能互相重叠。 */
  changes: { files: number; staged: number; unstaged: number; untracked: number; conflicted: number };
  /** 上游所在的远程（没有上游时取 origin，再没有就取第一个）；地址已去掉账号密码，只用于展示。 */
  remote?: { name: string; url: string };
  /** 这份状态是什么时候从 git 读到的。 */
  checkedAt: string;
}

/** 读不到 Git 状态的原因：不是仓库、目录不存在、本机没有 git、超时、其他错误。 */
export type GitUnavailable = "not_repo" | "missing" | "git_missing" | "timeout" | "error";

export interface GitResponse {
  /** 请求里的目录，原样返回，网页据此对应到来源节点。 */
  path: string;
  git: GitSnapshot | null;
  /** git 为 null 时给出原因。 */
  reason?: GitUnavailable;
}
