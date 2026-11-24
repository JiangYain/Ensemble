import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { store } from "../../lib/app";
import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  displayConcurrency,
  parseDraft,
  saveConcurrency,
  startingLimit,
  stepped,
  valueOfMax,
} from "../../lib/concurrency-settings";
import { useStore } from "../../lib/store";
import { useT } from "../../lib/useT";
import { Icon } from "../Icons";
import { moveFocus } from "./keys";

/** 这一项设置的来源怎么说：字典键写成字面量（词典检查靠它认出“有人在用”），不在运行时拼。 */
const SOURCE_KEY = {
  settings: "settings.concurrencySource.settings",
  env: "settings.concurrencySource.env",
  default: "settings.concurrencySource.default",
  startup: "settings.concurrencySource.startup",
} as const;

const ISSUE_KEY = {
  invalid_value: "settings.concurrencyIssueInvalid",
  unreadable_file: "settings.concurrencyIssueUnreadable",
} as const;

/**
 * “通用”分区里的“并发上限”：同时运行的会话数上限。这是服务端的设置，所有宿主与页面共用（与旁边的语言只存在本浏览器不同），
 * 改动立即生效，没有保存按钮——与语言切换、模型勾选同一种手感。
 *
 * 交互：
 * - “限制 / 不限制”是单选；限制时右边有一个数字框和两个方形步进钮。数字框的内容是草稿：Enter、失焦、步进提交，Esc 还原；
 *   草稿不合法（空、小数、0、超出范围）时只在下面写一句话，不发请求，也不改任何已生效的值。步进钮与上下方向键每按一次就提交。
 * - 请求在途期间界面先显示用户要的值；失败（服务拒绝、网络断开）时提示并还原到服务端当前的样子，见 lib/concurrency-settings。
 * - “占用 X · 等待 Y”来自服务端的真实名额账目，经 SSE 实时更新；连接不是“已连接”时不显示（那是过期的数）。
 * - 调低上限不会中断任何运行中的会话，占用数可以暂时高于上限，下面会如实说明。
 * 服务没有给出这项设置（老服务、第一份快照还没到）时整行不出现：不拿“没给”当成“不限制”，也不提供一个改不动的控件。
 */
