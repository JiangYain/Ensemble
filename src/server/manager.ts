import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { LIMITS } from "@shared/constants";
import { newDelivery } from "@shared/delivery";
import { deriveTitle, isoNow } from "@shared/format";
import { hasSessionRefs, type ContextRefReceipt } from "@shared/handoff";
import { newId } from "@shared/ids";
import { parentFields } from "@shared/lineage";
import { decideModel, type ModelDecision } from "@shared/models";
import type { SessionState } from "@shared/projection";
import type { AnswerInput, QuestionId } from "@shared/questions";
import type {
  AccessLevel, Actor, ContextItem, DeliveryStage, HarnessId, Message, MessageId, NativeRef,
  Origin, RunId, SessionId, SessionMeta,
} from "@shared/types";
import { reviveSession } from "./archive";
import { composePrompt } from "./compose";
import { prepareSessionContext } from "./context-refs";
import { findDuplicateDelegation } from "./dedupe";
import { EnsembleError } from "./errors";
import type { ExecutorRegistry } from "./executors/registry";
import type { Executor } from "./executors/types";
import type { EventHub, HubNode } from "./hub";
import type { Logger } from "./logger";
import type { NoticeCenter } from "./notices";
import { missingParents, normalizeParents } from "./parents";
import { QuestionDesk, type ResolvedQuestion } from "./questions";
import { RunSlots, UNLIMITED_RUNS } from "./run-slots";
import { planRelink } from "./relink";
import { abandonSession, SessionRuntime, sourceOf } from "./session-runtime";

export interface ManagerConfig {
  /**
   * 全局并发运行数上限的初始值；UNLIMITED_RUNS（0）表示不设上限，超过上限的会话排队。
   * 运行中可以用 setMaxConcurrentRuns 调整，所以这里只是起点——服务启动时它已经是“设置 > 环境变量 > 默认”合成之后的结果（见 concurrency.ts）。
   */
  maxConcurrentRuns: number;
  maxDepth: number;
  /** 超时只记录诊断，不编造取消结果。 */
  cancelConfirmMs: number;
  /** 相同委派的判重窗口，见 `dedupe.ts`；0 表示不判重。 */
  duplicateWindowMs: number;
  /** 执行端的提问无人回答多久后，告知它自行假设并记为过期（见 `questions.ts`）；0 表示不设时限。 */
  questionTimeoutMs: number;
}

export interface DelegateInput {
  harness: HarnessId;
  task: string;
  title?: string;
  cwd: string;
  model?: string;
  effort?: string;
  access?: AccessLevel;
  context?: ContextItem[];
  origin: Origin;
  parentSessionId?: SessionId;
  /**
   * 汇聚：这件事依赖几个已有会话的结果（有序、去重，最多 LIMITS.maxParents 个）。给了它，`parentSessionId` 可以省略；
   * 同时给时必须是它的第一项。第一个是主上级，会话的 `parentSessionId` 就是它，层数取各上级里最深的那个加一。
   */
  parentSessionIds?: SessionId[];
  /** 明确要第二个一模一样的会话时放行（默认会被当作重复提交挡住）。 */
  allowDuplicate?: boolean;
}

export interface DelegateResult {
  sessionId: SessionId;
  runId: RunId;
  messageId: MessageId;
  /** 命中了短时间内相同的委派：没有新建任何东西，上面是已有那个会话的标识。 */
  duplicate?: { ageMs: number };
  /** 上下文里带了 `session` 条目、并且新建了会话时：每个被引用的会话一条，说明派发那一刻取到了什么（见 shared/handoff.ts）。 */
  contextRefs?: ContextRefReceipt[];
}

export interface RelinkResult {
  /** 已经是这个上级时为 false，什么也没有写。 */
  changed: boolean;
  /** 因此层数跟着变的后代（不含被改的会话自己）。 */
  depthUpdated: SessionId[];
}

