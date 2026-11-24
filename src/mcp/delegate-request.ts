import { ENV, LIMITS, type ServiceFeature } from "@shared/constants";
import { hasSessionRefs } from "@shared/handoff";
import { dedupeIds } from "@shared/lineage";
import type { DelegateRequest } from "@shared/protocol";
import type { AccessLevel, ContextItem, HarnessId, Origin, OriginHost, SessionSummary, WorkspaceSource } from "@shared/types";
import { ServiceError } from "./client";
import type { HostRecord } from "./host-title";
import { BridgeInputError } from "./tool-call";
import { isHomeOrRootDirectory, isPluginInstallDirectory } from "./workspace";

/**
 * `delegate` 的请求构造：把工具参数变成要发给服务的请求体，并把“这次到底怎么决定的”留成事实，回执（delegate-output.ts）只读这些事实，
 * 不再对同一组条件（有没有传 `cwd`、宿主报没报 roots、服务认不认某项功能……）重新解释一遍。
 * 老服务的降级（拒绝 / 只发第一个上级 / 省略出处 / 不发自报标识）都在这里一次定下，请求体与回执说的永远是同一回事。
 */

/**
 * 工具收到的参数。形状由 delegate-tool.ts 里的 zod schema 决定；那边的处理器把解析后的参数直接交给这里，
 * 两边对不上就是编译错误。
 */
export interface DelegateArgs {
  harness?: HarnessId | undefined;
  profile?: string | undefined;
  task: string;
  title?: string | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  access?: AccessLevel | undefined;
  context?: ContextItem[] | undefined;
  follows?: string | string[] | undefined;
  allowDuplicate?: boolean | undefined;
}

/** 宿主通过 MCP roots 报告的工作区（第一项）；已经按“这个宿主的 roots 认不认得出这段对话”筛过（见 call-context.ts 的 `CallContext.workspace`）。 */
export interface HostRoots {
  path: string;
}

/** 构造请求要向外界问的几件事。桥把它们接到真实的服务客户端与宿主文件上，测试接假的。 */
export interface DelegateEnvironment {
  /** 桥进程的环境变量：只有 `ENSEMBLE_PARENT_SESSION`（二次委派）从这里读。 */
  env: NodeJS.ProcessEnv;
  /** 桥进程的启动目录（`BridgeOptions.cwd`），没有就退回进程当前目录。它是会话最后的退路，不是来源的工作目录。 */
  bridgeDirectory: string | undefined;
  /** 测试用：覆盖“用户主目录”，用来判断桥是不是启动在主目录里。 */
  homeDirectory: string | undefined;
  /** 全部会话（含已归档）。这是委派向服务发的第一个请求，桥也在这里连上服务：`supports` 要在它之后才有意义。 */
  sessions: () => Promise<readonly SessionSummary[]>;
  /** 服务有没有声明某项可协商功能（老服务没有声明，一律按“没有”）。 */
  supports: (feature: ServiceFeature) => boolean;
  /** 宿主通过 roots 报告的工作区；读不到、或这个宿主的 roots 不可信（Cursor）时是 undefined。 */
  hostRoots: (host: OriginHost) => Promise<HostRoots | undefined>;
  /** 宿主为这段对话留在本机的记录（标题、对话所在的工作区），读不到的项不出现。`workspace` 只用来定位 Pi 的会话文件。 */
  readHostRecord: (origin: Origin, workspace: string | undefined) => Promise<HostRecord>;
}

/**
 * 被委派的会话去哪干活（`cwd`）是哪来的：
 * - `argument`：调用方显式传了 `cwd`；
 * - `host-roots`：宿主报告的工作区；
 * - `bridge-directory`：只能退回桥进程的启动目录（走到这一步，说明它既不是插件安装目录也不是主目录）。
 * 这与“来源（Main Agent）的工作目录”是两回事：后者记在 `body.origin.workspace`，出处在 `body.origin.workspaceSource`。
 */
export type CwdSource = "argument" | "host-roots" | "bridge-directory";

/** 这次委派挂在哪些上级后面，以及服务实际会记录哪些。 */
export interface ParentChoice {
  /** 调用方用 `follows` 点名的会话（服务里确有其会话；去掉空白与重复，保留写的先后）。 */
  followed: SessionSummary[];
  /** 按环境变量 / 宿主会话标识推断出的上级（二次委派）。点名了 `follows` 时也会算出来，只是不采用，回执要说明。 */
  inferred: string | undefined;
  /** 想挂的上级：点名的优先于推断的，第一个是主上级。 */
  wanted: string[];
  /** 服务实际会记录的上级：老服务不认识 `parentSessionIds`，只记第一个。请求体里的 `parentSessionId(s)` 就取自这里。 */
  recorded: string[];
}

