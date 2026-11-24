import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sliceHead } from "@shared/safe-slice";
import type { SessionSummary } from "@shared/types";
import { closeSwitcher, navigate, selectWorkspace, store } from "../lib/app";
import { useStore } from "../lib/store";
import { dateMinute, isActivePhase, pathName } from "../lib/text";
import { useLang, useT } from "../lib/useT";
import {
  buildSwitcherEntries,
  type SwitcherEntry,
  type WorkspaceItem,
  type WorkspaceScope,
} from "../lib/workspaces";
import { Icon } from "./Icons";
import { Modal } from "./Modal";

type SwitcherFilter = "all" | "workspaces" | "sessions";

/** 紧凑相对时间（参考图 2 右栏风格：now / 12m / 2h / 3d / 11mo / 1y）。 */
function compactAge(iso: string, now: number, lang: "zh" | "en"): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return lang === "zh" ? "刚刚" : "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

export interface QuickSwitcherProps {
  workspaces: readonly WorkspaceItem[];
  sessions: readonly SessionSummary[];
  currentScope: WorkspaceScope;
  /** 每个 Main Agent 对应的真实 Git 分支名（用于搜索匹配）。 */
  branches?: ReadonlyMap<string, string>;
}

/**
 * 参考用户提供设计稿重构的极简 Ctrl+K / ⌘K 快速切换器：
 * - 顶部单行栏：左侧轻灰范围下拉芯片（全部 / Main Agent / 会话 + 全局视图直达）+ 中间无框搜索 + 右侧仅活跃过滤图标；
 * - 列表主体为极度干净的单行横向布局：主标题 + 紧跟右侧的极细目录名 + 靠右紧凑相对时间；
 * - 纯粹浅灰直角实底选中态，无分组大标题噪音、无厚重底栏。
 */