export interface SendInput {
  text: string;
  mode?: "auto" | "steer" | "follow_up";
  author: Actor;
}

export interface SendResult {
  messageId: MessageId;
  kind: Message["kind"];
  runId: RunId;
  stage: DeliveryStage;
}

export const DEFAULT_MANAGER_CONFIG: ManagerConfig = {
  maxConcurrentRuns: LIMITS.maxConcurrentRuns,
  maxDepth: LIMITS.maxDelegationDepth,
  cancelConfirmMs: 20_000,
  duplicateWindowMs: LIMITS.duplicateDelegationWindowMs,
  questionTimeoutMs: LIMITS.question.timeoutMs,
};

interface ManagerDeps {
  hub: EventHub;
  executors: ExecutorRegistry;
  notices: NoticeCenter;
  log: Logger;
  config?: Partial<ManagerConfig>;
}

/** 委派准入、会话查找和服务生命周期。原生连接、队列与回执都归 SessionRuntime。 */
export class SessionManager {
  private readonly config: ManagerConfig;
  private readonly runtimes = new Map<SessionId, SessionRuntime>();
  private readonly slots: RunSlots;
  private readonly questions: QuestionDesk;
  private shuttingDown: Promise<void> | undefined;

  constructor(private readonly deps: ManagerDeps) {
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...deps.config };
    this.slots = new RunSlots(this.config.maxConcurrentRuns);
    this.questions = new QuestionDesk({
      hub: deps.hub,
      notices: deps.notices,
      log: deps.log.child("questions"),
      connection: (id) => this.runtimes.get(id)?.connected,
      timeoutMs: this.config.questionTimeoutMs,
    });
    // 还连着执行端的会话（持有运行时：进行中的，或跑完后仍保持连接等着继续交代的）不许被冻结出内存：
    // 运行时之后还要往它的日志里写事件。运行时关闭（停止、断开、服务关闭）之后它才进入保温期，再被冻结。
    deps.hub.addFreezeGuard((id) => !this.runtimes.has(id));
  }

  /** `max` 为 0 表示不设上限（见 UNLIMITED_RUNS）；调低上限之后 `occupied` 可以暂时大于 `max`。 */
  capacity(): { occupied: number; max: number; waiting: number } {
    return this.slots.capacity;
  }

  /**
   * 运行中调整全局并发上限（设置窗口改了它，见 concurrency.ts）：调高立刻让排队的会话按先到先得开始；
   * 调低不会中断任何在跑的会话，只让新请求排队，直到占用数降到新上限以下（见 RunSlots）。
   * 提升排队会话会同时产生一批事件：包进一个批里，订阅者（SSE、wait）看到的是一次完整的变化而不是逐条的中间状态。
   * `source` 只写进日志：这个值是谁定的（settings / env / default / startup）。每次真的改了上限记一行，没变化不记。
   */
  setMaxConcurrentRuns(max: number, source: string): void {
    const from = this.slots.capacity.max;
    try {
      this.deps.hub.batch(() => this.slots.setMax(max));
    } finally {
      const now = this.slots.capacity;
      if (now.max !== from) {
        this.deps.log.info("concurrency limit changed", { from: describeLimit(from), to: describeLimit(now.max), source, occupied: now.occupied, waiting: now.waiting });
      }
    }
  }

  /**
   * 名额的占用、等待或上限变了（同步通知，监听者自己合并）：HTTP 层靠它把容量实时推给网页。
   * 监听者出错只记日志，不影响名额。返回取消订阅的函数。
   */
  onCapacityChange(listener: () => void): () => void {
    return this.slots.onChange(() => {
      try {
        listener();
      } catch (error) {
        this.deps.log.warn("capacity listener failed", { error });
      }
    });
  }

  hasActiveWork(): boolean {
    for (const runtime of this.runtimes.values()) if (runtime.busy) return true;
    return false;
  }

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    const text = checkedText(input.task, LIMITS.maxTaskChars, "task text");
    // 汇聚：上级可以不止一个，第一个是主上级。归一化（去重、个数上限、两种写法对得上）只是校验，所以放在最前面。
    const parentIds = normalizeParents(input);
    const { executors, hub } = this.deps;
    const executor = executors.get(input.harness);
    if (!executor) {
      throw new EnsembleError("harness_unavailable",
        "Harness \"" + input.harness + "\" is not enabled. Available: " + (executors.ids().join(", ") || "none") + ".");
    }
    const cwd = await resolveWorkingDirectory(input.cwd);
    const info = await executors.info(input.harness);
    const setup = info?.setup;
    const detail = setup ? { setup } : undefined;
    const suffix = setup ? ": " + setup.message : ".";
    if (!info || info.status === "unavailable") {
      throw new EnsembleError("harness_unavailable", "Harness \"" + input.harness + "\" is unavailable" + suffix, detail);
    }
    if (info.status === "needs_setup") {
      throw new EnsembleError("harness_needs_setup", "Harness \"" + input.harness + "\" needs setup" + suffix, detail);
    }
    const access = input.access ?? "full";
    const enforcement = info.access[access];
    if (!enforcement) {
      const supported = Object.keys(info.access).filter((level) => info.access[level as AccessLevel]);
      throw new EnsembleError("access_unsupported",
        "Harness \"" + input.harness + "\" cannot enforce access level \"" + access + "\". Supported: " + (supported.join(", ") || "none") + ".");
    }
    // 在创建会话前完成校验并固定模型与档位，不让排队后的原生启动再次决定默认模型或默认档位。
    const decision = decideModel(info, input.model, input.effort);
    if (!decision.ok) throw modelNotAllowed(input.harness, input.model, input.effort, decision);
    const { model, effort } = decision;
    // 会话引用（`context` 里的 session 条目）：要读上游会话自己的事件日志，冷会话的日志在磁盘上（有 await），
    // 所以必须排在下面“判重到创建”那段同步代码之前。展开不改任何会话。
    // 没有会话引用的委派不经过这里，下面的流程与以前一模一样。
    const prepared = hasSessionRefs(input.context) ? await prepareSessionContext(hub, text, input.context ?? []) : undefined;
    // 会拒绝这次委派的事（上级不存在、层数超限、服务正在关闭）要在动归档之前查完：被拒绝的委派不能留下“上级被取消归档”的副作用，
    // 而取消归档会连同上级的整棵子树一起回来，事后没法原样放回去。
    this.admitParents(parentIds);
    // 要接在已归档的会话后面，说明它又在用了：逐个先取消归档（连同各自的上级链与子树）。
    // 这些 await 必须在下面那段同步检查之前：检查与创建之间不能再有 await。
    for (const parentId of parentIds) {
      if (hub.archiveOf(parentId)) await reviveSession(hub, parentId, this.deps.log);
    }
    // 取消归档有 await，期间上级可能被删、服务可能开始关闭：再查一遍，创建用的层数是这一遍算出来的。
    const depth = this.admitParents(parentIds);

    // 检查与下面的创建之间不能有 await：并发的相同请求依靠“先到的会话已经登记在中枢里”来互相发现。
    const wanted = {
      originKey: input.origin.key, harness: input.harness, cwd, task: text, model, effort, access,
      // 有会话引用时是展开之后的上下文（同一会话的多条已合并，带着取样事实）；判重只比较其中“请求了什么”的部分，见 dedupe.ts。
      context: prepared?.context ?? input.context ?? [], parentSessionId: parentIds[0], ...(parentIds.length > 1 ? { parentSessionIds: parentIds } : {}),
    };
    const duplicate = input.allowDuplicate ? undefined : findDuplicateDelegation(hub, wanted, info, Date.now(), this.config.duplicateWindowMs);
    if (duplicate) {
      // 命中重复什么也不产生：不开始运行、不写事件、不画线，只回答“这个会话已经存在”，所以也不动它的归档标记。
      // 命中的可以是已归档的已完成会话（判重只看热会话，归档标记不参与）：用户刚归档了它、主 Agent 又重复提交时就是这样。
      // 它照旧归档着，回执里的摘要如实带着 archivedAt，调用方仍可 wait / read；要“被用到”才取消归档（send、follows、改挂都会产生新的运行或连线）。
      // 例外只来自上面那段：follows 指向的已归档上级在判重之前就取消了归档（连同整棵子树），被命中的会话若在其中就随之回来——那是 follows 的语义，不是判重的。
      const { ageMs, ...existing } = duplicate;
      return { ...existing, duplicate: { ageMs } };
    }

    const id = newId("ses");
    const context = wanted.context;
    // 有会话引用时，提示在展开那一步已经合成好了（块的位置是边拼边量的，和存下来的 sample.block 对得上），这里不再拼第二遍。
    const prompt = prepared?.prompt ?? composePrompt(text, context);
    const now = isoNow();
    const meta: SessionMeta = {
      id, title: input.title?.trim() || deriveTitle(text), harness: input.harness, runtime: executor.runtime,
      ...(model ? { model: { requested: model } } : {}),
      ...(effort ? { effort } : {}),
      access, accessEnforcement: enforcement, cwd, origin: input.origin,
      // 没有上级：两个字段都不写；一个上级：只写 parentSessionId（与原来一字不差）；多个：再多一个完整的 parentSessionIds。
      ...parentFields(parentIds),
      depth, task: { text, context, prompt }, createdAt: now, capabilities: info.capabilities,
    };
    const author: Actor = { kind: input.origin.kind, label: input.origin.hostLabel, originKey: input.origin.key };
    const message = makeMessage(meta, "task", author, text);
    return hub.batch(() => {
      hub.emit(id, { kind: "session.created", data: { meta }, source: "ensemble", at: now });
      const runtime = this.attach(this.requireState(id), executor);
      this.recordMessage(meta, message);
      return {
        sessionId: id, runId: runtime.enqueue(message, prompt), messageId: message.id,
        // 回执只在新建了会话时给；命中重复时没有新建任何东西，已有会话的记录里就有当时的取样
        ...(prepared ? { contextRefs: prepared.receipts } : {}),
      };
    });
  }

  /**
   * 事后调整“上级会话”（画布上的承接关系），`null` 表示改回直接挂在来源下；给一组有序的上级（汇聚）就整组替换原来的上级，第一个是主上级。
   * 只是一条关系记录：不是干预（不发消息、不通知主 Agent），也不碰执行端，所以已结束与正在运行的会话都可以改。
   * 发起端（origin）不变，wait / status / 干预同步仍按它走。
   *
   * 规划只读索引信息（`hub.node`，冷会话也能读），所以不合规的改挂（不存在、成环、超过层数）不必解冻任何会话就被拒绝；
   * 通过之后，把真正要写事件的会话（被改的会话与因它层数变化的后代）解冻，解冻期间关系可能变了，所以解冻完再规划一次，
   * 直到要写的会话都在内存里，才在同一个同步段里写完。新上级若已归档，先取消归档（它又在用了）。
   * 所有相关会话本来就在内存里、新上级也没归档时，整个过程没有 await，和同步版本一样。
   */
  async relink(id: SessionId, parents: SessionId | readonly SessionId[] | null, by: Actor): Promise<RelinkResult> {
    this.assertServing();
    const { hub } = this.deps;
    // 空数组不是“没有上级”（那是 null）：归一化时当作错误，免得手滑的请求悄悄把上级清掉。
    const wanted = parents === null ? [] : normalizeParents(typeof parents === "string" ? { parentSessionId: parents } : { parentSessionIds: parents });
    const planned = planRelink(hub, id, wanted, this.config.maxDepth);
    if (planned.length === 0) return { changed: false, depthUpdated: [] };
    let revived = false;
    for (const parentId of wanted) {
      // 逐个现查：先取消归档的上级可能已经把后面几个一并带了出来。
      if (!hub.archiveOf(parentId)) continue;
      await reviveSession(hub, parentId, this.deps.log);
      revived = true;
    }
    if (revived) this.assertServing();
    for (let attempt = 0; ; attempt++) {
      const steps = planRelink(hub, id, wanted, this.config.maxDepth);
      const cold = steps.filter((step) => !hub.isHot(step.sessionId));
      if (cold.length === 0) {
        // 同一批写完再通知：订阅者（SSE、wait）不会读到只改了一半的关系。
        hub.batch(() => {
          for (const step of steps) hub.emit(step.sessionId, { kind: "session.relinked", data: { ...step.data, by }, source: sourceOf(by) });
        });
        return { changed: steps.length > 0, depthUpdated: steps.filter((step) => step.data.cause === "ancestor").map((step) => step.sessionId) };
      }
      // 解冻期间会话树又变了好几次：不再追，让调用方重试（正常情况下一轮就够）。
      if (attempt >= 3) throw new EnsembleError("conflict", "The session tree kept changing while it was being loaded. Try again.", { sessionId: id });
      await Promise.all(cold.map((step) => hub.ensureHot(step.sessionId)));
      this.assertServing();
    }
  }

  async send(id: SessionId, input: SendInput): Promise<SendResult> {
    this.assertServing();
    const text = checkedText(input.text, LIMITS.maxMessageChars, "message");
    // 热会话不 await（同步前缀与以前一样）；冷会话先解冻——后面要写它的日志。
    const state = this.deps.hub.state(id) ?? (await this.loadState(id));
    if (state.status === "stopped") throw new EnsembleError("session_closed", "This session was stopped and cannot receive messages.");
    let runtime = this.runtimes.get(id);
    if (input.mode === "steer" && !runtime?.activeRunId) throw new EnsembleError("conflict", "No run is active, so there is nothing to steer. Send it as a follow-up instead.");
    while (runtime?.closed) {
      await runtime.closed;
      this.assertServing();
      if (!this.deps.hub.has(id) || this.deps.hub.state(id)?.status === "stopped") {
        throw new EnsembleError("session_closed", "This session was stopped and cannot receive messages.");
      }
      runtime = this.runtimes.get(id);
    }
    runtime ??= this.resume(state);
    const runId = input.mode !== "follow_up" ? runtime.activeRunId : undefined;
    const kind = runId ? "steer" : "follow_up";
    const message = makeMessage(state.meta, kind, input.author, text, runId);
    const result = this.deps.hub.batch(() => {
      this.recordMessage(state.meta, message);
      return runId ? runtime.steer(message, runId) : runtime.enqueue(message, text);
    });
    // 消息已经记录：对已归档的会话发消息，就是又用到了它——取消归档（连同它的上级链与子树）。
    // 登记在这一刻同步完成，落盘在后台；它从不抛出，所以即使下面的 await 失败也不会留下悬空的拒绝。
    const revived = reviveSession(this.deps.hub, id, this.deps.log);
    const targetRunId = await result;
    await revived;
    return { messageId: message.id, kind, runId: targetRunId, stage: runtime.stage(message.id) };
  }

  async cancel(id: SessionId, by: Actor): Promise<{ interrupted: boolean; cancelledQueued: number }> {
    // 持有运行时的会话一定在内存里（构造函数里的冻结否决保证了这一点）；冷会话没有运行时，也就没有可取消的运行，不必为它解冻。
    if (!this.deps.hub.has(id)) throw new EnsembleError("not_found", "Session " + id + " does not exist.");
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new EnsembleError("conflict", "The session has no active or queued run to cancel.");
    const state = this.requireState(id);
    return this.deps.hub.batch(() => {
      const result = runtime.cancel(by);
      this.deps.notices.syncIntervention(state.meta, "cancel", { by });
      return result;
    });
  }

  async stop(id: SessionId, by: Actor): Promise<void> {
    const { hub, notices } = this.deps;
    if (!hub.has(id)) throw new EnsembleError("not_found", "Session " + id + " does not exist.");
    // 已经停止的冷会话不必为了“确认它已停止”而解冻；其余的要写它的日志，先解冻（热会话不 await）。
    if (!hub.isHot(id) && hub.summary(id)?.status === "stopped") return;
    const state = hub.state(id) ?? (await this.loadState(id));
    const runtime = this.runtimes.get(id);
    if (state.status === "stopped") return runtime?.closed;
    await hub.batch(() => {
      notices.syncIntervention(state.meta, "stop", { by });
      if (runtime && !runtime.closed) return runtime.stop(by);
      hub.emit(id, { kind: "session.status", data: { status: "stopped", reason: "stopped_by_user" }, source: "ensemble" });
      return runtime?.closed;
    });
  }

  /**
   * 回答执行端的一个提问（业务提问，不是授权）。回复先交给执行端，再记结局；执行端已不再等待时如实记为过期并报冲突。
   * 不是 `send`：那是对会话说话（纠偏、补充），这是对一个具体的提问作答，两者的状态与回执都不同。
   */
  async answerQuestion(id: SessionId, questionId: QuestionId, input: AnswerInput, by: Actor): Promise<ResolvedQuestion> {
    this.assertServing();
    return this.questions.answer(id, questionId, input, by);
  }

  /** 不回答：让执行端自行判断（附一句话可选）。 */
  async declineQuestion(id: SessionId, questionId: QuestionId, note: string | undefined, by: Actor): Promise<ResolvedQuestion> {
    this.assertServing();
    const text = note === undefined ? undefined : checkedText(note, LIMITS.question.maxAnswerChars, "note");
    return this.questions.decline(id, questionId, text, by);
  }

  /** 不删除执行端自己保存的原生会话。 */
  async remove(id: SessionId): Promise<void> {
    const { hub } = this.deps;
    const summary = hub.summary(id);
    if (!summary) throw new EnsembleError("not_found", "Session " + id + " does not exist.");
    const { status } = summary;
    if (status === "starting" || status === "queued" || status === "running") {
      throw new EnsembleError("conflict", "Stop the session before removing it.");
    }
    // 冷会话没有运行时可关，也不必为了先记一条“已停止”再解冻、转头就删；这里的 stop 是系统发起的，本来也不通知主 Agent。
    if (hub.isHot(id)) await this.stop(id, { kind: "system", label: "Ensemble" });
    await hub.remove(id);
  }

  /**
   * 重启后对账：把重放出来仍显示“进行中”的会话收尾。只看内存里的会话——冷会话都是稳定、已结束的
   * （没有进行中 / 排队的运行、没有待确认的消息），abandonSession 对它们本来就什么都不做，不必为此读它们的日志。
   */
  reconcileAfterRestart(): number {
    const { hub } = this.deps;
    let touched = 0;
    for (const id of hub.hotIds()) {
      if (!this.runtimes.has(id) && abandonSession(hub, this.requireState(id), "service_restarted")) touched += 1;
    }
    return touched;
  }

  shutdown(): Promise<void> {
    return this.shuttingDown ??= Promise.resolve().then(async () => {
      const { hub } = this.deps;
      // 先撤掉提问的时限：随后各运行时关闭会把待回答的提问记为过期，不该再有计时器去碰已经关闭的连接。
      this.questions.dispose();
      const closing = hub.batch(() => [...this.runtimes.values()].map((runtime) => runtime.shutdown()));
      await Promise.all(closing);
      await hub.flush();
    });
  }

  private recordMessage(meta: SessionMeta, message: Message): void {
    this.deps.hub.emit(meta.id, { kind: "message.sent", data: { message }, source: sourceOf(message.author), at: message.createdAt });
    if (message.sync.toOrigin === "pending") this.deps.notices.syncIntervention(meta, "intervention", { message });
  }

  private resume(state: SessionState): SessionRuntime {
    const executor = this.deps.executors.get(state.meta.harness);
    if (!executor?.canResume || !state.meta.nativeRef) {
      throw new EnsembleError("session_not_resumable", "The connection to this session was lost and the harness session cannot be resumed.");
    }
    return this.attach(state, executor, state.meta.nativeRef);
  }

  private attach(state: SessionState, executor: Executor, resume?: NativeRef): SessionRuntime {
    const { hub, log } = this.deps;
    const id = state.meta.id;
    const runtime = new SessionRuntime({
      hub, log, slots: this.slots, state, executor, resume, cancelConfirmMs: this.config.cancelConfirmMs,
      onClosed: () => { if (this.runtimes.get(id) === runtime) this.runtimes.delete(id); },
    });
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private requireState(id: SessionId): SessionState {
    const state = this.deps.hub.state(id);
    if (!state) throw new EnsembleError("not_found", "Session " + id + " does not exist.");
    return state;
  }

  /**
   * 取会话的完整状态，必要时先解冻（冷会话只有摘要快照，写它的日志之前要把日志读回内存）。
   * 调用方写成 `hub.state(id) ?? (await this.loadState(id))`：会话本来就在内存里时不引入 await。
   * 解冻要等一会儿，期间服务可能开始关闭，所以回来先确认还在服务。
   */
  private async loadState(id: SessionId): Promise<SessionState> {
    const state = await this.deps.hub.ensureHot(id);
    this.assertServing();
    if (!state) throw new EnsembleError("not_found", "Session " + id + " does not exist.");
    return state;
  }

  /**
   * 委派的上级必须都在、层数不能超限，返回新会话的层数；服务正在关闭时同样拒绝。
   * 只读索引信息（冷会话也能读，不必为此解冻），不改任何东西：委派在动归档之前、动完之后各查一遍（见 delegate）。
   * 不存在的上级一次全部说出来；层数取最长的那条上级链：各上级里最深的那个加一（单上级时就是“上级层数 + 1”），并列最深的取排在前面的。
   */
  private admitParents(parentIds: readonly SessionId[]): number {
    this.assertServing();
    const { hub } = this.deps;
    const found = parentIds.map((parentId) => hub.node(parentId));
    const notFound = missingParents(parentIds.filter((_, index) => found[index] === undefined));
    if (notFound) throw notFound;
    const deepest = found.reduce<HubNode | undefined>((best, node) => (node && (!best || node.depth > best.depth) ? node : best), undefined);
    const depth = deepest ? deepest.depth + 1 : 0;
    if (depth > this.config.maxDepth) {
      const several = parentIds.length > 1;
      throw new EnsembleError("depth_exceeded",
        "Delegation depth " + depth + " exceeds the limit of " + this.config.maxDepth
          + (deepest ? " (parent session " + deepest.id + " is at depth " + deepest.depth + (several ? ", the deepest of its " + parentIds.length + " parents: a session's depth follows its longest chain" : "") + ")." : "."),
        { depth, maxDepth: this.config.maxDepth, ...(deepest ? { parentSessionId: several ? parentIds[0] : deepest.id } : {}), ...(several && deepest ? { parentSessionIds: parentIds, deepestParentId: deepest.id } : {}) });
    }
    return depth;
  }

  private assertServing(): void {
    if (this.shuttingDown) throw new EnsembleError("conflict", "Ensemble is shutting down.");
  }
}

