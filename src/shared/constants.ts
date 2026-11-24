/** 协议常量（服务端、MCP 桥、网页共用）。 */

/** 服务与 MCP 桥之间的 HTTP 协议主版本；不兼容变更时递增。 */
export const PROTOCOL_VERSION = 1;

/**
 * 服务可以公布的“可协商功能”，写在 service.json 与 /api/health 里。MCP 桥据此决定能不能用较新的写法与服务通信：
 * 老服务没有这个字段，桥就退回老写法，而不是把一个老服务会拒绝的请求发过去。
 * 新增这类功能往这里加；PROTOCOL_VERSION 只在新旧互不相认时才递增——递增会让正在运行的老服务被桥拒绝。
 */
export const SERVICE_FEATURES = [
  /** 来源的 sessionRef.source 可以是 "declared"（Agent 自报的会话标识）；老服务的校验只认 mcp-meta / env / console。 */
  "declared-session-ref",
  /** 来源的 workspaceSource 可以是 "host-record"（宿主记在对话上的工作区）；老服务的校验只认 mcp-roots / delegate-cwd，遇到别的取值会拒绝整条委派。 */
  "host-record-workspace",
  /** 委派可以只带 `profile`（用户在设置里定义的角色）而不带 `harness`；老服务的校验把 `harness` 当必填，会拒绝这样的请求。 */
  "delegation-profiles",
  /** 服务懂得会话归档：`status` 可以带 `includeArchived`，摘要里可能有 archivedAt / archivedBy；老服务不认识这个参数，桥只是不传。 */
  "session-archive",
  /** 服务有 `GET /api/sessions/:id/report`（把会话或整棵任务树导出为 Markdown 报告）；老服务没有这条路由，桥不把请求发过去撞 404，而是如实说明。 */
  "session-report",
  /**
   * 服务懂得“提问”（执行端的业务提问，不是授权）：会话里可能出现待回答的提问，摘要可能带 openQuestions，
   * “值得留意”里可能出现 kind "question"，并且有 `POST /api/sessions/:id/questions/:questionId/answer|decline`。
   * 老服务没有这些：桥在回复提问之前先看这一项，没有就如实说明，而不是把请求发过去撞上 404。
   * 反过来，老桥不认识 "question" 这种值得留意的事项：新服务按请求里的 `x-ensemble-accepts` 头只把它交给声明了这一项的调用方（见 ACCEPTS_HEADER）。
   */
  "session-questions",
  /**
   * 服务懂得“多个上级”（汇聚）：委派的 `parentSessionIds` 可以带不止一个已有会话，改挂也可以一次指定多个上级，
   * 摘要里在多于一个上级时多出 parentSessionIds（`parentSessionId` 始终是其中的第一个，老读者读到的仍是一棵树）。
   * 老服务的校验只认单个 `parentSessionId`，对多出来的字段按未知键忽略：桥据此只在服务声明了这一项时才发完整的集合，
   * 否则只发第一个、并在返回里如实说明“老服务只记录了第一个”，而不是悄悄丢掉其余的。
   */
  "multi-parent",
  /**
   * 委派的 `context` 里可以有第五种条目 `{ kind: "session", sessionId, include }`：引用另一个会话的真实产出，由服务在派发时从那个会话的事件日志里取，
   * 回执里多一个可选的 `contextRefs`（见 shared/handoff.ts）。老服务的校验按 `kind` 区分条目，对 "session" 只会回一句 “Invalid discriminator value”，
   * 桥据此在服务没有声明这一项时，在请求之前就拒绝带 session 条目的委派并说明原因（其余四种照常），而不是把一个注定被拒绝的请求发过去。
   */
  "context-session-ref",
] as const;
export type ServiceFeature = (typeof SERVICE_FEATURES)[number];

/** 默认端口固定，网页的 localStorage（按 origin 隔离）才能跨次启动保留偏好。 */
export const DEFAULT_PORT = 47821;

export const TOKEN_HEADER = "x-ensemble-token";
/**
 * MCP 桥在每个请求里声明自己读得懂哪些较新的内容：逗号分隔的功能名，取值同 SERVICE_FEATURES。
 * 老桥不带这个头，服务据此不把它读不懂的东西交给它——目前只有 "question" 这种值得留意的事项
 * （老桥遇到没见过的事项种类会把整行渲染成 `attention: undefined`）。网页不带 `x-ensemble-client`，不受影响。
 */
