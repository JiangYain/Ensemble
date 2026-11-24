import { useId, useRef, type ReactNode } from "react";
import { closeSettings, setSettingsSection, store } from "../../lib/app";
import { bindT } from "../../lib/i18n";
import { useStore } from "../../lib/store";
import { useT } from "../../lib/useT";
import { Icon } from "../Icons";
import { Modal } from "../Modal";
import { IconButton } from "../ui";
import { moveFocus } from "./keys";
import { SECTION_LIST, type RegisteredSection } from "./sections";

interface Ids {
  tab: (id: string) => string;
  panel: string;
}

function NavItem({ section, selected, ids }: { section: RegisteredSection; selected: boolean; ids: Ids }): ReactNode {
  const t = useT();
  // 选择器返回字符串：别的状态（会话事件几乎一直在来）变了，只要这一行小字没变就不重渲染。
  // useStore 按“状态对象”缓存选择器的结果，所以结果只能由状态本身决定：翻译函数取自 state.lang，不能用外面渲染时捕获的 t——
  // 换语言那一次，订阅拿到的还是上一次渲染的选择器，用旧 t 算出旧语言的字并缓存住，新选择器再也没机会重算。
  const summary = useStore(store, (state) => section.summary?.(state, bindT(state.lang)));
  return (
    <button
      type="button"
      role="tab"
      id={ids.tab(section.id)}
      className="settings-tab"
      aria-selected={selected}
      aria-controls={ids.panel}
      tabIndex={selected ? 0 : -1}
      data-active={selected ? "" : undefined}
      onClick={() => setSettingsSection(section.id)}
    >
      <Icon name={section.icon} size={16} />
      <span className="settings-tab-text">
        <span className="settings-tab-label">{t(section.labelKey)}</span>
        {summary ? <span className="settings-tab-sub">{summary}</span> : null}
      </span>
    </button>
  );
}

/**
 * 设置窗口：左边是窗口标题与分区导航，右边是当前分区的标题行（分区名、该分区自己的操作、关闭）和可滚动的内容。
 * 窗口外壳（遮罩、焦点圈定与归还、Esc、点击遮罩关闭、进出场）全部是 Modal 的；分区从登记表（sections.ts）来，这里不认识任何具体分区。
 * 窗口宽度不够时（宿主的窄侧栏），导航在样式里收成顶部一条，仍是同一份 DOM、同一套键盘行为。
 * 导航是 tablist：只有选中项在 Tab 顺序里，方向键移动并切换（窄屏横排时左右键同样有效）。
 */
export function SettingsWindow(): ReactNode {
  const t = useT();
  const { open, section } = useStore(store, (s) => s.settings);
  const base = useId();
  const nav = useRef<HTMLDivElement>(null);
  const ids: Ids = { tab: (id) => `${base}-tab-${id}`, panel: `${base}-panel` };
  const active = SECTION_LIST.find((candidate) => candidate.id === section) ?? SECTION_LIST[0];
  if (!active) return null;
  const { Component, actions: Actions } = active;

  return (
    <Modal open={open} onClose={closeSettings} label={t("settings.title")} width={920} initialFocus='[role="tab"][aria-selected="true"]'>
      <div className="settings" data-section={active.id}>
        <div className="settings-frame">
          <aside className="settings-side">
            <h2 className="settings-title">{t("settings.title")}</h2>
            <div
              ref={nav}
              className="settings-nav"
              role="tablist"
              aria-label={t("settings.sections")}
              onKeyDown={(event) => {
                const next = moveFocus(event, [...(nav.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])], { axis: "both", wrap: true });
                next?.click();
              }}
            >
              {SECTION_LIST.map((candidate) => (
                <NavItem key={candidate.id} section={candidate} selected={candidate === active} ids={ids} />
              ))}
            </div>
          </aside>
          <section className="settings-main">
            <header className="settings-head">
              <h3 className="settings-head-title">{t(active.labelKey)}</h3>
              <span className="spacer" />
              {Actions ? <Actions /> : null}
              <IconButton icon="close" label={t("common.close")} onClick={closeSettings} />
            </header>
            {/* 换分区整块重建：滚动位置与分区自己的视图状态不带到另一个分区。 */}
            <div key={active.id} className="settings-body" id={ids.panel} role="tabpanel" aria-labelledby={ids.tab(active.id)} data-scroll>
              <Component />
            </div>
          </section>
        </div>
      </div>
    </Modal>
  );
}
