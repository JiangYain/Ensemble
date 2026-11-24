import { newId } from "@shared/ids";
import { capPrompts, SYSTEM_ACTOR, type QuestionExpiry, type QuestionId, type QuestionPrompt } from "@shared/questions";
import type { RunId } from "@shared/types";
import type { CodexRpc, RpcId } from "./codex-rpc";
import { arr, asRecord, str, type Json } from "./common";
import { redact } from "./redact";
import type { ExecutorDraft } from "./types";

/**
 * Codex 的业务提问（`item/tool/requestUserInput`，实验性的 request_user_input 工具）：
 * 子会话遇到需求歧义，停下来问一个问题，等一个回答。这不是授权——授权请求（`…/requestApproval`）
 * 仍由 codex-side-channel.ts 当场应答，从不进入这里，也从不等人。
 *
 * 做法：把请求原样保留（JSON-RPC id 不变），向发起方发一个 `question.asked`，等 `answerQuestion` / `declineQuestion`
 * 再用同一个 id 回复 Codex。Codex 那边结清了这个请求（回合被中断、在别处被回答）、运行结束时，提问收尾为过期，
 * 不再回复（Codex 已经不等了，对一个已结清的 id 再回复只会产生噪音）。
 *
 * 来源与核实状态（如实写在这里，免得被当成已验证）：
 * - 请求的形状取自 `vendor/mosoo-agent-driver` 里随 Codex 生成的 ServerRequest.json（ToolRequestUserInputParams）；
 * - 回复的形状 `{ answers: { [问题 id]: { answers: string[] } } }` 是从 Codex 二进制里的结构名（ToolRequestUserInputAnswer）推断的，
 *   自由文字按普通字符串给（Codex 自己的 TUI 会给备注加 `user_note: ` 前缀，这里没有照做）；
 * - 以上都只用假 Codex（test/fixtures/fake-codex.mjs）验证过，从未在真实的 Codex 上触发过提问，也不知道真实 Codex 在 isBlocking=false 时怎样处理请求。
 */

/** 给 Codex 的 JSON-RPC 错误码：与原来“无法中继”时用的一致。 */
const REFUSED = -32000;

const SECRET_MESSAGE =
  "This question asks for a secret value (a password, token or key). Ensemble does not relay secrets between a person and a delegated session. Do not ask for it: use a way that does not need it, or make a reasonable assumption, state it in your answer, and continue.";

export interface CodexQuestionsDeps {
  /** 取当前的 RPC；会话启动之前它还不存在，所以用函数。 */
  rpc(): Pick<CodexRpc, "respond" | "respondError">;
  emit(draft: ExecutorDraft, runId: RunId): void;
  diagnostic(level: "info" | "warn" | "error", code: string, message: string): void;
  activeRunId(): RunId | undefined;
  /** 当前运行是否是被我们取消的：Codex 因此结清的请求，原因记为取消，而不是执行端自己撤回。 */
  cancelRequested(): boolean;
}

interface Pending {
  rpcId: RpcId;
  runId: RunId;
  prompts: QuestionPrompt[];
}

interface Asked {
  id: string;
  header: string | undefined;
  question: string;
  isOther: boolean;
  options: { label: string; description?: string }[];
}

function readQuestions(params: Json): Asked[] {
  const result: Asked[] = [];
  for (const raw of arr(params["questions"]) ?? []) {
    const record = asRecord(raw);
    const id = str(record?.["id"]);
    const question = str(record?.["question"]);
    if (!record || !id || !question) continue;
    const options = (arr(record["options"]) ?? []).flatMap((entry): { label: string; description?: string }[] => {
      const option = asRecord(entry);
      const label = str(option?.["label"]);
      if (!label) return [];
      const description = str(option?.["description"]);
      return [{ label, ...(description ? { description } : {}) }];
    });
    result.push({ id, header: str(record["header"]), question, isOther: record["isOther"] === true, options });
  }
  return result;
}

