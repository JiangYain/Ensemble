import { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LIMITS } from "@shared/constants";
import type { QuestionId, QuestionOutcomeRecord, QuestionPrompt, QuestionStatus } from "@shared/questions";
import type { QuestionItem, SessionId } from "@shared/types";
import { api, ApiError } from "../lib/api";
import { errorText, patchSummary } from "../lib/app";
import type { TFunction } from "../lib/i18n";
import {
  actorName,
  answerBody,
  answersReady,
  conflictKey,
  emptyDrafts,
  expiryText,
  pickOption,
  pickOther,
  typeOther,
  type PromptDraft,
} from "../lib/question";
import { timeOfDay } from "../lib/text";
import { useT } from "../lib/useT";
import { Clamp } from "./bits";
import { Icon } from "./Icons";
import { Spinner } from "./ui";

/**
 * 执行端的一次提问（不是授权）：问题原文、可选项与回答入口，放在它被问出来的位置，回答之后原位变成只读的记录。
 *
 * 版式：直角、发丝线、方块——选项前的标记是方框（单选里面一个实心小方块，多选里面一个对勾），状态用方块的形状区分
 * （空心 = 待回答，实心 = 已回答，带一道横线的空心 = 不回答，淡的空心 = 已过期），不靠色相。
 *
 * 诚实：问题与可选项逐字来自执行端（服务端已按上限整理并脱敏）；回答之后写明谁、何时，以及回复是否真的交到了执行端
 * （“已交给执行端”不等于它读到了、采纳了）；执行端已经不再等待时回复没有送达，如实说，不装作成功。
 *
 * 不跳动：按钮的尺寸、状态行的高度在发送中、出错时都不变；错误只占状态行，不挪动按钮。
 */

/** 填到一半的回答：切到别的会话再回来、或卡片因重绘重新挂载，都不丢。有了结局就清掉。 */
const saved = new Map<QuestionId, PromptDraft[]>();

type Settled = { status: Exclude<QuestionStatus, "open">; outcome: QuestionOutcomeRecord };
type Edit = (draft: PromptDraft) => PromptDraft;

/** 回答或不回答没有成功的原因：409 说清提问此刻的状态（别处已回答 / 已过期……），其余走通用的错误文案。 */
function failureText(cause: unknown, t: TFunction): string {
  if (cause instanceof ApiError && cause.status === 409) {
    const key = conflictKey(cause.details);
    if (key) return t(key);
  }
  return errorText(cause);
}

// ───────────────────────── 共用的小部件 ─────────────────────────

/** 一个问题的抬头：多个问题时标序号，执行端给了标题就带上。只有一个无标题的问题时不画。 */
function PromptHead({ prompt, index, total }: { prompt: QuestionPrompt; index: number; total: number }): ReactNode {
  const t = useT();
  if (total <= 1 && !prompt.header) return null;
  return (
    <div className="q-prompt-head">
      {total > 1 ? <span className="q-index num">{t("question.index", { i: index + 1, n: total })}</span> : null}
      {prompt.header ? <span className="q-header">{prompt.header}</span> : null}
    </div>
  );
}

/** 选项前的方框；选中与否由外层 `.q-opt[data-checked]` 决定。对勾始终在，只是未选中时不显示，选中不会让内容挪动。 */
function Mark({ multiple }: { multiple: boolean }): ReactNode {
  return (
    <span className="q-mark" data-kind={multiple ? "box" : "radio"} aria-hidden="true">
      {multiple ? <Icon name="check" size={10} strokeWidth={3} /> : null}
    </span>
  );
}

// ───────────────────────── 待回答 ─────────────────────────

interface FieldProps {
  prompt: QuestionPrompt;
  index: number;
  total: number;
  draft: PromptDraft;
  base: string;
  disabled: boolean;
  onEdit: (edit: Edit) => void;
  onSubmit: () => void;
}