export const ACCEPTS_HEADER = "x-ensemble-accepts";
export const TOKEN_META_NAME = "ensemble-token";
export const INVALID_TOKEN = "invalid_token";

export const LIMITS = {
  /** 委派原文上限（字符）。 */
  maxTaskChars: 200_000,
  /** 单条补充消息上限（字符）。 */
  maxMessageChars: 50_000,
  /** 事件里保留的工具输出预览上限（字符）；超出会标记 truncated。 */
  maxToolOutputChars: 16_000,
  /** 事件里保留的工具输入预览上限（字符）。 */
  maxToolInputChars: 8_000,
  /** 单次读取事件的上限条数。 */
  maxEventsPerRead: 500,
  /**
   * 全局并发运行数上限的内置默认（安全阀，不是限流策略）：20，常规使用里派发的会话都会立即开始；
   * 超出的会话如实进入“排队”（等待并发名额），不会被拒绝。
   * 实际生效的值按优先级取：用户在设置窗口里指定的（存在 settings.json 的 maxConcurrentRuns，运行中可改、立即生效）
   * > 环境变量 ENSEMBLE_MAX_CONCURRENT_RUNS（只是没有指定时的初始值，启动时读一次）> 这个默认。
   */
  maxConcurrentRuns: 20,
  /**
   * 用户在设置里指定并发上限时的合法范围（含两端）。1 起：0 在环境变量里表示不设上限，但设置里“不设上限”是单独的取值
   * （"unlimited"），不靠 0，免得手改文件时把“0”读成“一个都不许跑”或“不限”。
   * 1000 远高于任何一台机器真能同时跑起来的执行端进程数，只为挡住手误和明显的坏值，不是性能建议。
   */
  concurrentRunsSetting: { min: 1, max: 1000 },
  /**
   * 委派嵌套深度上限，避免被委派会话再次无限委派。
   * 会话有多个上级时（汇聚），深度取“最长链”：它的深度 = 各上级深度的最大值 + 1，所以限制的是从最顶上的会话走到它最长的那条路。
   */
  maxDelegationDepth: 2,
  /**
   * 一个会话最多跟随几个上级（汇聚的扇入上限，`parentSessionIds` 去重之后的个数）。8 是实现取舍，不是用户确认的数值：
   * 远多于真实的“几个并行实现之后统一验收”，又让一个节点的连线数、详情页的上级列表、MCP 的回执都保持可读。
   */
  maxParents: 8,
  /**
   * 委派里引用其他会话的产出（`context` 的 `session` 条目，见 shared/handoff.ts）的额度。规则：
   * - 超出下面任何一项的“引用”都不会悄悄丢内容：单项过长的正文被截断，并在注入文本与页面上写明省略了多少字符、去哪里读全文；
   *   个数与合成后的整个提示超限的则整条委派被拒绝并说明（server/context-refs.ts）。
   * - 数值都是实现取舍，不是用户确认的：参照 maxTaskChars（20 万字符的任务原文）与单条 text / snippet 上下文（10 万字符）——
   *   一次引用最多 4 万，常见的几份评审结论、几十个文件的清单都放得下，又不会因为引用了一个长篇输出就把下游会话的上下文占满。
   */
  contextSession: {
    /** 一次委派最多引用几个会话（同一会话的多条合并成一条之后的个数）。 */
    maxRefs: 10,
    /** 单个引用里最终回答 / 最后一段文字的上限（字符）；超出的尾部被省略。 */
    maxResultChars: 40_000,
    /** 单个引用里文件清单的路径条数上限；超出的路径被省略。 */
    maxFiles: 200,
    /** 单个引用里错误消息原文的上限（字符）。 */
    maxErrorChars: 8_000,
    /** 含会话引用的委派，合成后的整个提示（任务原文 + 全部上下文）的上限（字符）；不含会话引用的委派不受这一项约束，行为与以前一致。 */
    maxPromptChars: 200_000,
  },
  /**
   * 同一来源在这段时间内提交“本质上相同”的委派，只会得到已有的那个会话（窗口从已有会话的创建时间起算）。
   * 大于 MCP 单次请求的超时（45 秒）与实测的重复间隔（11.7 秒），又不至于挡住用户隔一会儿再来一次的正当重试。
   */
  duplicateDelegationWindowMs: 120_000,
  /** SSE 重放缓冲条数。 */
  sseReplayBuffer: 2_000,
  /** 流式增量合并窗口（毫秒）。 */
  deltaCoalesceMs: 60,
  /** 没有运行中的会话且没有连接时，服务空闲多久后退出（毫秒）。 */
  idleExitMs: 30 * 60_000,
  /** MCP wait 工具单次最长等待（毫秒），低于宿主常见的工具超时。 */
  maxWaitMs: 50_000,
  /**
   * “值得留意”的判定阈值（毫秒），见 `shared/attention.ts`。只陈述事实，所以宁可保守：
   * 必须整段时间里都没有事件才算静默，而不是看某一类事件。
   */
  attention: {
    /** 没有进行中的工具调用时，多久没有任何事件算“静默”。 */
    quietMs: 4 * 60_000,
    /** 有工具调用进行中时，多久没有任何事件才值得提；构建与测试本来就可能很久，所以更宽。 */
    longToolMs: 10 * 60_000,
    /** 一次运行持续多久算“很久”。 */
    longRunMs: 60 * 60_000,
    /** 消息停在“已记录 / 已交给执行端”多久算“还没生效”。 */
    undeliveredMs: 2 * 60_000,
    /** 两个会话先后写同一个文件，间隔在多久之内算“同时写”。 */
    sharedFileWindowMs: 10 * 60_000,
  },
  /**
   * 执行端的提问（见 shared/questions.ts）。固定值而不是设置；都是实现取舍，不是用户逐项确认的数值。
   */
  question: {
    /**
     * 提问一直没有人回答多久之后，Ensemble 按“没有人能回答”的老办法告知执行端（请它自行假设并说明，然后继续），
     * 并把这条提问记为已过期。执行端等的是一个再也不会来的回答，比一次错误假设更糟。
     */
    timeoutMs: 60 * 60_000,
    /** 一次提问里最多收几个问题（多出来的丢弃，并在时间线上留一条诊断说明）。 */
    maxPrompts: 8,
    /** 单个问题的文字与标题上限（字符）。 */
    maxTextChars: 2_000,
    maxHeaderChars: 120,
    /** 一个问题最多收几个可选项；单个可选项的标签与说明上限（字符）。 */
    maxOptions: 20,
    maxLabelChars: 200,
    maxDescriptionChars: 400,
    /** 回答里单条文字（所选标签或自填内容）的上限，以及一个问题最多选几项。 */
    maxAnswerChars: 4_000,
    maxPicks: 20,
  },
  /**
   * 历史会话的冷热分离（见 server/hub.ts）：已结束的会话落一份摘要快照后从内存里放掉，需要完整记录时才按需读回。
   * 都是实现取舍，不是用户逐项确认的数值。
   */
  history: {
    /**
     * 保温期：会话最后一次活动（或最近一次被取用）之后多久内仍留在内存里。必须明显长于防重复窗口（duplicateDelegationWindowMs，
     * 2 分钟）：防重复只在内存里的会话中找，刚结束几十秒的会话如果已经冷了，“已完成的也算重复”这条行为就变了。
     */
    warmMs: 10 * 60_000,
    /** 后台清扫（把过了保温期的已结束会话冻结）的间隔。 */
    sweepMs: 60_000,
    /** 冷会话事件日志的读取缓存（LRU，缓存解析好的事件数组）：最多缓存几个会话。 */
    eventCacheEntries: 8,
    /** 同上，按事件日志的文件字节数合计的上限；单个日志比这还大就不缓存（读完即放）。 */
    eventCacheBytes: 64 * 1024 * 1024,
  },
  /** 一次归档 / 取消归档请求最多带多少个会话 id（`POST /api/sessions/archive|unarchive`）；再多的分批发。 */
  maxArchiveIds: 2_000,
  /**
   * 会话报告（`GET /api/sessions/:id/report`、MCP `read` 的 report 视图）里 maxChars 的上限（字符），也是路由不带 maxChars 时的默认值：
   * 报告是留存与转发用的完整文档而不是预览，所以默认几乎不截断；这个数远大于 MCP 单次读取的上限，约相当于 4 MB 的中文，
   * 容得下一整棵很大的任务树，又不会让一次请求把服务拖垮。下限见 `REPORT_LIMITS.minChars`（定义在 shared/report-options.ts，shared/report.ts 再导出）。
   * 都是实现取舍，不是用户确认的数值。
   */
  maxReportChars: 2_000_000,
  /** 留存策略（settings.json 的 retention，见 server/retention.ts）。 */
  retention: {
    /** keepDays 的合法范围上限（含）；下限是 1。10 年远超任何真实需要，只为挡住手误与明显的坏值。 */
    maxKeepDays: 3650,
    /** keepCount 的合法范围上限（含）；下限是 1：0 会让“最近的一棵”也被归档，等于每次都清空视图。 */
    maxKeepCount: 10_000,
    /** 留存清扫的周期（启动后与修改设置后另有一次，见 RetentionSweeper）。 */
    sweepMs: 60 * 60_000,
  },
} as const;

