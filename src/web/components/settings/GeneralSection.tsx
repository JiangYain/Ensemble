import { useId, useRef, type ReactNode } from "react";
import { setLang, type AppState } from "../../lib/app";
import type { Lang } from "../../lib/i18n";
import { useLang, useT } from "../../lib/useT";
import { ConcurrencyRow } from "./ConcurrencyRow";
import { moveFocus } from "./keys";

/** 各语言自己的名字：不翻译。看不懂当前界面语言的人，仍然认得出自己的那一个。 */
export const LANGUAGES = [
  { id: "zh", name: "中文", tag: "zh-CN" },
  { id: "en", name: "English", tag: "en" },
] as const satisfies readonly { id: Lang; name: string; tag: string }[];

/** 导航项下面的小字：当前的界面语言。 */
export function generalSummary(state: AppState): string | undefined {
  return LANGUAGES.find((language) => language.id === state.lang)?.name;
}

/**
 * “通用”分区。两项设置，作用范围不同，各自的说明里写清楚：
 * - 界面语言：这个浏览器的偏好（localStorage），不像模型开放设置那样所有宿主共用，所以说明里只写“这个浏览器”。
 *   选中即生效，没有保存按钮；沿用 lib/app 的 setLang（写 `ensemble.lang`，同步 `<html lang>`），不另起一套。
 *   单选组按 WAI-ARIA 的 radio 模式：只有选中的一项在 Tab 顺序里，方向键移动并选中。
 * - 并发上限：服务端的设置，所有宿主与页面共用，改动立即生效，同样没有保存按钮（见 ConcurrencyRow）。服务没给出这项设置时整行不出现。
 */
export function GeneralSection(): ReactNode {
  const t = useT();
  const lang = useLang();
  const label = useId();
  const note = useId();
  const group = useRef<HTMLDivElement>(null);

  return (
    <div className="setting-list">
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label" id={label}>{t("settings.language")}</div>
          <p className="setting-note" id={note}>{t("settings.languageNote")}</p>
        </div>
        <div
          ref={group}
          className="segmented setting-control"
          role="radiogroup"
          aria-labelledby={label}
          aria-describedby={note}
          onKeyDown={(event) => {
            const next = moveFocus(event, [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])], { axis: "both", wrap: true });
            next?.click();
          }}
        >
          {LANGUAGES.map((language) => (
            <button
              key={language.id}
              type="button"
              role="radio"
              lang={language.tag}
              aria-checked={lang === language.id}
              tabIndex={lang === language.id ? 0 : -1}
              data-active={lang === language.id ? "" : undefined}
              onClick={() => setLang(language.id)}
            >
              {language.name}
            </button>
          ))}
        </div>
      </div>
      <ConcurrencyRow />
    </div>
  );
}
