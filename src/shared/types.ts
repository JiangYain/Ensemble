/**
 * Ensemble 领域模型。
 *
 * 区分的概念：
 * - 发起端（Origin）：用户或主 Agent 当前所在的工具；只作为来源信息出现。
 * - 执行端（Harness）：实际接受任务并运行的完整会话。
 * - 会话（Session）：可持续交流的上下文，一个会话可以经历多次运行。
 * - 运行（Run）：会话内一次具体执行，与会话分别跟踪。
 */

import type { SessionContextItem } from "./handoff";
import type { QuestionId, QuestionOutcomeRecord, QuestionPrompt, QuestionStatus } from "./questions";

export type SessionId = string;
export type RunId = string;
export type MessageId = string;
export type EventId = string;
export type NoticeId = string;

// ───────────────────────── 执行端 ─────────────────────────

export type HarnessId = "cursor" | "codex" | "pi" | "claude" | "opencode" | "dsh" | "fixture";

/** 执行端的接入方式：原生 SDK/控制接口，Driver 桥，或仅用于开发测试的模拟器。 */
export type ExecutorRuntime = "native" | "driver" | "fixture";

/**
 * 被委派的会话拥有什么权限：
 * - full：Full Access，默认值。没有沙箱，也没有需要人来批准的闸门，会话不会因为等待授权而停下；
 * - read_only：发起方明确要求的只读调研 / 审查。由执行端强制（或如实标明没有强制），写入会直接失败而不是弹出授权。
 */
export type AccessLevel = "read_only" | "full";

export type Support = "yes" | "partial" | "no" | "unknown";

/** 每种能力是“真实验证过”还是“仅凭文档/源码声明”，界面需要如实呈现。 */
export type Verification = "live" | "declared" | "none";

export interface CapabilityEntry<Mode extends string = string> {
  support: Support;
  mode?: Mode;
  verification?: Verification;
}

export type SteerMode = "immediate" | "turn_boundary" | "immediate_or_follow_up" | "none";
export type FollowUpMode = "queued_by_harness" | "after_run" | "none";

export interface Capabilities {
  /** 向运行中的会话补充纠正（运行中介入）。 */
  steer: CapabilityEntry<SteerMode>;
  /** 在当前运行结束后继续交代。 */
  followUp: CapabilityEntry<FollowUpMode>;
  /** 中断当前运行并保留会话。 */
  cancel: CapabilityEntry;
  /** 服务重启后恢复原生会话。 */
  resume: CapabilityEntry;
  /** 事件流里能看到推理文本（摘要）。 */
  reasoning: CapabilityEntry;
  /** 事件流里有执行端自己的计划/待办。 */
  plan: CapabilityEntry;
  usage: CapabilityEntry;
  fileEvents: CapabilityEntry;
  /**
   * 执行端的业务提问能否转给发起方、再把回答送回去（见 questions.ts）。可选：旧会话与没有调查过的执行端没有这一项，
   * 读到的一方按“不知道”处理，不当作“不支持”。
   */
  question?: CapabilityEntry;
}

export interface AccessEnforcement {
  /** enforced：执行端自身强制；advisory：只靠提示词约束；none：没有约束。 */
  level: "enforced" | "advisory" | "none";
  mechanism: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider?: string;
  /** 可选推理档位，如 low / medium / high。 */
  efforts?: string[];
  defaultEffort?: string;
  isDefault?: boolean;
  contextWindow?: number;
}

export type HarnessStatus = "ready" | "needs_setup" | "unavailable" | "checking";

export interface SetupHint {
  /** 机器可读的原因代码，网页据此本地化。 */
  code: string;
  /** 英文原文，供 MCP 文本与日志使用。 */
  message: string;
  /** 用户可以执行的命令（只展示，不自动执行）。 */
  command?: string;
}

export type ModelSettingsIssue = "invalid_entry" | "unreadable_file";

