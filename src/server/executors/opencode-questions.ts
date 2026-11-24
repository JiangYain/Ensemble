import { newId } from "@shared/ids";
import { capPrompts, SYSTEM_ACTOR, type QuestionExpiry, type QuestionId, type QuestionPrompt } from "@shared/questions";
import type { RunId } from "@shared/types";
import { arr, asRecord, oneLine, str, type Json } from "./common";
import { OpenCodeHttpError } from "./opencode-api";
import { redact } from "./redact";
import { ReplyRejected, type ExecutorDraft } from "./types";

/**
 * OpenCode 的业务提问（`question` 工具）：子会话遇到需求歧义，停下来问一个问题，等一个回答。
 * 这不是权限——权限请求（`permission.asked`）仍由 opencode-events.ts 当场应答，从不进入这里，也从不等人。
 *
 * OpenCode 2.3.0 的 V2 接口把提问做成“表单”（Form 服务）：
 * - `form.created`：`form.metadata.kind === "question"`，每个问题一个字段（`key` 形如 `q0`，`title` 是简短标题，`description` 是问题正文，
 *   `type` 是 `string`（单选或自由文字）或 `multiselect`，`options[{ value, label, description? }]`，`custom` 表示允许自己写）；
 * - 回答：`POST /api/session/:sid/form/:fid/reply`，body `{ answer: { q0: "标签或文字", q1: ["标签", …] } }`，204 成功，
 *   400 回答不合格（表单仍在等），404 / 409 表单已不存在或已被处理；
 * - 不回答：`DELETE /api/session/:sid/form/:fid?message=<说明>`，204；带 message 时这次工具调用以错误结束、运行继续，
 *   不带 message 则整次运行被中止——所以不回答一律带说明；
 * - 结局事件：`form.replied { id, sessionID, answer }`、`form.cancelled { id, sessionID }`。
 *
 * 以上取自 `@opencode/cli` 2.3.0 随包的源码，字段与状态码是读源码得来的；用假 OpenCode（test/fixtures/fake-opencode.mjs）验证过转交的流程，
 * 但从未在真实的 OpenCode 里触发过提问——真实的字段取值（尤其 `custom` 的缺省）、reply 的 400 条件都没有核实。
 */

const UNRELAYABLE_MESSAGE =
  "Ensemble could not relay this question to a person. Make a reasonable assumption, state it in your answer, and continue.";

