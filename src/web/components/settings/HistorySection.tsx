import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { retentionFault } from "@shared/archive";
import { LIMITS } from "@shared/constants";
import type { RetentionResponse, RetentionSettings } from "@shared/protocol";
import { closeSettings, errorText, navigate, store, type AppState } from "../../lib/app";
import { readRetention, saveRetention } from "../../lib/archive";
import type { TFunction } from "../../lib/i18n";
import { useStore } from "../../lib/store";
import { dateMinute } from "../../lib/text";
import { useLang, useT } from "../../lib/useT";
import { Icon } from "../Icons";

type Field = keyof RetentionSettings;

/** 导航项下面的小字：已归档的会话数（服务端报告的个数；老服务不报就没有这行）。 */
export function historySummary(state: AppState, t: TFunction): string | undefined {
  return state.archivedCount === undefined ? undefined : t("history.summary", { n: state.archivedCount });
}

/**
 * 两项留存各自用到的文案与上限。字典键写成字面量（词典的死键检查靠它认出“有人在用”），不在运行时拼。
 * 上限（只用来写在占位符与提示里）取 LIMITS.retention；一个数合不合法的判断走 shared 的 retentionFault，
 * 就是服务端校验用的那一个函数，取值规则只有它一处。这里只是先拦一道，真正的裁决仍是服务端。
 */
const FIELDS = {
  keepDays: {
    name: "history.keepDaysName",
    lead: "history.keepDaysLead",
    note: "history.keepDaysNote",
    value: "history.keepDaysValue",
    one: "history.unitDay",
    many: "history.unitDays",
    max: LIMITS.retention.maxKeepDays,
  },
  keepCount: {
    name: "history.keepCountName",
    lead: "history.keepCountLead",
    note: "history.keepCountNote",
    value: "history.keepCountValue",
    one: "history.unitTree",
    many: "history.unitTrees",
    max: LIMITS.retention.maxKeepCount,
  },
} as const satisfies Record<Field, unknown>;

/**
 * 草稿文字读成 1 到上限的整数，其余（空、小数、负数、0、超出、夹杂文字）一律不是：不悄悄取整，也不截断。
 * 先要求全是数字（“1.5”“-3”“1e2”“ 3”都不是用户想存的整数写法），再交给 retentionFault 判范围，范围规则不在这里再写一遍。
 */
function wholeNumber(field: Field, text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return retentionFault(field, value) === undefined ? value : undefined;
}

interface RetentionItemProps {
  field: Field;
  /** 服务端此刻生效的值；null＝这一项不限。 */
  value: number | null;
  /** 有一次保存在途：两项共用一份请求体（整份替换），所以在途期间不接受新的提交，免得后一次用过期的另一项把前一次盖掉。 */
  busy: boolean;
  onCommit: (next: number | null) => Promise<boolean>;
}

/**
 * 留存策略的一项：一个开关、一句话、一个整数框。“保留最近 [30] 天”读成一句话，开关决定这一项是否生效。
 *
 * 草稿与提交：数字框里的字是草稿，只在失焦或按 Enter 时提交，输入过程中不发任何请求；Esc 还原。
 * 草稿不合法（空、小数、0、超出范围）时只在下面写一句话、不提交、不改任何已生效的值，也不替用户改写他输入的字。
 * 打开开关不提交任何东西，也没有预填的“默认值”：没有哪个数字是用户的选择，不替他编一个。
 * 框是空的就失焦＝当作没打开，开关自己弹回去（服务端从头到尾没动过，界面不能显示一个并不存在的“已开启”）。
 * 关掉开关立即提交 null（不限）。
 * 保存在途时数字框只读（不是 disabled：键盘用户的焦点不能被拿走）；失败时还原到服务端当前的样子，原因由分区底部给出。
 */