export interface ModelSettingsView {
  /** 缺省表示不限制，空列表表示一个都不开放。读取失败时由 modelSettingsIssue 表示。 */
  allowedModels?: string[];
  /**
   * 按模型 id 记录用户允许主 Agent 选用的推理档位。没有某个模型的条目表示它的档位不设限；
   * 条目一定非空（开放的模型至少留一档）。可以保留已被关闭的模型的条目，重新开放时沿用。
   */
  allowedEfforts?: Record<string, string[]>;
  /**
   * 用户指定的默认模型：不指定模型的委派用它。缺省表示沿用执行端自己的默认（HarnessInfo.defaultModel，两者重名会被
   * 展开覆盖，所以这里叫 userDefaultModel）。它可能已经失效（执行端不再提供、或没被开放）：此时规则退回缺省，
   * 由 resolveModelChoices 的 staleDefault 说明，而不是在这里悄悄清掉。
   */
  userDefaultModel?: string;
  modelSettingsIssue?: ModelSettingsIssue;
}

export interface HarnessInfo extends ModelSettingsView {
  id: HarnessId;
  displayName: string;
  runtime: ExecutorRuntime;
  status: HarnessStatus;
  setup?: SetupHint;
  version?: string;
  account?: string;
  /** 执行端自己报告的完整模型目录；用户的取舍见 allowedModels，不会改动这份目录。 */
  models: ModelInfo[];
  defaultModel?: string;
  capabilities: Capabilities;
  /** 各访问级别在该执行端是否真实可执行，以及如何强制。 */
  access: Record<AccessLevel, AccessEnforcement | null>;
  checkedAt: string;
}

// ───────────────────────── 发起端 ─────────────────────────

export type OriginHost =
  | "codex"
  | "cursor"
  | "claude"
  | "pi"
  | "vscode"
  | "console"
  | "unknown";

/**
 * 会话标识的来源。mcp-meta、env 是宿主真实给出的（请求的 `_meta`、进程环境变量），console 是网页控制台；
 * declared 是 Agent 自己通过工具参数 `conversationId` 报的——宿主没有给出任何标识时（例如 Cursor IDE 的对话）的补充线索，
 * Ensemble 无从核对，所以任何地方都不能把它当作宿主证据。
 */
export type SessionRefSource = "mcp-meta" | "env" | "declared" | "console";

export interface SessionRef {
  /** 会话标识；不是编造的：要么宿主真实提供，要么是 Agent 自报（source 为 declared）。 */
  id: string;
  kind: "session" | "thread" | "conversation";
  /** 线索来源，便于排查与如实展示：mcp-meta / env / declared（Agent 自报）/ console。 */
  source: SessionRefSource;
}

/**
 * 来源的工作目录是怎么知道的：
 * - host-record：宿主自己记在这段对话上的工作区（目前只有 Cursor：桥按对话标识只读查它本机的对话记录；标识若是 Agent 自报的，来源卡上有注明）；
 * - mcp-roots：宿主通过 MCP roots 报告的；
 * - delegate-cwd：这次委派显式传入的 `cwd`。
 * 老服务只认后两个：桥靠 service.json / 健康检查里的 features（host-record-workspace）判断，老服务就只发目录、不发 host-record 这个来历。
 */
export type WorkspaceSource = "host-record" | "mcp-roots" | "delegate-cwd";

export interface Origin {
  /** 稳定键：用于把干预通知路由回发起端。 */
  key: string;
  kind: "agent" | "user";
  host: OriginHost;
  hostLabel: string;
  sessionRef?: SessionRef;
  clientInfo?: { name: string; version?: string };
  /**
   * 来源的工作目录。只取有出处的（见 WorkspaceSource）：宿主对这段对话的记录、宿主通过 MCP roots 报告的，或这次委派显式传入的 `cwd`；
   * 都没有就不写——不再用桥进程的启动目录顶替（那只是插件被启动的地方，不是这段对话在做的项目）。
   */
  workspace?: string;
  /** workspace 的来源；旧记录没有这个字段。 */
  workspaceSource?: WorkspaceSource;
  /**
   * 宿主给这段对话起的标题，委派时从宿主自己写在本机的记录里读到。
   * 读不到（宿主没有、还没起名、读取失败）就不写，绝不由 Ensemble 生成或编造。
   */
  hostTitle?: string;
  /** 采用了哪些识别线索（用于排查与如实展示）。 */
  evidence: string[];
}