/** 构造好的请求，以及回执要说的事实。 */
export interface PreparedDelegation {
  /** 实际发给服务的请求体。 */
  body: DelegateRequest;
  /** 会话的工作目录是哪来的（回执里的 `workspace source:`）。 */
  cwdSource: CwdSource;
  /** 上级的取舍。 */
  parents: ParentChoice;
  /** 自报的对话标识（`declared`）老服务存不了：没有放进 `body.origin.sessionRef`（来源 key 仍在，会话仍按它区分），回执要如实说明。 */
  declaredNotRecorded: boolean;
}

type Supports = (feature: ServiceFeature) => boolean;

/**
 * 在向服务发出委派之前，把参数变成请求。拒绝的先后次序是行为的一部分（哪些由桥在请求之前拒绝、哪些留给服务）：
 *   1. 没有 `harness` 也没有 `profile`——不碰服务；
 *   2. 取全部会话（桥连上服务）；
 *   3. 老服务不认识 `profile`、不认识 `session` 上下文引用——`supports` 只能在上一步之后问；
 *   4. 读宿主的 roots；没有 `cwd`（空串与只含空白的也算没有，见下面的 `cwdArgument`）、没有 roots，桥又只能退回插件安装目录或主目录——拒绝；
 *   5. `follows` 超过个数上限、点名了不存在的会话——拒绝；
 *   6. 读宿主对这段对话的记录（前面都通过了才去碰宿主的文件）。
 * 参数的形状与长度由 schema 在进入这里之前校验；模型、强度、角色、层数、上下文大小等业务规则留给服务，桥不重复。
 */