export function QuickSwitcher({ workspaces, sessions, currentScope, branches }: QuickSwitcherProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const open = useStore(store, (s) => s.switcherOpen);
  const recentOrigins = useStore(store, (s) => s.recentOrigins);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SwitcherFilter>("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const scopeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setFilter("all");
      setActiveOnly(false);
      setScopeMenuOpen(false);
      setActiveIndex(0);
      setOpenedAt(Date.now());
    }
  }, [open]);

  // 点击下拉菜单之外时收起范围选择菜单。
  useEffect(() => {
    if (!scopeMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!scopeMenuRef.current?.contains(event.target as Node)) setScopeMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [scopeMenuOpen]);

  const rawEntries = useMemo(
    () =>
      buildSwitcherEntries({
        query,
        workspaces,
        sessions,
        currentScope,
        recentOrigins,
        ...(branches ? { branches } : {}),
        t,
        lang,
      }),
    [query, workspaces, sessions, currentScope, recentOrigins, branches, t, lang],
  );

  const entries = useMemo(() => {
    // 主列表只放纯粹的 Main Agent 与会话条目（全局视图「全部活跃 / 全部空间」收在左上角范围菜单里，保持极简单行体验）。
    let items: SwitcherEntry[];
    if (filter === "sessions") {
      // 用户主动切到「会话」范围时，无搜索词也列出最近会话（最多 20 条）方便浏览。
      const q = query.trim().toLowerCase();
      const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
      const sorted = [...sessions].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
      items = sorted
        .filter((s) => {
          if (tokens.length === 0) return true;
          const hay = [s.title, s.id, s.harness, s.cwd, s.model?.label, s.model?.resolved].filter(Boolean).join(" ").toLowerCase();
          return tokens.every((tok) => hay.includes(tok));
        })
        .slice(0, 24)
        .map((session) => ({ kind: "session" as const, id: `ses:${session.id}`, session }));
    } else if (filter === "workspaces") {
      items = rawEntries.filter((entry) => entry.kind === "workspace");
    } else {
      items = rawEntries.filter((entry) => entry.kind !== "view");
    }

    if (!activeOnly) return items;
    return items.filter((entry) => {
      if (entry.kind === "workspace") return entry.item.working > 0 || entry.item.attention > 0;
      if (entry.kind === "session") return isActivePhase(entry.session.phase) || entry.session.phase === "ready" || (entry.session.attention?.length ?? 0) > 0;
      return false;
    });
  }, [rawEntries, filter, activeOnly, query, sessions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, filter, activeOnly]);

  const clampedIndex = entries.length === 0 ? -1 : Math.min(activeIndex, entries.length - 1);

  useEffect(() => {
    if (!open || clampedIndex < 0) return;
    const item = listRef.current?.querySelector<HTMLElement>(`[data-sw-index="${clampedIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [open, clampedIndex]);

  const activate = (entry: SwitcherEntry): void => {
    closeSwitcher();
    if (entry.kind === "workspace") {
      selectWorkspace({ kind: "origin", key: entry.item.key });
    } else if (entry.kind === "view") {
      selectWorkspace(entry.scope);
    } else {
      navigate({ kind: "session", id: entry.session.id });
    }
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (entries.length > 0) setActiveIndex((i) => (i + 1) % entries.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length > 0) setActiveIndex((i) => (i - 1 + entries.length) % entries.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = clampedIndex >= 0 ? entries[clampedIndex] : undefined;
      if (chosen) activate(chosen);
    }
  };

  const filterLabel =
    filter === "workspaces"
      ? t("switcher.scopeWorkspaces")
      : filter === "sessions"
        ? t("switcher.scopeSessions")
        : t("switcher.scopeAll");

  const activeEntry = clampedIndex >= 0 ? entries[clampedIndex] : undefined;

  return (
    <Modal open={open} onClose={closeSwitcher} label={t("switcher.title")} width={620} initialFocus=".switcher-input">
      <div
        className="switcher"
        onKeyDown={(event) => {
          if (event.key === "Escape" && scopeMenuOpen && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            event.preventDefault();
            setScopeMenuOpen(false);
          }
        }}
      >
        <div className="switcher-bar">
          <div className="switcher-scope-wrap" ref={scopeMenuRef}>
            <button
              type="button"
              className="switcher-scope"
              aria-haspopup="menu"
              aria-expanded={scopeMenuOpen}
              onClick={() => setScopeMenuOpen((v) => !v)}
            >
              <span>{filterLabel}</span>
              <Icon name="chevronDown" size={12} strokeWidth={2} />
            </button>
            {scopeMenuOpen ? (
              <div className="switcher-scope-menu" role="menu">
                {(
                  [
                    ["all", t("switcher.scopeAll")],
                    ["workspaces", t("switcher.scopeWorkspaces")],
                    ["sessions", t("switcher.scopeSessions")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={filter === value}
                    className="switcher-scope-option"
                    data-active={filter === value ? "" : undefined}
                    onClick={() => {
                      setFilter(value);
                      setScopeMenuOpen(false);
                    }}
                  >
                    <span>{label}</span>
                    {filter === value ? <Icon name="check" size={12} /> : null}
                  </button>
                ))}
                <div className="switcher-scope-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="switcher-scope-option"
                  onClick={() => {
                    closeSwitcher();
                    selectWorkspace({ kind: "active" });
                  }}
                >
                  <span>{t("rail.active")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="switcher-scope-option"
                  onClick={() => {
                    closeSwitcher();
                    selectWorkspace({ kind: "all" });
                  }}
                >
                  <span>{t("rail.all")}</span>
                </button>
              </div>
            ) : null}
          </div>

          <input
            type="text"
            className="switcher-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t("switcher.placeholder")}
            aria-label={t("switcher.title")}
            role="combobox"
            aria-expanded="true"
            aria-controls="ensemble-switcher-list"
            aria-activedescendant={activeEntry ? `sw-${activeEntry.id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />

          <button
            type="button"
            className="switcher-filter-btn"
            aria-label={t("switcher.activeOnly")}
            aria-pressed={activeOnly}
            data-active={activeOnly ? "" : undefined}
            data-tip={t("switcher.activeOnly")}
            onClick={() => setActiveOnly((v) => !v)}
          >
            <Icon name="filterLines" size={15} />
          </button>
        </div>

        <div id="ensemble-switcher-list" ref={listRef} className="switcher-list" role="listbox" aria-label={t("switcher.title")}>
          {entries.length === 0 ? (
            <div className="switcher-empty">{t("switcher.empty")}</div>
          ) : (
            entries.map((entry, index) => {
              const selected = index === clampedIndex;
              if (entry.kind === "workspace") {
                const { item } = entry;
                // 单行列表右侧已紧跟目录名：无宿主标题时改用“宿主 · 短会话标识或首次委派时刻”，避免同目录多个历史对话全部重名且重复目录名。
                const title = item.hostTitle
                  ? item.hostTitle
                  : item.origin.kind === "user"
                    ? `${t("origin.user")} · ${dateMinute(item.startedAt, lang, true)}`
                    : item.origin.sessionRef?.id
                      ? `${item.origin.hostLabel} · ${sliceHead(item.origin.sessionRef.id, 8)}`
                      : `${item.origin.hostLabel} · ${dateMinute(item.startedAt, lang, true)}`;
                const dir = item.workspace ? pathName(item.workspace) : undefined;
                const age = compactAge(item.latestAt, openedAt, lang);
                return (
                  <button
                    key={entry.id}
                    id={`sw-${entry.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected ? "" : undefined}
                    data-sw-index={index}
                    className="switcher-item"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activate(entry)}
                  >
                    {item.running > 0 ? <i className="a-run switcher-live-dot" aria-hidden="true" /> : null}
                    <span className="switcher-primary">{title}</span>
                    {dir ? (
                      <span className="switcher-dir">
                        <Icon name="folder" size={12.5} className="switcher-dir-ico" />
                        <span>{dir}</span>
                      </span>
                    ) : null}
                    <span className="switcher-age num">{age}</span>
                  </button>
                );
              }

              if (entry.kind === "session") {
                const { session } = entry;
                const dir = session.cwd ? pathName(session.cwd) : entry.workspaceTitle;
                const age = compactAge(session.updatedAt || session.createdAt, openedAt, lang);
                const running = isActivePhase(session.phase);
                return (
                  <button
                    key={entry.id}
                    id={`sw-${entry.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected ? "" : undefined}
                    data-sw-index={index}
                    className="switcher-item"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activate(entry)}
                  >
                    {running ? <i className="a-run switcher-live-dot" aria-hidden="true" /> : null}
                    <span className="switcher-primary">{session.title}</span>
                    {dir ? (
                      <span className="switcher-dir">
                        <Icon name="folder" size={12.5} className="switcher-dir-ico" />
                        <span>{dir}</span>
                      </span>
                    ) : null}
                    <span className="switcher-age num">{age}</span>
                  </button>
                );
              }

              return null;
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