export interface OriginSummary {
  key: string;
  kind: "agent" | "user";
  host: OriginHost;
  hostLabel: string;
  sessionRef?: SessionRef;
  workspace?: string;
  workspaceSource?: WorkspaceSource;
  hostTitle?: string;
}

export interface Actor {
  kind: "user" | "agent" | "system";
  label: string;
  originKey?: string;
}

// ───────────────────────── 委派 ─────────────────────────

/**
 * 随任务带上的上下文条目。前四种是发起端自己写出来的材料；`session` 是“按引用交接”——
 * 引用另一个会话的真实产出，由服务端在派发那一刻从那个会话的事件日志里取，见 handoff.ts。
 * 每处按种类分支的代码都要有 session 分支，并用穷尽性检查（`item satisfies never`）兜住以后再加的种类。
 */
export type ContextItem =
  | { kind: "text"; title?: string; text: string }
  | { kind: "file"; path: string; note?: string }
  | { kind: "snippet"; text: string; path?: string; language?: string; startLine?: number; endLine?: number }
  | { kind: "url"; url: string; title?: string }
  | SessionContextItem;

export interface TaskSpec {
  /** 发起端给出的委派原文，原样保存。 */
  text: string;
  /** 发起端传入的上下文，原样保存。 */
  context: ContextItem[];
  /** Ensemble 实际发给执行端的完整提示（委派原文 + 上下文渲染），用于透明展示。 */
  prompt: string;
}

export interface ModelRef {
  /** 给执行端明确指定的模型；也包括 Ensemble 按名单选定的默认模型。 */
  requested?: string;
  resolved?: string;
  label?: string;
  provider?: string;
}

export interface NativeRef {
  kind: "cursor-agent" | "codex-thread" | "pi-session" | "claude-session" | "opencode-session" | "dsh-session";
  id: string;
  path?: string;
}

export interface SessionMeta {
  id: SessionId;
  title: string;
  harness: HarnessId;
  runtime: ExecutorRuntime;
  model?: ModelRef;
  effort?: string;
  access: AccessLevel;
  accessEnforcement?: AccessEnforcement;
  cwd: string;
  origin: Origin;
  /** 上级会话；有多个上级（汇聚）时是其中的第一个（“主上级”），老读者读到的仍是一棵树。 */
  parentSessionId?: SessionId;
  /**
   * 有多个上级（汇聚：这件事依赖几个会话的结果）时的完整、有序的上级集合，`parentSessionId` 始终是它的第一项。
   * 只在多于一个上级时才有这个字段：单上级的会话没有它，老日志、老快照与老读者看到的就是原来的样子。
   * 读取请用 `parentIdsOf`（shared/lineage），别直接读这个字段。
   */
  parentSessionIds?: SessionId[];
  /** 嵌套深度：没有上级是 0，否则是各上级深度的最大值加 1（最长的那条链）。 */
  depth: number;
  task: TaskSpec;
  createdAt: string;
  nativeRef?: NativeRef;
  capabilities: Capabilities;
}

// ───────────────────────── 会话 / 运行 ─────────────────────────

/** 会话本身的生命周期。 */
export type SessionStatus =
  | "starting" // 正在连接执行端
  | "queued" // 等待并发名额
  | "running"
  | "idle" // 当前没有运行，可继续交代
  | "stopped" // 被主动关闭
  | "failed" // 执行端无法启动或意外退出
  | "lost"; // 服务重启后未能重新连接

/** 展示用的阶段：Ready / Queued / Running / Done 等状态。 */
export type SessionPhase =
  | "ready"
  | "starting"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "stopped"
  | "lost";

export type RunStatus = "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";