/**
 * Ensemble 启动执行端进程时写入的环境变量，以及可用于覆盖默认行为的变量名。
 * 如果被委派的会话自己也装了 Ensemble 插件，它的 MCP 桥会读 parentSession，把二次委派挂到正确的父会话下
 * （Codex、Pi、Claude Code、OpenCode、DSH 适配器会写入，Cursor 适配器不写；尽力而为：宿主可能过滤子进程环境变量）。
 * parentDepth 只是写给子进程参考，桥不读它：嵌套深度由服务端按父会话计算（SessionManager.delegate）。
 */
export const ENV = {
  parentSession: "ENSEMBLE_PARENT_SESSION",
  parentDepth: "ENSEMBLE_PARENT_DEPTH",
  home: "ENSEMBLE_HOME",
  port: "ENSEMBLE_PORT",
  fixture: "ENSEMBLE_FIXTURE",
  fixtureSpeed: "ENSEMBLE_FIXTURE_SPEED",
  piCli: "ENSEMBLE_PI_CLI",
  codexBin: "ENSEMBLE_CODEX_BIN",
  claudeBin: "ENSEMBLE_CLAUDE_BIN",
  /** 指向 opencode 可执行文件（或测试用的 JS 入口）；不设时依次找 PATH、npm 全局安装目录与官方安装目录。 */
  opencodeBin: "ENSEMBLE_OPENCODE_BIN",
  /** 指向 dsh（DeepSeek Harness）可执行文件或其 JS 入口（测试时指向假 dsh）；不设时找 PATH 与 npm 全局安装目录。 */
  dshBin: "ENSEMBLE_DSH_BIN",
  /** 指向装有 @cursor/sdk 的目录（含 node_modules 的目录，或包目录本身）。 */
  cursorSdk: "ENSEMBLE_CURSOR_SDK",
  /** Cursor 会话加载哪些本地设置层：none | project | user | team | mdm | plugins | all，可逗号分隔。默认 project。 */
  cursorSettings: "ENSEMBLE_CURSOR_SETTINGS",
  /**
   * 全局并发运行数上限的初始值：正整数；0 或 unlimited（不区分大小写）表示不设上限；未设置或无法解析时用 LIMITS.maxConcurrentRuns。
   * 在启动服务的进程环境里读取，只读一次；用户在设置窗口里指定过上限就以设置为准（设置优先），“恢复默认”之后才回到这里的值。
   */
  maxConcurrentRuns: "ENSEMBLE_MAX_CONCURRENT_RUNS",
  /**
   * 启动时怎样载入历史会话：`lazy`（默认）只读各会话的摘要快照，完整的事件日志要用到时才读；`eager` 回到老办法——
   * 启动时把全部会话的日志重放进内存、从不冻结（逃生口，出了问题时用它排除冷热分离）。不区分大小写；
   * 认不出的写法按默认处理（环境变量写错不该让服务起不来）。在启动服务的进程环境里读取，只读一次。
   */
  historyMode: "ENSEMBLE_HISTORY_MODE",
} as const;

/**
 * Cursor 适配器开发时对照的 @cursor/sdk 版本（类型定义与打包源码都按这个版本核对过）。
 * SDK 带原生组件且许可证不允许随插件分发，所以不打进包里，由用户按需安装。
 */
export const CURSOR_SDK_VERSION = "1.3.1";