/** 一个问题的作答区：可选项（单选 / 多选，可再加一格“其他”）或一个自由文本框。 */
function Field({ prompt, index, total, draft, base, disabled, onEdit, onSubmit }: FieldProps): ReactNode {
  const t = useT();
  const textId = `${base}-t${index}`;
  const name = `${base}-g${index}`;
  const options = prompt.options ?? [];

  // 单行输入里 Enter 就是提交；多行文本框里 Enter 换行，Ctrl / ⌘ + Enter 才提交。组字期间的 Enter 是选词，不处理。
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, multiline: boolean): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    if (multiline && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    onSubmit();
  };

  return (
    <div className="q-prompt">
      <PromptHead prompt={prompt} index={index} total={total} />
      <p className="q-text" id={textId}>
        {prompt.text}
      </p>
      {options.length > 0 ? (
        <>
          <p className="q-hint">{prompt.multiple ? t("question.pickAny") : t("question.pickOne")}</p>
          <div className="q-options" role={prompt.multiple ? "group" : "radiogroup"} aria-labelledby={textId}>
            {options.map((option, position) => {
              const checked = draft.picks.includes(option.label);
              return (
                <label key={`${position}:${option.label}`} className="q-opt" data-checked={checked ? "" : undefined}>
                  <input
                    type={prompt.multiple ? "checkbox" : "radio"}
                    name={name}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onEdit((current) => pickOption(prompt, current, option.label))}
                  />
                  <Mark multiple={prompt.multiple} />
                  <span className="q-opt-body">
                    <span className="q-opt-label">{option.label}</span>
                    {option.description ? <span className="q-opt-desc">{option.description}</span> : null}
                  </span>
                </label>
              );
            })}
            {prompt.custom ? (
              <div className="q-opt q-opt--other" data-checked={draft.otherOn ? "" : undefined}>
                <label className="q-other-pick">
                  <input
                    type={prompt.multiple ? "checkbox" : "radio"}
                    name={name}
                    checked={draft.otherOn}
                    disabled={disabled}
                    onChange={() => onEdit((current) => pickOther(prompt, current))}
                  />
                  <Mark multiple={prompt.multiple} />
                  <span className="q-opt-label">{t("question.other")}</span>
                </label>
                {/* 点进输入框（指针）才算选中“其他”；只是用 Tab 路过不改变已选的内容。写字本身也会选中它（typeOther）。 */}
                <input
                  type="text"
                  className="q-input"
                  value={draft.other}
                  maxLength={LIMITS.question.maxAnswerChars}
                  placeholder={t("question.otherPlaceholder")}
                  aria-label={t("question.other")}
                  disabled={disabled}
                  onClick={() => {
                    if (!draft.otherOn) onEdit((current) => pickOther(prompt, current));
                  }}
                  onChange={(event) => onEdit((current) => typeOther(prompt, current, event.target.value))}
                  onKeyDown={(event) => onKeyDown(event, false)}
                />
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <textarea
          className="q-input q-input--area"
          rows={3}
          value={draft.other}
          maxLength={LIMITS.question.maxAnswerChars}
          placeholder={t("question.textPlaceholder")}
          aria-labelledby={textId}
          disabled={disabled}
          onChange={(event) => onEdit((current) => typeOther(prompt, current, event.target.value))}
          onKeyDown={(event) => onKeyDown(event, true)}
        />
      )}
    </div>
  );
}