export interface ErrorInfo {
  code: string;
  message: string;
  /** 执行端原始错误文本（截断）。 */
  detail?: string;
  retryable?: boolean;
}

/**
 * 各执行端的 token 统计口径不同，适配器负责归一成下面这一种，界面据此把用量拆成互不重叠的几段：
 * `cachedTokens` 是 `inputTokens` 的一部分，`reasoningTokens` 是 `outputTokens` 的一部分，`totalTokens = 输入 + 输出`。
 */
export interface Usage {
  /** 全部输入，包含命中缓存的部分。 */
  inputTokens?: number;
  /** 全部输出，包含推理。 */
  outputTokens?: number;
  /** 输入中命中缓存的部分（⊂ inputTokens）。 */
  cachedTokens?: number;
  /** 输出中用于推理的部分（⊂ outputTokens）。 */
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** 当前上下文占用（若执行端提供）。 */
  contextTokens?: number;
  contextWindow?: number;
}

export interface Run {
  id: RunId;
  sessionId: SessionId;
  index: number;
  trigger: "task" | "follow_up";
  messageId: MessageId;
  status: RunStatus;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  stopReason?: string;
  error?: ErrorInfo;
  usage?: Usage;
  /** 运行中收到并投递的纠偏条数。 */
  steerCount: number;
  nativeTurnId?: string;
}

// ───────────────────────── 消息与投递 ─────────────────────────

export type MessageKind = "task" | "steer" | "follow_up";

/**
 * 投递阶段（只会前进，不会倒退；failed / cancelled 为终态）：
 * - recorded：Ensemble 已收到并持久化。
 * - queued：已被挂起，等待当前运行到达边界（由 Ensemble 或执行端排队）。
 * - handed_off：已交给执行端的接口并被其接受。
 * - applied：有执行端侧证据表明它已进入会话上下文。
 */
export type DeliveryStage = "recorded" | "queued" | "handed_off" | "applied" | "failed" | "cancelled";

export type QueueReason =
  | "run_in_progress" // 当前有运行，执行端不支持运行中注入
  | "turn_boundary" // 执行端会在当前回合边界处理
  | "session_starting" // 会话尚在连接
  | "capacity"; // 全局并发名额已满

export interface DeliveryRecord {
  stage: DeliveryStage;
  at: string;
  /** 排队方：Ensemble 自己持有，还是执行端持有。 */
  queuedBy?: "ensemble" | "harness";
  reason?: QueueReason;
  /** 判定该阶段的证据（执行端事件名等），不得编造。 */
  evidence?: string;
  error?: ErrorInfo;
}

export interface DeliveryState extends DeliveryRecord {
  history: DeliveryRecord[];
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  kind: MessageKind;
  author: Actor;
  text: string;
  createdAt: string;
  runId?: RunId;
  delivery: DeliveryState;
  /** 是否需要、以及是否已把这条干预同步给发起端。 */
  sync: { toOrigin: "not_needed" | "pending" | "delivered"; at?: string };
}

export type NoticeKind = "intervention" | "cancel" | "stop";

/** 发给主 Agent 的干预通知，在它下一次调用 Ensemble 工具时随结果带回。 */
export interface Notice {
  id: NoticeId;
  originKey: string;
  sessionId: SessionId;
  kind: NoticeKind;
  createdAt: string;
  messageId?: MessageId;
  /** 给主模型看的英文摘要。 */
  summary: string;
  /** 用户原文（若与消息相关）。 */
  text?: string;
  deliveredAt?: string;
}

// ───────────────────────── 工具与计划 ─────────────────────────

export type ToolCategory =
  | "read"
  | "write"
  | "edit"
  | "search"
  | "shell"
  | "web"
  | "mcp"
  | "task"
  | "plan"
  | "other";

export interface Preview {
  text: string;
  truncated: boolean;
  /** 截断前的字符数。 */
  chars?: number;
  format?: "text" | "json" | "diff";
}

export interface FileChange {
  path: string;
  change: "created" | "modified" | "deleted" | "renamed";
  addedLines?: number;
  removedLines?: number;
  diff?: Preview;
}