function RetentionItem({ field, value, busy, onCommit }: RetentionItemProps): ReactNode {
  const t = useT();
  const copy = FIELDS[field];
  const note = useId();
  const problem = useId();
  const input = useRef<HTMLInputElement>(null);
  /** 用户刚打开开关、还没有填数：这一项在界面上是开着的，但服务端还是 null。 */
  const [armed, setArmed] = useState(false);
  /** 数字框里正在编辑的文字；undefined 表示没有在编辑，框里显示的就是生效的数字。 */
  const [draft, setDraft] = useState<string | undefined>(undefined);

  const enabled = value !== null || armed;
  const shown = draft ?? (value === null ? "" : String(value));
  const trimmed = draft?.trim();
  // 刚打开开关时的空草稿还没轮到“不合法”（用户还没来得及输入）；清空一个已生效的数则立刻不合法。
  const invalid = trimmed !== undefined && (trimmed === "" ? value !== null : wholeNumber(field, trimmed) === undefined);
  // 单位的单复数跟着框里此刻的数走（编辑中读草稿，否则读生效的值）：英文的 “1 day / 30 days”。
  const quantity = trimmed === undefined ? value : wholeNumber(field, trimmed);
  const unit = quantity === 1 ? copy.one : copy.many;

  // 打开开关之后把光标放进数字框：下一步只能是填数。
  useEffect(() => {
    if (armed) input.current?.focus();
  }, [armed]);

  const revert = (): void => {
    setArmed(false);
    setDraft(undefined);
  };

  const commitDraft = async (): Promise<void> => {
    if (draft === undefined || busy) return;
    const text = draft.trim();
    if (text === "") {
      if (value === null) revert();
      return;
    }
    const next = wholeNumber(field, text);
    if (next === undefined) return;
    if (next === value) {
      revert();
      return;
    }
    await onCommit(next);
    revert();
  };

  const toggle = (on: boolean): void => {
    if (busy) return;
    if (on) {
      setArmed(true);
      setDraft("");
      return;
    }
    revert();
    if (value !== null) void onCommit(null);
  };

  return (
    <div className="setting-row retention-row" data-field={field} data-on={enabled ? "" : undefined}>
      <div className="setting-text">
        <div className="retention-line">
          <label className="retention-toggle">
            <input
              type="checkbox"
              className="retention-input"
              checked={enabled}
              aria-label={t(copy.name)}
              aria-describedby={note}
              aria-disabled={busy || undefined}
              onChange={(event) => toggle(event.currentTarget.checked)}
            />
            <span className="retention-box" aria-hidden="true">
              <Icon name="check" size={12} strokeWidth={3} />
            </span>
          </label>
          <span className="retention-lead">{t(copy.lead)}</span>
          <input
            ref={input}
            className="retention-field"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-label={t(copy.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${note} ${problem}` : note}
            disabled={!enabled}
            readOnly={busy}
            placeholder={enabled ? `1–${copy.max}` : "—"}
            value={shown}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitDraft()}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void commitDraft();
              } else if (event.key === "Escape" && draft !== undefined) {
                // 先还原草稿；没有草稿时 Esc 照常关设置窗口。
                event.preventDefault();
                event.stopPropagation();
                revert();
              }
            }}
          />
          <span className="retention-unit">{t(unit)}</span>
        </div>
        <p className="setting-note" id={note}>
          {t(copy.note)}
        </p>
        {invalid ? (
          <p className="retention-problem" id={problem} role="alert">
            {t("history.invalid", { min: 1, max: copy.max })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * “历史”分区：已归档的会话在哪里、以及要不要让服务自动把旧的任务树归档（留存策略）。没有保存按钮，改动即时生效，与语言、并发上限同一种手感。
 *
 * 留存策略只归档、不删除（文案里写明）；两项各自独立，都不限制就不自动归档（默认）。保存会让服务立刻清扫一次，所以网页不在本地估算“会归档几个”：
 * 估算与服务端的清扫用的是同一套规则、不同的时钟与数据，说错了比不说更糟；保存之后给的是服务端真实清扫的结果（“上次清扫”）。
 * 服务不报已归档个数（老服务，没有归档）时只说明这一点，不画控件。
 */
export function HistorySection(): ReactNode {
  const t = useT();
  const lang = useLang();
  const archived = useStore(store, (s) => s.archivedCount);
  const retention = useStore(store, (s) => s.retention);
  const live = useStore(store, (s) => Object.keys(s.sessions).length);
  const [sweep, setSweep] = useState<RetentionResponse["lastSweep"]>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const supported = archived !== undefined;

  // 打开分区时读一次：快照里的 retention 是连上时那份，“上次清扫”只有这个接口给。读不到就只留一行真实的错误。
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    readRetention(controller.signal)
      .then((response) => setSweep(response.lastSweep))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorText(failure));
      });
    return () => controller.abort();
  }, [supported]);

  const commit = async (field: Field, next: number | null): Promise<boolean> => {
    // 整份替换：另一项用此刻 store 里的值，不用渲染时捕获的（那可能是上一次保存之前的）。
    const current = store.get().retention;
    if (!current || saving) return false;
    setSaving(true);
    setError(undefined);
    try {
      const response = await saveRetention({ ...current, [field]: next });
      setSweep(response.lastSweep);
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!supported) {
    return (
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">{t("history.unsupported")}</div>
            <p className="setting-note">{t("history.unsupportedNote")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="history">
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">{t("history.sessions")}</div>
            <p className="setting-note num">{t("history.sessionsNote", { n: live, m: archived })}</p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              closeSettings();
              navigate({ kind: "archived" });
            }}
          >
            <Icon name="archive" size={14} />
            {t("history.view")}
          </button>
        </div>
      </div>

      <h4 className="history-subhead">{t("history.retention")}</h4>
      <p className="settings-intro history-intro">{t("history.retentionIntro")}</p>
      <div className="setting-list" aria-busy={saving || undefined}>
        {retention ? (
          <>
            <RetentionItem field="keepDays" value={retention.keepDays} busy={saving} onCommit={(next) => commit("keepDays", next)} />
            <RetentionItem field="keepCount" value={retention.keepCount} busy={saving} onCommit={(next) => commit("keepCount", next)} />
          </>
        ) : (
          <div className="setting-row">
            <div className="setting-text">
              <p className="setting-note history-loading">{error ? t("history.retentionUnavailable") : t("history.retentionLoading")}</p>
            </div>
          </div>
        )}
      </div>
      {sweep ? <p className="history-sweep num">{t("history.lastSweep", { time: dateMinute(sweep.at, lang, true), n: sweep.archived })}</p> : null}
      {error ? (
        <p className="history-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