export interface OpenCodeQuestionsDeps {
  sessionId(): string;
  request(method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown>;
  emit(draft: ExecutorDraft, runId: RunId): void;
  diagnostic(level: "info" | "warn" | "error", code: string, message: string): void;
  activeRunId(): RunId | undefined;
  /** 当前运行是否是被我们取消的：OpenCode 因此撤掉的表单，原因记为取消，而不是执行端自己撤回。 */
  cancelRequested(): boolean;
  debug(message: string, detail?: Record<string, unknown>): void;
}

interface Field {
  key: string;
  /** 与展示用的可选项一一对应的、回答时要交回 OpenCode 的值。 */
  values: string[];
}

interface Pending {
  formId: string;
  runId: RunId;
  prompts: QuestionPrompt[];
  fields: Field[];
  /** 正在把回复交给 OpenCode：期间到的 `form.replied` 是我们自己回复的回声，不当作“被撤回”。 */
  busy: boolean;
}

interface ReadForm {
  prompts: QuestionPrompt[];
  fields: Field[];
}

/** 读不懂（没有字段、字段类型不认识、没有问题正文）就返回 undefined：不转交。 */
function readForm(form: Json): ReadForm | undefined {
  const raws = arr(form["fields"]) ?? [];
  if (raws.length === 0) return undefined;
  const prompts: QuestionPrompt[] = [];
  const fields: Field[] = [];
  for (const raw of raws) {
    const field = asRecord(raw);
    const key = str(field?.["key"]);
    const type = str(field?.["type"]);
    if (!field || !key || (type !== "string" && type !== "multiselect")) return undefined;
    const title = str(field["title"]);
    const description = str(field["description"]);
    const text = description ?? title;
    if (!text) return undefined;
    const options: { label: string; description?: string }[] = [];
    const values: string[] = [];
    for (const entry of arr(field["options"]) ?? []) {
      const option = asRecord(entry);
      const label = str(option?.["label"]) ?? str(option?.["value"]);
      const value = str(option?.["value"]) ?? label;
      if (!label || value === undefined) continue;
      const detail = str(option?.["description"]);
      options.push({ label, ...(detail ? { description: detail } : {}) });
      values.push(value);
    }
    prompts.push({
      key,
      // 有正文时标题就是简短的 header；只有标题时它自己就是问题。
      ...(description && title ? { header: title } : {}),
      text,
      ...(options.length > 0 ? { options } : {}),
      multiple: type === "multiselect",
      // OpenCode 的 question 工具缺省允许自己写；没有可选项时只能自己写。
      custom: options.length === 0 || field["custom"] !== false,
    });
    fields.push({ key, values });
  }
  return { prompts, fields };
}

/**
 * 表单标题在诊断里的写法：先脱敏，再压成一行并截到 120 字；没有标题就叫 “a question”。
 * 标题是执行端写的，可能带着密钥形状的内容。次序不能反：先截断会把密钥切在半截，`redact` 就认不出来了。
 * 撤回转不了的提问（下面的 `withdraw`）与 opencode-events.ts 里取消不是提问的表单，这两处诊断必须共用这一处，免得一边脱敏、一边漏掉。
 */
export function formTitle(form: Json): string {
  return oneLine(redact(str(form["title"]) ?? "a question"), 120);
}

export class OpenCodeQuestions {
  private readonly pending = new Map<QuestionId, Pending>();

  constructor(private readonly deps: OpenCodeQuestionsDeps) {}

  get size(): number {
    return this.pending.size;
  }

  /**
   * 处理 `form.created`。返回 true = 它是业务提问，已经处理（转给了发起方，或带说明地撤回）；
   * false = 不是提问，调用方按原来的办法处理（撤回表单并中止运行）。
   */
  created(form: Json): boolean {
    if (str(asRecord(form["metadata"])?.["kind"]) !== "question") return false;
    const formId = str(form["id"]);
    if (!formId) return false;
    const runId = this.deps.activeRunId();
    const read = runId ? readForm(form) : undefined;
    const { prompts, dropped } = read ? capPrompts(read.prompts, redact) : { prompts: [], dropped: 0 };
    // 展示用的文字可以被截断、脱敏；但回答时按位置把标签换回 OpenCode 的原值，所以问题与可选项一个都不能少。
    const intact = read !== undefined && dropped === 0 && prompts.length === read.prompts.length &&
      prompts.every((prompt, index) => (prompt.options?.length ?? 0) === (read.prompts[index]?.options?.length ?? 0));
    if (!runId || !read || !intact) {
      this.withdraw(formId, formTitle(form));
      return true;
    }
    const questionId = newId("qst");
    this.pending.set(questionId, { formId, runId, prompts, fields: read.fields, busy: false });
    this.deps.emit({ kind: "question.asked", data: { question: { id: questionId, prompts } } }, runId);
    return true;
  }

  /** `form.replied` / `form.cancelled`：表单已经有了结局。我们自己回复的有 `busy` 护着；其余的是 OpenCode 那边结清了它。 */
  settled(formId: string | undefined): void {
    if (!formId) return;
    for (const [questionId, entry] of this.pending) {
      if (entry.formId !== formId || entry.busy) continue;
      this.pending.delete(questionId);
      this.expire(questionId, entry, this.deps.cancelRequested() ? "cancelled" : "withdrawn");
      return;
    }
  }