/**
 * 这一条原始条目标着 `isSecret` 吗。严格 `=== true`（协议里它是布尔值；字符串 "true"、数字 1 都不算），不是对象的条目一律不算。
 * “什么算机密条目”只写这一份：本文件用它判断整个请求（`asksForSecret`），codex-side-channel.ts 里的 `describeUnrelayed` 数机密条目时也用它。
 * 各写一份就得靠人记着同步，漏改一处，机密类提问的文字就可能被写进诊断。
 */
export const isSecretEntry = (raw: unknown): boolean => asRecord(raw)?.["isSecret"] === true;

/**
 * 请求里有没有标着机密的条目。看的是原始条目，不是 `readQuestions` 留下的那些：它只认带非空字符串 `id` 与问题正文的条目，
 * 缺的整条丢掉，而丢掉的照样可能是机密类提问。
 */
const asksForSecret = (params: Json): boolean => (arr(params["questions"]) ?? []).some(isSecretEntry);

const toPrompt = (asked: Asked): QuestionPrompt => ({
  key: asked.id,
  ...(asked.header ? { header: asked.header } : {}),
  text: asked.question,
  ...(asked.options.length > 0 ? { options: asked.options } : {}),
  // Codex 的 request_user_input 没有多选；isOther 表示除了选项之外还可以自己写。
  multiple: false,
  custom: asked.isOther || asked.options.length === 0,
});

/** 展示用的文字可以被截断、脱敏，但回答时要交回的标签必须与 Codex 给的一字不差。 */
function labelsPreserved(asked: readonly Asked[], prompts: readonly QuestionPrompt[]): boolean {
  return asked.every((question, index) => {
    const shown = prompts[index]?.options?.map((option) => option.label) ?? [];
    return shown.length === question.options.length && shown.every((label, at) => label === question.options[at]?.label);
  });
}

export class CodexQuestions {
  private readonly pending = new Map<QuestionId, Pending>();
  /** JSON-RPC 请求 id → 提问编号：`serverRequest/resolved` 只带请求 id。 */
  private readonly byRequest = new Map<string, QuestionId>();

  constructor(private readonly deps: CodexQuestionsDeps) {}

  get size(): number {
    return this.pending.size;
  }

  /**
   * 接手一个 `item/tool/requestUserInput` 请求。返回 true = 这里已经负责回应它（转给了发起方，或按原因当场拒绝）；
   * false = 没有接手，调用方按原来的办法回应（告诉 Codex 无法中继）。
   */
  relay(rpcId: RpcId, params: Json): boolean {
    // 密钥不经过 Ensemble：值一旦写进事件日志或页面就收不回来。最克制的做法是不转交，如实告诉 Codex 走不通，并在时间线上留一条说明。
    // 这一步排在所有判断之前，而且只看原始条目：
    // - 先于“有没有运行、有没有人在等”：那两种情况会退回调用方的老办法，而老办法的诊断（codex.question_unanswered）
    //   会把问题原文写进日志。机密类提问不论以什么形式到来，文字都不能落进任何一条诊断。
    // - 先于 `readQuestions`：它丢掉读不出的条目（缺 `id` 或问题正文）之后，请求里若还有别的条目，就会照常转交，
    //   而那条机密条目悄悄消失——没有诊断，Codex 也不知道这条路走不通。所以只要有一条原始条目标了机密，整个请求都按机密类处理，
    //   不论其余条目读不读得出；全是读不出的条目时也一样，诊断码仍是 codex.question_secret，而不是退回老办法。
    if (asksForSecret(params)) {
      this.deps.rpc().respondError(rpcId, REFUSED, SECRET_MESSAGE);
      // 诊断不引用任何出自模型的文字——标题与问题都不引用：它们都是模型写的，可能就是要问的那个机密，也可能带着主机名、
      // 口令描述一类 `redact` 认不出的内容（它只认得出少数密钥形状）。这里只陈述事实：这是机密类提问，没有转交。
      this.deps.diagnostic(
        "warn",
        "codex.question_secret",
        "Codex asked for a secret value. Ensemble does not relay secrets, so the question was declined and the session was told to proceed without it.",
      );
      return true;
    }

    const asked = readQuestions(params);
    if (asked.length === 0) return false;

    const runId = this.deps.activeRunId();
    // 回合之外没有可以挂提问的运行；isBlocking=false 表示没有谁在等这个回答（真实 Codex 此时怎样处理请求没有核实过）：都按原来的办法。
    if (!runId || params["isBlocking"] === false) return false;

    const { prompts, dropped } = capPrompts(asked.map(toPrompt), redact);
    if (dropped > 0 || prompts.length !== asked.length || !labelsPreserved(asked, prompts)) return false;

    const questionId = newId("qst");
    this.pending.set(questionId, { rpcId, runId, prompts });
    this.byRequest.set(String(rpcId), questionId);
    this.deps.emit({ kind: "question.asked", data: { question: { id: questionId, prompts } } }, runId);
    return true;
  }