export async function prepareDelegateRequest(args: DelegateArgs, origin: Origin, environment: DelegateEnvironment): Promise<PreparedDelegation> {
  // harness 不再是必填（有 profile 就够）：至少要有一个，在请求服务之前就拒绝。
  if (!args.harness && !args.profile) {
    throw new BridgeInputError("Give `harness`, or `profile` naming one of the roles the user defined in Ensemble's settings (call `harnesses` to see them).");
  }
  // “没传 cwd”只有这一个定义：缺省、空串、只含空白都算。后面的拒绝判断、取值与来源标注都用这一个结果。
  // 以前各判各的：空串在拒绝判断与出处里算“没传”，取值却仍是空串（`??` 只跳过 null / undefined）而原样发给服务（回 400）；只含空白的则被当成传了。
  const cwdArgument = args.cwd?.trim() ? args.cwd : undefined;
  const all = await environment.sessions();
  const supports: Supports = (feature) => environment.supports(feature);
  refuseWhatTheServiceCannotDo(args, supports);

  const roots = await environment.hostRoots(origin.host);
  const directory = chooseDirectory(cwdArgument, roots, environment);
  const parents = chooseParents(args.follows, origin, all, environment.env, supports);

  // 宿主为这段对话留在本机的记录（读得到才带）：标题，以及对话所在的工作区（目前只有 Cursor）。只在委派时读一次，其他工具调用不碰宿主的文件。
  // 找 Pi 的会话文件用的工作目录取宿主自己报告的、退而求其次是桥进程的目录（Pi 没有交出会话标识，靠它定位会话；Pi 在项目目录里拉起 MCP 进程），
  // 不是这次委派要去的 args.cwd。这个目录只用来找标题，不会被记成来源的工作目录。
  const record = await environment.readHostRecord(origin, roots?.path ?? environment.bridgeDirectory);
  const chosen = chooseOrigin(origin, record, roots, cwdArgument, supports);

  const [parentSessionId] = parents.recorded;
  const body: DelegateRequest = {
    ...(args.harness ? { harness: args.harness } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
    task: args.task,
    cwd: directory.cwd,
    origin: chosen.sent,
    ...(args.title ? { title: args.title } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.access ? { access: args.access } : {}),
    ...(args.context ? { context: args.context } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(parents.recorded.length > 1 ? { parentSessionIds: parents.recorded } : {}),
    ...(args.allowDuplicate ? { allowDuplicate: true } : {}),
  };
  return { body, cwdSource: directory.source, parents, declaredNotRecorded: chosen.declaredNotRecorded };
}

/**
 * 服务层数超限由 `follows` 引起时（调用方点名了上级），下一步是“跟随更早的会话或不传”，而不是“别再往下委派”：
 * 在服务回的错误上标明 `via: "follows"`，`explainError` 据此换一套建议。其余错误原样交回。
 */
export function markFollowsFailure(parents: ParentChoice, error: unknown): unknown {
  if (parents.followed.length > 0 && error instanceof ServiceError && error.code === "depth_exceeded") {
    return new ServiceError(error.code, error.message, error.status, { ...error.details, via: "follows" });
  }
  return error;
}

function refuseWhatTheServiceCannotDo(args: DelegateArgs, supports: Supports): void {
  // 老服务不认识 profile，而且会静默丢掉不认识的字段：角色里的模型、强度、只读就悄悄没了。所以只要带了 profile 就拦住，不论有没有 harness。
  // supports() 要在连上服务之后才有意义，所以放在取会话的那次请求之后。
  if (args.profile && !supports("delegation-profiles")) {
    throw new BridgeInputError(
      "The running Ensemble service is older than this plugin and does not know roles, so `profile` would be ignored. " +
        "Ask the user to restart the Ensemble service, or call `delegate` again with `harness` (and `model`) instead of `profile`.",
    );
  }
  // 老服务的校验不认识 `session` 这一种上下文条目：整条委派会被拒绝，只回一句 “Invalid discriminator value”。所以在请求之前就拦住并说明原因；
  // 其余四种（text / file / snippet / url）老服务照常接受，不受影响。绝不悄悄把 session 条目去掉再发——那样下游会话拿不到主模型以为交出去的东西。
  if (hasSessionRefs(args.context) && !supports("context-session-ref")) {
    throw new BridgeInputError(
      "The running Ensemble service is older than this plugin and does not know `session` references in `context`, so it would reject them. " +
        "Ask the user to restart the Ensemble service, or call `delegate` again with `text` or `file` context instead (`read` the session's result yourself and pass what matters).",
    );
  }
}

function chooseDirectory(cwdArgument: string | undefined, roots: HostRoots | undefined, environment: DelegateEnvironment): { cwd: string; source: CwdSource } {
  const fallback = environment.bridgeDirectory ?? process.cwd();
  if (!cwdArgument && !roots) {
    // 桥只能退回自己的进程目录，而它在这两种情况下都不是项目：插件安装目录（Agent Plugins 默认在插件根目录里启动 MCP 服务），
    // 或用户主目录 / 磁盘根目录（Cursor 起 stdio MCP 服务的默认工作目录是主目录，又被所有窗口共用）。
    // 会话是 Full Access，不能悄悄放进这里。
    if (isPluginInstallDirectory(fallback)) {
      throw new BridgeInputError(
        "I cannot tell which project this conversation is working in: the host did not report a workspace folder, and Ensemble was started from its own plugin directory. " +
          "Call `delegate` again with `cwd` set to the absolute path of the project directory the session should work in.",
      );
    }
    if (isHomeOrRootDirectory(fallback, environment.homeDirectory)) {
      throw new BridgeInputError(
        "I cannot tell which project this conversation is working in: the host did not report a workspace folder, and Ensemble was started from the user's home directory (or a drive root), which is not a project. " +
          "Some hosts, Cursor for example, run the plugin as one process shared by all their windows, started from the home directory. " +
          "Call `delegate` again with `cwd` set to the absolute path of the project directory the session should work in.",
      );
    }
  }
  // `cwdArgument` 在入口已经规范过（见 prepareDelegateRequest）：要么是有内容的字符串，要么是 undefined，
  // 所以上面的拒绝判断、这里的取值（`??`）与出处（真值判断）说的是同一回事。
  return {
    cwd: cwdArgument ?? roots?.path ?? fallback,
    source: cwdArgument ? "argument" : roots ? "host-roots" : "bridge-directory",
  };
}

function chooseParents(follows: string | string[] | undefined, origin: Origin, all: readonly SessionSummary[], env: NodeJS.ProcessEnv, supports: Supports): ParentChoice {
  // follows 是一个 id，或一组 id（汇聚：这件事依赖这几个会话的结果）。去掉空白与重复、保留写的先后；第一个是主上级。
  const followsIds = dedupeIds((Array.isArray(follows) ? follows : [follows ?? ""]).map((id) => id.trim()).filter((id) => id.length > 0));
  if (followsIds.length > LIMITS.maxParents) {
    throw new BridgeInputError(
      `\`follows\` names ${followsIds.length} sessions, but one session can follow at most ${LIMITS.maxParents}. Keep the sessions this work really depends on, or split it into an intermediate session that collects some of them.`,
    );
  }
  const found = followsIds.map((id) => all.find((session) => session.id === id));
  // 不存在的 id 一次全部说出来，不让主模型改一个再撞下一个。
  const missing = followsIds.filter((_, index) => found[index] === undefined);
  if (missing.length > 0) {
    throw new BridgeInputError(
      missing.length === 1
        ? `Session ${missing[0]} (passed as \`follows\`) does not exist. Call \`status\` with scope "all" to list the existing session ids, then call \`delegate\` again with one of them, or omit \`follows\`.`
        : `Sessions ${missing.join(", ")} (passed as \`follows\`) do not exist. Call \`status\` with scope "all" to list the existing session ids, then call \`delegate\` again with existing ones, or omit \`follows\`.`,
    );
  }
  const followed = found.flatMap((session) => (session ? [session] : []));
  const inferred = inferParent(origin, all, env);
  // 显式声明优先于自动推断；两者都只决定页面上的承接关系，发起端不变。
  const wanted = followed.length > 0 ? followed.map((session) => session.id) : inferred ? [inferred] : [];
  // 老服务不认识 parentSessionIds，也会静默丢掉它：不发，只带第一个，并在回执里如实说明另外几个没有记录。
  const recorded = wanted.length < 2 || supports("multi-parent") ? wanted : wanted.slice(0, 1);
  return { followed, inferred, wanted, recorded };
}

/** 这次委派是否来自某个被委派的会话（二次委派）：先看环境变量，再用宿主会话标识匹配已知会话。 */
function inferParent(origin: Origin, all: readonly SessionSummary[], env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env[ENV.parentSession];
  if (fromEnv && all.some((session) => session.id === fromEnv)) return fromEnv;
  const ref = origin.sessionRef;
  // 自报的标识没法核对：不能凭它把会话挂到别人名下，画布上的承接关系只认宿主给的标识（要连线请用 `follows`）。
  if (!ref || ref.source === "declared") return undefined;
  return all.find((session) => session.nativeRef?.id === ref.id)?.id;
}

function chooseOrigin(
  base: Origin,
  record: HostRecord,
  roots: HostRoots | undefined,
  cwdArgument: string | undefined,
  supports: Supports,
): { sent: Origin; declaredNotRecorded: boolean } {
  // 来源（Main Agent）的工作目录只取有出处的三种，按可信度排：
  //   1. 宿主对这段对话自己的记录（Cursor 的对话记录，按对话标识查；没有标识就不查、不猜）——它说的是“这段对话在哪个项目里”，
  //      而显式的 cwd 只是被委派的会话要去哪干活，两者可以不同（在项目 A 里让会话去项目 B 干活）；
  //   2. 宿主报告的 roots（Cursor 的不采信，见 call-context.ts 的 CallContext.workspace）；
  //   3. 这次显式传入的 cwd。
  // 都没有就不写，页面上显示“未知”——不拿桥进程的启动目录凑数，那多半只是插件被启动的地方。
  // 这个目录只说明来源，不决定被委派的会话在哪干活（那只认显式 cwd 或宿主 roots）：自报的对话标识没法核对，会话又是 Full Access。
  const workspace: { path: string; source: WorkspaceSource } | undefined = record.workspace
    ? { path: record.workspace, source: "host-record" }
    : roots
      ? { path: roots.path, source: "mcp-roots" }
      : cwdArgument ? { path: cwdArgument, source: "delegate-cwd" } : undefined;
  // 老服务的校验只认 mcp-roots / delegate-cwd，遇到 host-record 会拒绝整条委派：目录照发，只是不带来历
  // （页面照样显示路径，只是没有“来自……”的注）。
  const sourceKnown = workspace?.source !== "host-record" || supports("host-record-workspace");
  const described: Origin = {
    ...base,
    ...(workspace ? { workspace: workspace.path, ...(sourceKnown ? { workspaceSource: workspace.source } : {}) } : {}),
    ...(record.title ? { hostTitle: record.title } : {}),
  };
  // 老服务的校验只认 mcp-meta / env / console，遇到 declared 会拒绝整条委派：不发 sessionRef（来源 key 只是字符串，照样按对话区分），并如实告诉主 Agent。
  const declaredNotRecorded = described.sessionRef?.source === "declared" && !supports("declared-session-ref");
  const sent: Origin = { ...described };
  if (declaredNotRecorded) delete sent.sessionRef;
  return { sent, declaredNotRecorded };
}