export interface PlanEntry {
  id?: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

// ───────────────────────── 时间线（由事件投影得到） ─────────────────────────

interface ItemBase {
  id: string;
  runId?: RunId;
  at: string;
  updatedAt: string;
}

export interface MessageItem extends ItemBase {
  type: "message";
  messageId: MessageId;
}

export interface AssistantItem extends ItemBase {
  type: "assistant";
  text: string;
  streaming: boolean;
  phase?: "commentary" | "final";
}

export interface ReasoningItem extends ItemBase {
  type: "reasoning";
  text: string;
  streaming: boolean;
  durationMs?: number;
}

/** unfinished：运行已结束，但执行端始终没有上报这个工具的结束事件。 */
export type ToolStatus = "running" | "completed" | "failed" | "cancelled" | "unfinished";

export interface ToolItem extends ItemBase {
  type: "tool";
  callId: string;
  name: string;
  category: ToolCategory;
  /** 语言无关的简短摘要：路径、命令或查询词。 */
  title: string;
  status: ToolStatus;
  input?: Preview;
  output?: Preview;
  error?: string;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  files?: FileChange[];
  mcp?: { server?: string; tool?: string };
}

export interface PlanItem extends ItemBase {
  type: "plan";
  entries: PlanEntry[];
  explanation?: string;
}

export interface DiagnosticItem extends ItemBase {
  type: "diagnostic";
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export interface RunMarkerItem extends ItemBase {
  type: "run";
  runIndex: number;
  phase: "queued" | "started" | "completed" | "failed" | "cancelled";
  durationMs?: number;
  stopReason?: string;
}

/**
 * 执行端的一次提问（不是授权）。放在它被问出来的位置，回答、不回答或过期时原位更新，不另起一条。
 * 状态由事件投影得出：会话已不再开着、或所属运行已经结束，而提问没有结局的，一律是 expired——
 * 日志缺了结局事件（崩溃、旧版本）也不会留下永远“待回答”的幽灵提问。
 */
export interface QuestionItem extends ItemBase {
  type: "question";
  questionId: QuestionId;
  prompts: QuestionPrompt[];
  status: QuestionStatus;
  /** 有结局（status 不是 open）时：谁、何时、怎样。 */
  outcome?: QuestionOutcomeRecord;
}

export type TimelineItem =
  | MessageItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | PlanItem
  | DiagnosticItem
  | RunMarkerItem
  | QuestionItem;

// ───────────────────────── 派生展示信息 ─────────────────────────

export type ActivityKind =
  | "starting"
  | "queued"
  | "ready"
  | "working" // 运行中，但执行端当前没有上报更具体的动作
  | "thinking"
  | "writing"
  | "tool"
  | "idle"
  | "done"
  | "failed"
  | "cancelled"
  | "stopped"
  | "lost";

export interface Activity {
  kind: ActivityKind;
  /** 仅 kind = tool：正在执行的工具。 */
  tool?: { name: string; category: ToolCategory; title: string };
  since: string;
  runId?: RunId;
}

/**
 * 当前（或最近一次）运行的步骤计数，只反映真实信号，不折算成百分比：
 * - 执行端给出了计划/待办：done = 已完成的条目数，total = 条目总数；
 * - 没有计划：done = 已结束的工具步骤数，没有 total。
 * 画布与网页不再把它画成进度条（“最近 N 步”的窗口和“完成度”长得一样，会被误读）；
 * 这份计数仍通过 MCP 回传给主 Agent。
 */
export interface Progress {
  done: number;
  total?: number;
  /** 当前（或最近一次）运行的工具步骤总数。 */
  steps: number;
}

/**
 * 值得发起端或用户看一眼的事实。由服务端依据真实事件与时间戳得出，只陈述“发生了什么”，
 * 不判断原因或对错（静默可能是在等一个长时间的构建，也可能是卡住了）。
 * 只覆盖仍在进行的会话；会话已完成或失败由 `phase` 表达，不在这里重复。
 *
 * - quiet：会话在运行，没有进行中的工具调用，却很久没有任何事件。
 * - long_tool：有工具调用处于进行中，且之后很久没有任何事件。
 * - long_run：这次运行本身已经持续很久。
 * - shared_file：另一个仍在运行的会话最近也写了同一个文件。
 * - undelivered：一条消息很久都没有被执行端确认生效。
 * - question：会话停下来问了一个问题，正在等回答（业务提问，不是授权）。每个待回答的提问一项，回答、撤回或过期后立刻消失。
 *   它是“请求”而不是“可能出了问题的迹象”，所以排在最前，也不受 `wait` 的 `attention=false` 影响。
 */
export type AttentionKind = "quiet" | "long_tool" | "long_run" | "shared_file" | "undelivered" | "question";

interface AttentionBase {
  /** 这一事实成立的起点；条件持续期间保持不变（shared_file 取双方最近一次写入中较晚的那次）。 */
  since: string;
  runId?: RunId;
}

export type AttentionItem =
  | (AttentionBase & { kind: "quiet"; seq: number })
  | (AttentionBase & {
      kind: "long_tool";
      /** 静默起点之前最后一条事件的序号。 */
      seq: number;
      tool: { callId: string; name: string; category: ToolCategory; title: string; startedAt: string };
    })
  | (AttentionBase & { kind: "long_run" })
  | (AttentionBase & { kind: "shared_file"; path: string; withSessionIds: SessionId[] })
  | (AttentionBase & { kind: "undelivered"; messageId: MessageId; messageKind: MessageKind; stage: DeliveryStage })
  | (AttentionBase & {
      kind: "question";
      questionId: QuestionId;
      /** 这次提问里的问题，原样带上，让界面与 MCP 不必再翻日志就能显示、回答（文字与可选项已按上限整理过）。 */
      prompts: QuestionPrompt[];
    });

export interface SessionSummary {
  id: SessionId;
  title: string;
  harness: HarnessId;
  runtime: ExecutorRuntime;
  model?: ModelRef;
  effort?: string;
  access: AccessLevel;
  accessEnforcement?: AccessEnforcement;
  cwd: string;
  origin: OriginSummary;
  parentSessionId?: SessionId;
  /** 多于一个上级时的完整有序集合（`parentSessionId` 是第一项）；单上级时没有这个字段，见 SessionMeta.parentSessionIds。 */
  parentSessionIds?: SessionId[];
  childIds: SessionId[];
  depth: number;
  status: SessionStatus;
  phase: SessionPhase;
  activity: Activity;
  progress: Progress;
  /** 当前值得留意的事实；没有则省略。由服务端的 AttentionSupervisor 维护，随时间变化而不依赖新事件。 */
  attention?: AttentionItem[];
  /**
   * 待回答的提问数（见 questions.ts）；没有则省略。直接取自事件投影而不经 AttentionSupervisor 的复查，
   * 所以提问一落地它就是准的——列表与画布不必为一个数字去读全文。
   */
  openQuestions?: number;
  /**
   * 归档时间（ISO）；有值 = 已归档。归档只是界面上的整理（移出默认视图），不改会话本身的状态与记录；
   * 它不来自事件日志，而是服务端从会话目录里的 archive.json 合并进摘要的（像 attention 那样）。
   */
  archivedAt?: string;
  /** 谁归档的：user = 用户在网页上操作；retention = 留存策略自动归档。只在 archivedAt 有值时出现。 */
  archivedBy?: "user" | "retention";
  taskPreview: string;
  runCount: number;
  activeRunId?: RunId;
  lastRun?: {
    id: RunId;
    index: number;
    status: RunStatus;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  };
  usage?: Usage;
  messages: { total: number; pending: number; lastAt?: string };
  counters: { tools: number; failedTools: number; files: number; interventions: number };
  lastAssistantPreview?: string;
  lastError?: ErrorInfo;
  nativeRef?: NativeRef;
  capabilities: Capabilities;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  /** 最近一条事件的序号。 */
  seq: number;
}