function makeMessage(meta: SessionMeta, kind: Message["kind"], author: Actor, text: string, runId?: RunId): Message {
  const createdAt = isoNow();
  return {
    id: newId("msg"), sessionId: meta.id, kind, author, text, createdAt, ...(runId ? { runId } : {}),
    delivery: newDelivery(createdAt),
    sync: { toOrigin: kind !== "task" && author.kind === "user" && meta.origin.kind === "agent" ? "pending" : "not_needed" },
  };
}

/** 日志里的上限：不设上限写成 "unlimited" 而不是 0（0 在日志里读起来像“一个都不许跑”）。 */
function describeLimit(max: number): number | "unlimited" {
  return max === UNLIMITED_RUNS ? "unlimited" : max;
}

function checkedText(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text) throw new EnsembleError("invalid_request", "The " + label + " is empty.");
  if (text.length > max) throw new EnsembleError("invalid_request", "The " + label + " exceeds " + max + " characters.");
  return text;
}

/** 模型或推理档位不在用户开放的范围里：说明哪个被拒、能选哪些，以及这是用户在配置页里定的，主 Agent 不必反复重试。 */
function modelNotAllowed(
  harness: HarnessId,
  requested: string | undefined,
  requestedEffort: string | undefined,
  decision: Extract<ModelDecision, { ok: false }>,
): EnsembleError {
  if (decision.reason === "effort_not_allowed") {
    const { model, allowed } = decision;
    const message = allowed.length === 0
      ? "No reasoning effort is allowed for model \"" + model + "\" on harness \"" + harness + "\". The user has to allow at least one in Ensemble's executor settings before it can be used."
      : "Effort \"" + requestedEffort + "\" is not allowed for model \"" + model + "\" on harness \"" + harness + "\". Allowed: " + allowed.join(", ") + ". The user chooses these in Ensemble's executor settings.";
    return new EnsembleError("effort_not_allowed", message, { harness, model, ...(requestedEffort ? { requested: requestedEffort } : {}), allowed });
  }
  if (decision.reason === "settings_unavailable") {
    const message = decision.issue === "unreadable_file"
      ? "Ensemble could not read settings.json. Restore a valid settings file and restart Ensemble before delegating."
      : `Model settings for harness "${harness}" are invalid. Save a new selection in Ensemble's executor settings before delegating.`;
    return new EnsembleError("model_settings_unavailable", message, { harness, issue: decision.issue });
  }
  const where = "in Ensemble's executor settings";
  if (decision.reason === "model_unverified") {
    const known = decision.allowed.length > 0 ? " Known models: " + decision.allowed.join(", ") + "." : " No model is known for it right now.";
    const message = requested === undefined
      ? "Harness \"" + harness + "\" has reasoning efforts restricted by the user, but Ensemble cannot tell which model it would use by default, so the model has to be named explicitly." + known
      : "Model \"" + requested + "\" is not a model harness \"" + harness + "\" reports, and the user has restricted reasoning efforts there, so Ensemble cannot tell whether the name stands for a restricted model." + known;
    return new EnsembleError("model_not_allowed", message, { harness, ...(requested !== undefined ? { requested } : {}), allowed: decision.allowed, reason: "model_unverified" });
  }
  if (decision.reason === "none_allowed") {
    return new EnsembleError("model_not_allowed",
      "No model is allowed for harness \"" + harness + "\". The user has to allow at least one " + where + " before it can be used.",
      { harness, allowed: [] });
  }
  return new EnsembleError("model_not_allowed",
    "Model \"" + requested + "\" is not allowed for harness \"" + harness + "\". Allowed: " + decision.allowed.join(", ") + ". The user chooses these " + where + ".",
    { harness, requested, allowed: decision.allowed });
}

/** 委派入口用：工作目录必须是存在的绝对目录路径，返回规范化后的路径。 */
async function resolveWorkingDirectory(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new EnsembleError("invalid_request", "The working directory must be an absolute path, got \"" + cwd + "\".");
  const info = await stat(cwd).catch(() => {
    throw new EnsembleError("invalid_request", "The working directory does not exist: " + cwd);
  });
  if (!info.isDirectory()) throw new EnsembleError("invalid_request", "The working directory is not a directory: " + cwd);
  return resolve(cwd);
}