function OpenBody({ item, sessionId, onSettled }: { item: QuestionItem; sessionId: SessionId; onSettled: (settled: Settled) => void }): ReactNode {
  const t = useT();
  const base = useId();
  const { prompts, questionId } = item;
  const [drafts, setDrafts] = useState<PromptDraft[]>(() => saved.get(questionId) ?? emptyDrafts(prompts));
  const [busy, setBusy] = useState<"answer" | "decline" | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // 请求在途时回答也可能由事件先一步送到、本组件已被换掉：之后的状态写入一律跳过。
  const alive = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    saved.set(questionId, drafts);
  }, [questionId, drafts]);

  const ready = answersReady(prompts, drafts);

  const edit = useCallback(
    (index: number, change: Edit): void => {
      setDrafts((current) => current.map((draft, position) => (position === index ? change(draft) : draft)));
      setError(undefined);
    },
    [],
  );

  const submit = useCallback(
    async (kind: "answer" | "decline"): Promise<void> => {
      if (inFlight.current) return;
      if (kind === "answer" && !ready) return;
      inFlight.current = true;
      setBusy(kind);
      setError(undefined);
      try {
        const response = kind === "answer" ? await api.answerQuestion(sessionId, questionId, answerBody(prompts, drafts)) : await api.declineQuestion(sessionId, questionId);
        // 摘要里的待回答数、值得留意的提问项随这个回执立刻更新；时间线上的结局由事件推来，卡片先按回执原位变成只读。
        patchSummary(response.summary);
        onSettled({ status: response.status, outcome: response.outcome });
      } catch (cause) {
        if (alive.current) setError(failureText(cause, t));
      } finally {
        inFlight.current = false;
        if (alive.current) setBusy(undefined);
      }
    },
    [drafts, onSettled, prompts, questionId, ready, sessionId, t],
  );

  const working = busy !== undefined;
  return (
    <>
      <div className="q-body">
        {prompts.map((prompt, index) => {
          const draft = drafts[index];
          if (!draft) return null;
          return (
            <Field
              key={prompt.key}
              prompt={prompt}
              index={index}
              total={prompts.length}
              draft={draft}
              base={base}
              disabled={working}
              onEdit={(change) => edit(index, change)}
              onSubmit={() => void submit("answer")}
            />
          );
        })}
      </div>
      <div className="q-foot">
        <button
          type="button"
          className="btn btn--primary q-answer-btn"
          disabled={!ready || working}
          aria-busy={busy === "answer" || undefined}
          data-tip={!ready && !working ? t("question.needAnswer") : undefined}
          onClick={() => void submit("answer")}
        >
          {busy === "answer" ? <Spinner size={14} /> : <Icon name="arrowUp" size={14} strokeWidth={2.2} />}
          {t("question.answer")}
        </button>
        <button type="button" className="btn q-decline-btn" disabled={working} aria-busy={busy === "decline" || undefined} data-tip={t("question.declineTip")} onClick={() => void submit("decline")}>
          {t("question.decline")}
        </button>
        {/* 状态行永远占一行的高度：发送中、出错都只改里面的字，不挪动上面的按钮。 */}
        <div className="q-status" aria-live="polite">
          {error ? (
            <span className="q-error" role="alert">
              <Icon name="alert" size={12} strokeWidth={2} />
              <span>{error}</span>
            </span>
          ) : busy ? (
            <span className="q-sending">
              <Spinner size={12} />
              <span>{t("question.sending")}</span>
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ───────────────────────── 有了结局 ─────────────────────────

/** 结局的结果句：回复交到了哪一步，或者为什么没有回复。 */
function resultOf(item: QuestionItem, t: TFunction): { text: string; tip?: string } | undefined {
  const { outcome } = item;
  if (!outcome) return undefined;
  switch (item.status) {
    case "answered":
      return outcome.delivery === "handed_off" ? { text: t("question.delivery.handedOff"), tip: t("question.delivery.handedOffTip") } : undefined;
    case "declined":
      return outcome.delivery === "handed_off" ? { text: t("question.delivery.declinedHandedOff") } : undefined;
    case "expired": {
      const text = expiryText(outcome, t);
      return text ? { text } : undefined;
    }
    default:
      return undefined;
  }
}

function ResolvedBody({ item }: { item: QuestionItem }): ReactNode {
  const t = useT();
  const { outcome, prompts, status } = item;
  const result = resultOf(item, t);
  const by = status === "answered" || status === "declined" ? outcome?.by : undefined;
  return (
    <>
      <div className="q-body">
        {prompts.map((prompt, index) => {
          const picks = status === "answered" ? (outcome?.answers?.[index] ?? []) : [];
          return (
            <div className="q-prompt" key={prompt.key}>
              <PromptHead prompt={prompt} index={index} total={prompts.length} />
              {/* 已有结局的提问只是历史：长问题收成三行，需要时展开。 */}
              <div className="q-text">
                <Clamp lines={3} expandLabel={t("common.expand")} collapseLabel={t("common.collapse")} watch={prompt.text}>
                  {prompt.text}
                </Clamp>
              </div>
              {picks.length > 0 ? (
                <ul className="q-picks" aria-label={t("question.answer")}>
                  {picks.map((pick, position) => (
                    <li key={`${position}:${pick}`} className="q-pick">
                      {pick}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
      {outcome ? (
        <div className="q-foot q-foot--resolved">
          <p className="q-meta">
            {by ? <span className="q-who">{actorName(by, t)}</span> : null}
            <time className="num" dateTime={outcome.at}>
              {timeOfDay(outcome.at)}
            </time>
            {result ? (
              <span className="q-result" data-tip={result.tip}>
                {result.text}
              </span>
            ) : null}
          </p>
          {status === "declined" && outcome.note ? (
            <p className="q-note">
              <span className="q-note-key">{t("question.note")}</span>
              {outcome.note}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// ───────────────────────── 卡片 ─────────────────────────

export interface QuestionCardProps {
  item: QuestionItem;
  sessionId: SessionId;
  /** 刚出现的一行：淡入（与时间线里其他行一致）。 */
  enter?: boolean;
}

export const QuestionCard = memo(function QuestionCard({ item, sessionId, enter }: QuestionCardProps): ReactNode {
  const t = useT();
  // 回答成功后卡片先按回执变成只读，不等事件；事件到了以事件为准（内容相同）。
  const [settled, setSettled] = useState<Settled | undefined>(undefined);
  const view: QuestionItem = item.status === "open" && settled ? { ...item, status: settled.status, outcome: settled.outcome } : item;
  const { status } = view;

  useEffect(() => {
    if (status !== "open") saved.delete(item.questionId);
  }, [status, item.questionId]);

  return (
    <section className="question" role="group" aria-label={t("question.label")} data-status={status} data-enter={enter ? "" : undefined}>
      <header className="q-head">
        <span className="q-title">{t("question.title")}</span>
        <span className="q-state" data-status={status}>
          <i className="q-pip" aria-hidden="true" />
          {t(`question.state.${status}`)}
        </span>
        <time className="row-time num" dateTime={item.at} data-tip={new Date(item.at).toLocaleString()}>
          {timeOfDay(item.at)}
        </time>
      </header>
      {status === "open" ? <OpenBody item={view} sessionId={sessionId} onSettled={setSettled} /> : <ResolvedBody item={view} />}
    </section>
  );
});