  /** 回答：`answers` 与提问里的问题一一对应。返回回复是否已写给 Codex；这个请求已经结清（或从未存在）时返回 false。 */
  answerQuestion(questionId: QuestionId, answers: readonly (readonly string[])[]): Promise<boolean> {
    const entry = this.take(questionId);
    if (!entry) return Promise.resolve(false);
    const body: Record<string, { answers: string[] }> = {};
    entry.prompts.forEach((prompt, index) => {
      body[prompt.key] = { answers: [...(answers[index] ?? [])] };
    });
    return Promise.resolve(this.deps.rpc().respond(entry.rpcId, { answers: body }));
  }

  /** 不回答：以 JSON-RPC 错误回应，而不是回答“空”——模型会知道这条路走不通，转而做合理假设继续，而不是误以为用户没有意见。 */
  declineQuestion(questionId: QuestionId, note: string): Promise<boolean> {
    const entry = this.take(questionId);
    if (!entry) return Promise.resolve(false);
    return Promise.resolve(this.deps.rpc().respondError(entry.rpcId, REFUSED, note));
  }

  /** `serverRequest/resolved`：Codex 说这个请求已经结清（回合被中断、在别处被回答）。我们自己回复过的已经不在这里了，不会重复收尾。 */
  resolved(params: Json): void {
    const requestId = params["requestId"];
    if (typeof requestId !== "number" && typeof requestId !== "string") return;
    const questionId = this.byRequest.get(String(requestId));
    const entry = questionId ? this.take(questionId) : undefined;
    if (!questionId || !entry) return;
    this.expire(questionId, entry, this.deps.cancelRequested() ? "cancelled" : "withdrawn");
  }

  /** 一次运行结束：它名下仍在等的提问不会再有回答了。不回复 Codex（回合已经结束，它不再等）。 */
  runEnded(runId: RunId, cancelled: boolean): void {
    for (const [questionId, entry] of [...this.pending]) {
      if (entry.runId !== runId) continue;
      this.take(questionId);
      this.expire(questionId, entry, cancelled ? "cancelled" : "run_ended");
    }
  }

  /** 会话关闭：进程随之被结束，不再有任何回复可发；提问的收尾由运行时统一记录。 */
  clear(): void {
    this.pending.clear();
    this.byRequest.clear();
  }

  private take(questionId: QuestionId): Pending | undefined {
    const entry = this.pending.get(questionId);
    if (!entry) return undefined;
    this.pending.delete(questionId);
    this.byRequest.delete(String(entry.rpcId));
    return entry;
  }

  private expire(questionId: QuestionId, entry: Pending, reason: QuestionExpiry): void {
    this.deps.emit({ kind: "question.resolved", data: { questionId, outcome: "expired", by: SYSTEM_ACTOR, reason } }, entry.runId);
  }
}