  /** 回答：`answers` 与提问里的问题一一对应。返回回复是否已被 OpenCode 接受；表单已不存在时返回 false；回答不合格抛 ReplyRejected（表单仍在等）。 */
  async answerQuestion(questionId: QuestionId, answers: readonly (readonly string[])[]): Promise<boolean> {
    const entry = this.pending.get(questionId);
    if (!entry || entry.busy) return false;
    const answer: Record<string, string | string[]> = {};
    entry.prompts.forEach((prompt, index) => {
      const field = entry.fields[index];
      const picks = (answers[index] ?? []).map((pick) => {
        const at = prompt.options?.findIndex((option) => option.label === pick) ?? -1;
        return at >= 0 ? (field?.values[at] ?? pick) : pick;
      });
      answer[prompt.key] = prompt.multiple ? picks : (picks[0] ?? "");
    });
    return this.send(questionId, entry, () => this.deps.request("POST", `/api/session/${this.deps.sessionId()}/form/${entry.formId}/reply`, { answer }));
  }

  /** 不回答：撤回表单并带一句说明（运行继续，模型会知道没人回答）。返回值同 answerQuestion。 */
  declineQuestion(questionId: QuestionId, note: string): Promise<boolean> {
    const entry = this.pending.get(questionId);
    if (!entry || entry.busy) return Promise.resolve(false);
    return this.send(questionId, entry, () =>
      this.deps.request("DELETE", `/api/session/${this.deps.sessionId()}/form/${entry.formId}?message=${encodeURIComponent(note)}`),
    );
  }

  /** 一次运行结束：它名下仍在等的提问不会再有回答了。 */
  runEnded(runId: RunId, cancelled: boolean): void {
    for (const [questionId, entry] of [...this.pending]) {
      if (entry.runId !== runId) continue;
      this.pending.delete(questionId);
      this.expire(questionId, entry, cancelled ? "cancelled" : "run_ended");
    }
  }

  /** 会话关闭：私有服务随之退出，不再有任何回复可发；提问的收尾由运行时统一记录。 */
  clear(): void {
    this.pending.clear();
  }

  private async send(questionId: QuestionId, entry: Pending, call: () => Promise<unknown>): Promise<boolean> {
    entry.busy = true;
    try {
      await call();
      this.pending.delete(questionId);
      return true;
    } catch (error) {
      if (error instanceof OpenCodeHttpError && error.status === 400) {
        // 表单还在等：回答本身不合 OpenCode 的要求，调用方可以改了重答。
        throw new ReplyRejected(oneLine(error.message, 300));
      }
      this.pending.delete(questionId);
      // 404 / 409：表单已经没有了或已被处理——预期内的“已不再等待”。其余（网络、超时）也没有送达，交给调用方如实记录。
      if (error instanceof OpenCodeHttpError && (error.status === 404 || error.status === 409)) return false;
      throw error;
    } finally {
      entry.busy = false;
    }
  }

  /** 转不了的提问：撤回表单并带说明，运行继续（以前是不带说明地撤回，整次运行被中止）。 */
  private withdraw(formId: string, title: string): void {
    this.deps.diagnostic("warn", "opencode.question_unanswered", `OpenCode asked a question ("${title}") that Ensemble could not relay, so it was withdrawn and the session was told to proceed with its own assumption.`);
    this.deps
      .request("DELETE", `/api/session/${this.deps.sessionId()}/form/${formId}?message=${encodeURIComponent(UNRELAYABLE_MESSAGE)}`)
      .catch((error: unknown) => this.deps.debug("opencode: form withdraw failed", { formId, error: String(error) }));
  }

  private expire(questionId: QuestionId, entry: Pending, reason: QuestionExpiry): void {
    this.deps.emit({ kind: "question.resolved", data: { questionId, outcome: "expired", by: SYSTEM_ACTOR, reason } }, entry.runId);
  }
}
