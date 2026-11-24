import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LIMITS } from "@shared/constants";
import type { SessionSummary, Verification } from "@shared/types";
import { api } from "../lib/api";
import { cancelRun, errorText, patchSummary, store } from "../lib/app";
import { limitState, restoreDraft } from "../lib/conversation";
import { followLatest } from "../lib/reveal";
import { useT } from "../lib/useT";
import { harnessName } from "../lib/view";
import { Icon } from "./Icons";
import { Spinner } from "./ui";

type SendMode = "steer" | "follow_up" | "auto";
type Choice = "steer" | "follow_up";

const drafts = new Map<string, string>();

function verificationTone(verification: Verification | undefined): "ok" | "amber" | "neutral" {
  return verification === "live" ? "ok" : verification === "declared" ? "amber" : "neutral";
}

/**
 * 干预输入：运行中可以纠偏或排队，空闲时继续同一会话。
 *
 * 发送时输入框立刻清空，用户可以马上接着写；消息是否真的送达，由时间线里那条消息的投递进度如实说明。
 * 发送失败（请求没有成功）时把原文放回去并说明原因。
 * 键盘：Enter 发送，Shift+Enter 换行，输入法组字期间的 Enter 不发送；
 * Esc 只让输入框失去焦点（再按一次 Esc 才是“返回全部会话”），从不用来中断运行。
 */