export function ConcurrencyRow(): ReactNode {
  const t = useT();
  const setting = useStore(store, (s) => s.concurrency);
  const capacity = useStore(store, (s) => s.capacity);
  const pending = useStore(store, (s) => s.pendingConcurrency);
  const live = useStore(store, (s) => s.conn === "live");
  const label = useId();
  const note = useId();
  const meta = useId();
  const problem = useId();
  const field = useId();
  const group = useRef<HTMLDivElement>(null);
  /** 这一次打开设置窗口以来最近一次看到的数字：从“不限制”切回“限制”时回到它，而不是一个陌生的默认值。 */
  const lastLimited = useRef<number | undefined>(undefined);
  /** 数字框里正在编辑的文字；undefined 表示没有在编辑，框里显示的就是生效的数字。 */
  const [draft, setDraft] = useState<string | undefined>(undefined);

  const view = setting ? displayConcurrency(setting, capacity, pending) : undefined;
  const shown = view?.value;
  const limited = typeof shown === "number";
  useEffect(() => {
    if (typeof shown === "number") lastLimited.current = shown;
  }, [shown]);
  // 别处（另一个标签页）把它改成了“不限制”：数字框消失，没提交的草稿也就没有意义了。
  useEffect(() => {
    if (!limited) setDraft(undefined);
  }, [limited]);

  if (!view) return null;

  const current = typeof view.value === "number" ? view.value : undefined;
  const amount = (value: typeof view.value): string => (value === "unlimited" ? t("settings.concurrencyUnlimited") : String(value));
  const draftValue = draft === undefined ? undefined : parseDraft(draft);
  const draftInvalid = draft !== undefined && draftValue === undefined;
  const restorable = !view.locked && (view.stored !== undefined || view.issue === "invalid_value");
  // 调低之后的暂时状态：占用数高于上限（只在上限是个数字、且数是实时的时候才有这个说法）。
  const over = live && capacity.max > 0 && capacity.occupied > capacity.max;

  const commitDraft = (): void => {
    if (draft === undefined || draftValue === undefined) return;
    setDraft(undefined);
    if (draftValue !== current) saveConcurrency(draftValue);
  };

  const step = (delta: 1 | -1): void => {
    if (current === undefined) return;
    const next = stepped(draftValue ?? current, delta);
    setDraft(undefined);
    if (next !== current) saveConcurrency(next);
  };

  return (
    <div className="setting-row setting-row--concurrency">
      <div className="setting-text">
        <div className="setting-label" id={label}>{t("settings.concurrency")}</div>
        <p className="setting-note" id={note}>{t("settings.concurrencyNote")}</p>
      </div>
      <div className="concurrency">
        <div className="concurrency-line">
          <div
            ref={group}
            className="segmented setting-control"
            role="radiogroup"
            aria-labelledby={label}
            aria-describedby={`${note} ${meta}`}
            aria-disabled={view.locked || undefined}
            onKeyDown={(event) => {
              const next = moveFocus(event, [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])], { axis: "both", wrap: true });
              next?.click();
            }}
          >
            <button
              type="button"
              role="radio"
              aria-checked={limited}
              tabIndex={limited ? 0 : -1}
              data-active={limited ? "" : undefined}
              disabled={view.locked}
              onClick={() => {
                if (!limited) saveConcurrency(startingLimit(lastLimited.current, view.inherited));
              }}
            >
              {t("settings.concurrencyLimited")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!limited}
              tabIndex={limited ? -1 : 0}
              data-active={limited ? undefined : ""}
              disabled={view.locked}
              onClick={() => {
                if (limited) saveConcurrency("unlimited");
              }}
            >
              {t("settings.concurrencyUnlimited")}
            </button>
          </div>
          {current !== undefined ? (
            <div className="concurrency-field">
              <button
                type="button"
                className="concurrency-step"
                aria-label={t("settings.concurrencyDecrease")}
                aria-controls={field}
                disabled={view.locked || current <= CONCURRENCY_MIN}
                onClick={() => step(-1)}
              >
                <Icon name="minus" size={14} />
              </button>
              <input
                id={field}
                className="concurrency-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                role="spinbutton"
                aria-label={t("settings.concurrencyValue")}
                aria-valuemin={CONCURRENCY_MIN}
                aria-valuemax={CONCURRENCY_MAX}
                aria-valuenow={current}
                aria-invalid={draftInvalid || undefined}
                aria-describedby={draftInvalid ? problem : undefined}
                disabled={view.locked}
                value={draft ?? String(current)}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitDraft();
                  } else if (event.key === "Escape" && draft !== undefined) {
                    // 先还原草稿；没有草稿时 Esc 照常关设置窗口。
                    event.preventDefault();
                    event.stopPropagation();
                    setDraft(undefined);
                  } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                    event.preventDefault();
                    step(event.key === "ArrowUp" ? 1 : -1);
                  }
                }}
              />
              <button
                type="button"
                className="concurrency-step"
                aria-label={t("settings.concurrencyIncrease")}
                aria-controls={field}
                disabled={view.locked || current >= CONCURRENCY_MAX}
                onClick={() => step(1)}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          ) : null}
        </div>
        {draftInvalid && current !== undefined ? (
          <p className="concurrency-meta concurrency-problem" id={problem} role="alert">
            {t("settings.concurrencyDraftInvalid", { min: CONCURRENCY_MIN, max: CONCURRENCY_MAX, current })}
          </p>
        ) : null}
        <div className="concurrency-meta" id={meta}>
          {live ? <p className="num">{t("settings.concurrencyInUse", { occupied: capacity.occupied, waiting: capacity.waiting })}</p> : null}
          {over ? <p>{t("settings.concurrencyOver")}</p> : null}
          <p>
            {view.issue
              ? t(ISSUE_KEY[view.issue], { value: amount(valueOfMax(capacity.max)) })
              : t(SOURCE_KEY[view.source], { value: amount(view.inherited) })}
            {restorable ? (
              <>
                {" "}
                <button type="button" className="link-btn" onClick={() => saveConcurrency(null)}>
                  {t("settings.concurrencyRestore", { value: amount(view.inherited) })}
                </button>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}
