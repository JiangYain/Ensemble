import { requestedContext } from "@shared/handoff";
import { parentIdsOf, sameParentSet } from "@shared/lineage";
import { catalogDefaultModel } from "@shared/models";
import { derivePhase, type SessionState } from "@shared/projection";
import type { AccessLevel, ContextItem, HarnessId, HarnessInfo, MessageId, RunId, SessionId, SessionPhase } from "@shared/types";
import type { EventHub } from "./hub";

/**
 * 同一来源在很短时间内提交了“本质上相同”的委派（例如宿主把一次工具调用执行了两次）时，
 * 不再新建会话，而是回到已有的那个。判定只看中枢里已有会话的 meta，所以服务重启后（会话由事件日志重放）仍然有效。
 */

/** 这次委派要成为的样子（校验与默认值都已落定）。 */
export interface WantedDelegation {
  originKey: string;
  harness: HarnessId;
  /** 已规范化的绝对路径。 */
  cwd: string;
  /** 已 trim 的任务原文。 */
  task: string;
  /** 已经过模型把关的结果：可以是“没指定”。 */
  model: string | undefined;
  effort: string | undefined;
  access: AccessLevel;
  context: readonly ContextItem[];
  parentSessionId: SessionId | undefined;
  /** 汇聚：多于一个上级时的完整集合（`parentSessionId` 是第一项）；比较时不看先后，同一组上级换个写法顺序不算另一个委派。 */
  parentSessionIds?: readonly SessionId[] | undefined;
}

export interface DuplicateHit {
  sessionId: SessionId;
  runId: RunId;
  messageId: MessageId;
  /** 已有会话是多久以前创建的。 */
  ageMs: number;
}

/**
 * 还算“有效”的阶段。失败、取消、停止、丢失的会话不算：用户或主 Agent 在失败后立刻重试是正当的。
 * `done` 算：一个任务在窗口内做完、又收到逐字相同的委派，几乎一定是重复提交；
 * 真要再来一次，命中时的提示会告诉调用方怎么放行。
 */
const STANDING = new Set<SessionPhase>(["starting", "queued", "running", "ready", "done"]);

type Catalog = Pick<HarnessInfo, "models" | "defaultModel">;

/**
 * 在窗口内找一个与 `wanted` 相同的有效会话；多个时取最新创建的。必须是同步的：
 * 调用方在同一个同步段里接着创建会话，检查与登记之间不能有 await，否则并发的两个请求会都认为自己是第一个。
 */
export function findDuplicateDelegation(hub: Pick<EventHub, "hotIds" | "state">, wanted: WantedDelegation, info: Catalog, nowMs: number, windowMs: number): DuplicateHit | undefined {
  if (windowMs <= 0) return undefined;
  const effective = effectiveChoice(info, wanted.model, wanted.effort);
  const cwd = pathKey(wanted.cwd);
  const parents = parentIdsOf(wanted);
  let context: string | undefined; // 只对前面都对得上的少数会话才序列化
  let best: { state: SessionState; run: { id: RunId; messageId: MessageId }; age: number } | undefined;

  // 只看内存里的会话：冷会话都已经过了保温期（LIMITS.history.warmMs，10 分钟），而防重复窗口只有 2 分钟，
  // 它们不可能落在窗口里；这也是保温期必须明显长于窗口的原因（见 constants.ts 与 hub.test 里的核对）。
  // 归档标记不参与判重：已归档的已完成会话（done）照样会命中——归档只是移出默认视图，不是“不存在了”；
  // 把它排除在外，用户刚归档、主 Agent 又重复提交的那一次就会再开一个完整的运行。命中之后不动它的归档状态，见 manager.delegate。
  for (const id of hub.hotIds()) {
    const state = hub.state(id);
    if (!state) continue;
    const { meta } = state;
    const age = nowMs - Date.parse(meta.createdAt);
    // 时钟被拨回去时创建时间会在“未来”：同样按相隔多久算，而不是永远不过期。
    if (!(Math.abs(age) < windowMs) || (best && age >= best.age)) continue;
    if (meta.origin.key !== wanted.originKey || meta.harness !== wanted.harness || meta.access !== wanted.access) continue;
    if (meta.task.text !== wanted.task || !sameParentSet(parentIdsOf(meta), parents) || pathKey(meta.cwd) !== cwd) continue;
    const settled = effectiveChoice(info, meta.model?.requested, meta.effort);
    if (settled.model !== effective.model || settled.effort !== effective.effort) continue;
    if (!STANDING.has(derivePhase(state))) continue;
    const run = state.runs.find((candidate) => candidate.trigger === "task");
    if (!run) continue;
    // 只比较“请求了什么”：session 条目里的取样事实（取样时刻、当时的字符数……）每次都不同，不参与比较，
    // 否则带会话引用的委派永远判不出重复。没有 session 条目的上下文（含全部旧会话的）经过 requestedContext 还是原来的元素，结果与以前逐字一致。
    context ??= stable(requestedContext(wanted.context));
    if (!Array.isArray(meta.task.context) || stable(requestedContext(meta.task.context)) !== context) continue;
    best = { state, run, age };
  }
  return best && { sessionId: best.state.meta.id, runId: best.run.id, messageId: best.run.messageId, ageMs: Math.max(0, best.age) };
}

/**
 * 省略与写明默认值是同一个委派：把“请求值”折算成实际会用的模型与档位再比较。
 * 目录给不出默认（不知道会用哪个）时保持原样，不去猜，宁可判成不同。
 *
 * 这里的“默认”只能是执行端自己的默认，而不是 `resolveModelChoices` 给出的默认：用户在设置里指定了默认模型时，
 * 委派入口（decideModel）已经把它固定进了 `wanted.model` 和新会话的 `meta.model`，所以走到这里仍是“没指定”的，
 * 都是没有任何固定、实际由执行端按自己的默认去跑的会话。拿现在的设置去折算它们，会把设置改动之前跑在
 * 执行端默认上的会话，误判成与“现在用指定默认”的委派相同。
 */
function effectiveChoice(info: Catalog, model: string | undefined, effort: string | undefined): { model: string | undefined; effort: string | undefined } {
  const resolved = model ?? catalogDefaultModel(info);
  return { model: resolved, effort: effort ?? info.models.find((entry) => entry.id === resolved)?.defaultEffort };
}

/** Windows 与 macOS 的路径不区分大小写。 */
function pathKey(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/** 键顺序不同、带不带 undefined 字段都不影响结果。 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}