export function Composer({ summary }: { summary: SessionSummary }): ReactNode {
  const t = useT();
  const { id } = summary;
  const [text, setText] = useState(() => drafts.get(id) ?? "");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const modeRefs = useRef<Partial<Record<Choice, HTMLButtonElement | null>>>({});
  const currentId = useRef(id);

  const running = summary.phase === "running";
  const cancellable = running || summary.status === "queued" || summary.status === "starting";
  const closed = summary.phase === "stopped";
  const steerSupport = summary.capabilities.steer.support;
  const canSteer = steerSupport !== "no";

  const [chosen, setChosen] = useState<Choice | undefined>(undefined);
  const mode: SendMode = running ? (chosen ?? (canSteer ? "steer" : "follow_up")) : "auto";

  // 切换会话时换上它自己的草稿。
  useEffect(() => {
    currentId.current = id;
    setText(drafts.get(id) ?? "");
    setError(undefined);
    setChosen(undefined);
  }, [id]);

  useEffect(() => {
    if (text) drafts.set(id, text);
    else drafts.delete(id);
  }, [id, text]);

  // 随内容长高，上限由样式里的 max-height 决定（超过后输入框自己滚动）。
  const fit = useCallback((): void => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => fit(), [text, closed, fit]);

  // 折行取决于宽度：布局切换（宽/中/窄）、侧栏伸缩、窗口缩放、字体加载完，都会让同样的文字折成不同的行数，
  // 只在内容变化时量一次会把高度停在旧值上（首次进入时页面还按“宽”布局排，量到的是被挤窄的宽度，之后一直多出一行空白）。
  // 只看宽度——高度是 fit 自己改的，不能反过来触发；放到下一帧再量，不在观察器回调里改尺寸。
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return undefined;
    let width = el.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(el);
    void document.fonts?.ready.then(fit);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [closed, fit]);

  const trimmed = text.trim();
  const limit = limitState(text.length, LIMITS.maxMessageChars);
  const canSend = trimmed.length > 0 && !limit.over && !busy && !closed;

  const send = useCallback(async () => {
    if (!canSend) return;
    const target = id;
    const sent = text;
    setBusy(true);
    setError(undefined);
    setText("");
    drafts.delete(target);
    areaRef.current?.focus();
    followLatest();
    try {
      const response = await api.send(target, { text: trimmed, mode });
      patchSummary(response.summary);
    } catch (cause) {
      // 请求没有成功：原文放回输入框方便修改后重发（用户若已经写了新的内容，两段都留着），原因写在输入框里，不再额外弹提示。
      const reason = `${t("composer.sendFailed")}${store.get().lang === "zh" ? "：" : ": "}${errorText(cause)}`;
      if (currentId.current === target) {
        setText((current) => restoreDraft(current, sent));
        setError(reason);
      } else {
        drafts.set(target, restoreDraft(drafts.get(target) ?? "", sent));
      }
    } finally {
      setBusy(false);
    }
  }, [canSend, id, mode, t, text, trimmed]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法组字期间（候选词确认的 Enter、取消组字的 Esc）一律不处理；部分浏览器在组字结束的那一下 isComposing 已为 false，keyCode 仍是 229。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape") {
      event.currentTarget.blur();
    }
  };

  const choices: Choice[] = canSteer ? ["steer", "follow_up"] : ["follow_up"];
  const onModeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (choices.length < 2 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, choices.indexOf(mode as Choice));
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (current + step + choices.length) % choices.length;
    const choice = choices[next];
    if (!choice) return;
    setChosen(choice);
    modeRefs.current[choice]?.focus();
  };

  const name = harnessName(summary.harness, t);
  const placeholder = mode === "steer" ? t("composer.placeholder.steer", { name }) : mode === "follow_up" ? t("composer.placeholder.followUp", { name }) : t("composer.placeholder.idle", { name });

  const verification = mode === "steer" ? summary.capabilities.steer.verification : undefined;
  const deliveryMode = mode === "steer" ? summary.capabilities.steer.mode : mode === "follow_up" ? "after_run" : undefined;
  const deliveryKey = deliveryMode ? `capMode.${deliveryMode}` : undefined;
  const deliveryLabel = deliveryKey && deliveryMode ? (t(deliveryKey) === deliveryKey ? deliveryMode : t(deliveryKey)) : undefined;

  const maxText = LIMITS.maxMessageChars.toLocaleString();
  const notice = error ?? (limit.over ? t("composer.tooLong", { max: maxText }) : undefined);

  const stop = (): void => {
    setStopping(true);
    void cancelRun(id, { ok: t("toast.cancelOk"), nothing: t("toast.cancelNothing"), failed: t("toast.cancelFailed") }).finally(() => setStopping(false));
  };

  // 已关闭的会话不能再收消息：不放一个灰掉的输入框，而是明说原因。
  if (closed) {
    return (
      <div className="composer" data-closed="">
        <div className="composer-closed">
          <Icon name="lock" size={14} />
          <span>{t("composer.placeholder.closed")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="composer" data-busy={busy ? "" : undefined}>
      <div className="composer-box" data-over={limit.over ? "" : undefined} data-error={error ? "" : undefined}>
        <textarea
          ref={areaRef}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label={t("composer.label")}
          aria-invalid={limit.over || error ? true : undefined}
          enterKeyHint="send"
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(undefined);
          }}
          onKeyDown={onKeyDown}
        />
        {notice || limit.near ? (
          <div className="composer-notice">
            {notice ? (
              <span className="composer-error" role="alert">
                <Icon name="alert" size={12} strokeWidth={2} />
                <span>{notice}</span>
              </span>
            ) : (
              <span />
            )}
            {limit.near ? (
              <span className="composer-count num" data-over={limit.over ? "" : undefined} aria-hidden="true">
                {text.length.toLocaleString()} / {maxText}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="composer-bar">
          <div className="composer-mode">
            {running && canSteer ? (
              <div className="composer-modes" role="radiogroup" aria-label={t("composer.mode")} onKeyDown={onModeKeyDown}>
                {choices.map((choice) => (
                  <button
                    key={choice}
                    ref={(node) => {
                      modeRefs.current[choice] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={mode === choice}
                    tabIndex={mode === choice ? 0 : -1}
                    onClick={() => setChosen(choice)}
                  >
                    {t(choice === "steer" ? "composer.mode.steer" : "composer.mode.followUp")}
                  </button>
                ))}
              </div>
            ) : running ? (
              // 这个执行端不能在运行中纠偏：只剩“排队”一个选项，不摆一个只有一格的开关，如实说明原因。
              <span className="composer-mode-label" data-tip={t("composer.noSteer")}>
                <Icon name="clock" size={12} />
                {t("composer.mode.followUp")}
              </span>
            ) : (
              <span className="composer-mode-label">
                <Icon name="send" size={12} />
                {t("composer.mode.idle")}
              </span>
            )}
          </div>
          {verification !== undefined || deliveryLabel ? (
            <div className="composer-meta">
              {verification !== undefined ? (
                <span className="cap-note" data-tone={verificationTone(verification)} data-tip={t(`verify.tip.${verification}`)}>
                  {verification === "live" ? <Icon name="check" size={11} strokeWidth={2.4} /> : null}
                  {t(`verify.${verification}`)}
                </span>
              ) : null}
              {deliveryLabel ? (
                <span className="cap-note" data-kind="delivery">
                  <Icon name="clock" size={12} />
                  {deliveryLabel}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="composer-actions">
            {cancellable ? (
              <button type="button" className="composer-stop" disabled={stopping} aria-busy={stopping || undefined} data-tip={t("composer.cancelTip")} aria-label={t("composer.cancel")} onClick={stop}>
                {stopping ? <Spinner size={12} /> : <Icon name="stop" size={13} />}
                <span className="composer-stop-label">{t("composer.cancel")}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary send-btn"
              disabled={!canSend}
              aria-busy={busy || undefined}
              aria-label={t("composer.send")}
              data-tip={limit.over ? t("composer.tooLong", { max: maxText }) : `${t("composer.send")}  ·  Enter`}
              onClick={() => void send()}
            >
              {busy ? <Spinner size={14} /> : <Icon name="arrowUp" size={16} strokeWidth={2.2} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
