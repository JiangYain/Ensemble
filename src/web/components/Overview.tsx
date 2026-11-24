import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SessionSummary } from "@shared/types";
import { openSwitcher, setHideIdle, store, viewMemory } from "../lib/app";
import { directoryKey, groupFolders } from "../lib/folder";
import { groupGit, planGit, useGit, type GitEntry, type GitView } from "../lib/git";
import { collapsedSessions, sessionsPerOrigin } from "../lib/originCollapse";
import { useStore } from "../lib/store";
import { useT } from "../lib/useT";
import { isOperated, markLeaving, useWorkView } from "../lib/useWorkView";
import { filterWorking, leavingNodes } from "../lib/workFilter";
import {
  buildWorkspaces,
  scopeKey,
  sessionsInScope,
  type WorkspaceItem,
  type WorkspaceScope,
} from "../lib/workspaces";
import { SceneEngine } from "../scene/engine";
import { fitArea, gitNodeId, isCompact, layoutScene, originNodeId, type Area } from "../scene/layout";
import { AgentNode } from "./AgentNode";
import { ArrangeBar } from "./ArrangeBar";
import { CanvasScale } from "./CanvasScale";
import { EdgeHints } from "./EdgeHints";
import { EmptyScene } from "./EmptyScene";
import { FolderNode } from "./FolderNode";
import { GitNode } from "./GitNode";
import { IdleScene } from "./IdleScene";
import { NodeContextMenu } from "./NodeContextMenu";
import { OriginNode } from "./OriginNode";
import { SessionList } from "./SessionList";
import { WorkspaceHeader } from "./WorkspaceHeader";

/**
 * 影响布局、来源卡和管线的字段；进度与活动文字不需要重新布局。
 * 汇聚的会话（跟随多个上级）要带上完整的上级集合：它的连线与列由所有上级决定，只看主上级会漏掉其余上级的变化；
 * 单上级的会话不多带一项，键与原来一字不差。（导出只为测试。）
 */
export function structureKey(list: readonly SessionSummary[]): string {
  return JSON.stringify(
    list.map((s) => [s.id, s.origin, s.parentSessionId, s.createdAt, s.phase, ...(s.parentSessionIds && s.parentSessionIds.length > 1 ? [s.parentSessionIds] : [])]),
  );
}

function findGitEntry(entries: ReadonlyMap<string, GitEntry>, workspace: string | undefined): GitEntry | undefined {
  if (!workspace) return undefined;
  const direct = entries.get(workspace);
  if (direct) return direct;
  const target = directoryKey(workspace);
  for (const [path, entry] of entries) {
    if (directoryKey(path) === target) return entry;
  }
  return undefined;
}

function ActiveEmptyScene(): ReactNode {
  const t = useT();
  return (
    <div className="empty" data-idle="">
      <h2 className="empty-title">{t("view.activeEmptyTitle")}</h2>
      <p className="empty-sub">{t("view.activeEmptySub")}</p>
    </div>
  );
}

const EMPTY_COLLAPSED: ReadonlySet<string> = new Set();

export interface OverviewProps {
  engine?: SceneEngine;
  /**
   * 工作空间范围：
   * - 缺省时（例如独立测试画布组件）保持传统全景模式，带 `.canvas-meta` 与完整 Git / Folder 节点；
   * - 传入时启用多空间模式：左上角显示编辑部空间标头（承载目录与 Git），右上角切换「仅工作中」与「画布 / 列表」，右下角显示图纸比例尺。
   */
  scope?: WorkspaceScope;
  /** 由上层算好的工作空间列表；缺省时由本组件自行聚合。 */
  workspaces?: readonly WorkspaceItem[];
  /** 由上层统一轮询的 Git 快照；缺省时由本组件自行查询。 */
  gitState?: GitView;
  onCamera?: (camera: { k: number }, moved: boolean) => void;
  onPositions?: (custom: boolean) => void;
}

export function Overview({
  engine: providedEngine,
  scope,
  workspaces: providedWorkspaces,
  gitState: providedGit,
  onCamera,
  onPositions,
}: OverviewProps = {}): ReactNode {
  const t = useT();
  const sessions = useStore(store, (s) => s.sessions);
  const viewMode = useStore(store, (s) => s.viewMode);
  const hideIdlePref = useStore(store, (s) => s.hideIdle);
  const collapsedPref = useStore(store, (s) => s.collapsedOrigins);

  const scopedMode = scope !== undefined;
  const activeScope: WorkspaceScope = scope ?? { kind: "all" };
  const spaceId = scopeKey(activeScope);
  const isListView = scopedMode && viewMode === "list";

  const allList = useMemo(() => Object.values(sessions), [sessions]);
  const allWorkspaces = useMemo(
    () => providedWorkspaces ?? buildWorkspaces(allList),
    [providedWorkspaces, allList],
  );
  const currentWorkspace = useMemo(
    () => (activeScope.kind === "origin" ? allWorkspaces.find((item) => item.key === activeScope.key) : undefined),
    [activeScope, allWorkspaces],
  );

  // 按工作空间过滤出本空间要展示的会话：单 Main Agent 空间只包含它自己的会话树；全部活跃只包含工作中会话。
  const list = useMemo(
    () => (activeScope.kind === "all" ? allList : sessionsInScope(allList, activeScope)),
    [allList, activeScope],
  );

  // 「全部活跃」本身已按工作中过滤，不再二次套用 hideIdle；单 Main Agent 专属画布不因全景里的“折叠来源”而把自己藏空。
  const hideIdle = activeScope.kind === "active" ? false : hideIdlePref;
  const collapsedOrigins = activeScope.kind === "all" ? collapsedPref : EMPTY_COLLAPSED;

  const key = structureKey(list);
  const latest = useRef(list);
  latest.current = list;

  const viewportRef = useRef<HTMLDivElement>(null);
  const operated = useCallback((id: string) => isOperated(viewportRef.current, id), []);
  const work = useWorkView(list, hideIdle, operated, collapsedOrigins);

  // 取景区域决定多个发起端怎么并排：量化到 16px，拖动窗口时不会每一帧都重算布局。
  const [area, setArea] = useState<Area | undefined>(undefined);
  const [selectionCount, setSelectionCount] = useState<number | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [moved, setMoved] = useState(false);
  const [custom, setCustom] = useState(false);
  // 已有的卡原地不动之后，现在的排布可能与全新规划不同：没拖过节点也要让用户点得到“重新排列”（见 HeldLayout.drifted）。
  const [drifted, setDrifted] = useState(false);

  const handleCamera = useCallback(
    (camera: { k: number }, userMoved: boolean) => {
      setZoom(camera.k);
      setMoved(userMoved);
      onCamera?.(camera, userMoved);
    },
    [onCamera],
  );
  const handlePositions = useCallback(
    (isCustom: boolean) => {
      setCustom(isCustom);
      onPositions?.(isCustom);
    },
    [onPositions],
  );

  useLayoutEffect(() => {
    if (isListView) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = (): void => {
      const next = fitArea(viewport.clientWidth, viewport.clientHeight);
      const w = Math.round(next.w / 16) * 16;
      const h = Math.round(next.h / 16) * 16;
      setArea((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [isListView]);

  const areaW = area?.w;
  const areaH = area?.h;
  const compact = isCompact(area);

  // 来源的工作目录与 Git 状态：上层已提供时直接复用，否则本组件自行轮询。
  const gitPlan = useMemo(() => planGit(latest.current), [key]);
  const ownGit = useGit(providedGit ? [] : gitPlan.targets);
  const git = providedGit ?? ownGit;

  // 单 Main Agent 空间与「全部活跃」不画左侧 Git/Folder 节点（目录与 Git 已升格到左上角编辑部标头）。
  const hideContextNodes = activeScope.kind !== "all";
  const headerGit = useMemo(
    () => (activeScope.kind === "origin" ? findGitEntry(git.entries, currentWorkspace?.workspace) : undefined),
    [activeScope.kind, git.entries, currentWorkspace?.workspace],
  );

  const gitGroups = useMemo(() => groupGit(gitPlan.workspaceOf, git.entries), [gitPlan, git.entries]);
  const gitSignature = useMemo(() => JSON.stringify(gitGroups.map((group) => [group.key, group.origins])), [gitGroups]);
  const gitLinks = useMemo(() => {
    const links = new Map<string, string>();
    for (const [worktree, origins] of JSON.parse(gitSignature) as [string, string[]][]) {
      for (const origin of origins) links.set(origin, worktree);
    }
    return links;
  }, [gitSignature]);
  const gitCards = useMemo(() => new Map(gitGroups.map((group) => [gitNodeId(group.key), group])), [gitGroups]);

  const engine = useMemo(() => providedEngine ?? new SceneEngine(), [providedEngine]);
  // 用户点“重置节点布局”时引擎记下的排布缩放（见 SceneEngine.resetLayout）：布局以它为缩放上限重新规划。
  // 这个空间之后的每一次重算（新会话、“仅工作中”、折叠、窗口尺寸）都带着它，所以不会跳回按 100% 排的形态；没重置过就是 undefined，按默认的 100% 排。
  const fillZoom = useSyncExternalStore(engine.subscribeFill, () => engine.getFill(spaceId));

  const layout = useMemo(
    () =>
      layoutScene(latest.current, {
        ...(areaW !== undefined && areaH !== undefined ? { area: { w: areaW, h: areaH } } : {}),
        git: gitLinks,
        ...(hideContextNodes ? { hideContextNodes: true } : {}),
        ...(scopedMode ? { grid: true, ...(fillZoom !== undefined ? { zoom: fillZoom } : {}) } : {}),
        ...(work.drawn ? { visible: work.drawn } : {}),
        ...(collapsedOrigins.size > 0 ? { collapsed: collapsedOrigins } : {}),
      }),
    [key, areaW, areaH, gitLinks, hideContextNodes, scopedMode, fillZoom, work.key, collapsedOrigins],
  );

  const perOrigin = useMemo(() => sessionsPerOrigin(list), [list]);
  const collapsedCount = useMemo(() => collapsedSessions(list, collapsedOrigins).size, [list, collapsedOrigins]);
  const folders = useMemo(() => {
    const all = new Map(groupFolders(gitPlan.workspaceOf).map((folder) => [folder.key, folder.origins]));
    return layout.folders.map((folder) => ({ ...folder, origins: all.get(folder.key) ?? folder.origins }));
  }, [layout, gitPlan]);

  useLayoutEffect(() => {
    if (isListView) return;
    const keep = new Set([...collapsedOrigins].map(originNodeId));
    markLeaving(viewportRef.current, leavingNodes(layout, work.leaving, keep));
  }, [isListView, layout, work.leavingKey, collapsedOrigins]);

  const worldRef = useRef<HTMLDivElement>(null);
  const tubeRef = useRef<SVGGElement>(null);
  const dotsRef = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    if (isListView) return;
    const viewport = viewportRef.current;
    const world = worldRef.current;
    const tube = tubeRef.current;
    const dots = dotsRef.current;
    if (!viewport || !world || !tube || !dots) return;
    engine.mount({
      viewport,
      world,
      pipes: { tube, dots },
      onCamera: handleCamera,
      onPositions: handlePositions,
      onArrangement: setDrifted,
      onSelection: setSelectionCount,
    });
    return () => engine.unmount();
  }, [engine, isListView, handleCamera, handlePositions]);

  // 切换工作空间时通知画布引擎：记住旧空间相机，干净落入新空间。
  useLayoutEffect(() => {
    if (isListView) return;
    engine.switchSpace(spaceId);
  }, [engine, spaceId, isListView]);

  const laidOut = useRef(false);
  useLayoutEffect(() => {
    if (isListView) {
      laidOut.current = false;
      return;
    }
    if (!area) return;
    // 全景模式才需要等待左侧 Git 节点首次查询；单空间模式下 Git 已在顶部标头里，画布无需等待。
    if (!hideContextNodes && !laidOut.current && git.pending) return;
    laidOut.current = true;
    // 取景区域交给引擎：持有的排布里竖排的一列长到放不下时，下一张新卡另起一列要用它判断（已有的卡不会因它而动）。
    engine.setLayout(layout, false, area);
  }, [engine, layout, area, git.pending, hideContextNodes, isListView]);

  const morphId = useRef(viewMemory.lastFocusId);
  useEffect(() => {
    const timer = setTimeout(() => {
      viewMemory.lastFocusId = undefined;
      morphId.current = undefined;
      for (const el of document.querySelectorAll<HTMLElement>(".node")) el.style.removeProperty("view-transition-name");
    }, 900);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      if (event.altKey) return;
      const state = store.get();
      if (state.settings.open || state.confirm || state.switcherOpen) return;
      if (event.metaKey || event.ctrlKey) {
        if (isListView || document.querySelector('[role="menu"]')) return;
        const k = event.key.toLowerCase();
        if (k === "a") engine.selectAll();
        else if (k === "z") {
          if (event.shiftKey) engine.redo();
          else engine.undo();
        } else if (k === "y" && event.ctrlKey) engine.redo();
        else return;
        event.preventDefault();
        return;
      }
      if (event.key === "/" && scopedMode) {
        event.preventDefault();
        openSwitcher();
        return;
      }
      if (isListView) return;
      if (event.key === "Escape" && !document.querySelector('[role="menu"]')) engine.clearSelection();
      else if (event.key === "0" || event.key === "f") engine.fit(true, scopedMode);
      else if (event.key === "+" || event.key === "=") engine.zoomBy(1.2);
      else if (event.key === "-" || event.key === "_") engine.zoomBy(1 / 1.2);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [engine, isListView, scopedMode]);

  const sorted = useMemo(
    () => list.filter((s) => !work.drawn || work.drawn.has(s.id)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    [list, work.key],
  );

  // 列表模式展示的会话（遵循同样的“仅工作中”规则，不做画布节点淡出逗留）。
  const listSessions = useMemo(() => {
    if (!hideIdle) return list;
    const visible = filterWorking(list).visible;
    return list.filter((s) => visible.has(s.id));
  }, [list, hideIdle]);

  if (isListView) {
    const emptyNode =
      allList.length === 0 ? (
        <EmptyScene />
      ) : activeScope.kind === "active" && list.length === 0 ? (
        <ActiveEmptyScene />
      ) : hideIdle && listSessions.length === 0 && list.length > 0 ? (
        <IdleScene hidden={list.length} onShowAll={() => setHideIdle(false)} />
      ) : undefined;

    return (
      <div key="list" className="list-stage">
        <WorkspaceHeader
          scope={activeScope}
          workspace={currentWorkspace}
          git={headerGit}
          allWorkspaces={allWorkspaces}
          scopedSessions={list}
          allSessions={allList}
          variant="flow"
        />
        <div className="list-scroll">
          <SessionList sessions={listSessions} empty={emptyNode} />
        </div>
      </div>
    );
  }

  const showEmpty = allList.length === 0;
  const showActiveEmpty = !showEmpty && activeScope.kind === "active" && list.length === 0;
  const showIdleEmpty = !showEmpty && !showActiveEmpty && work.drawn?.size === 0 && layout.origins.length === 0;

  return (
    <div
      key="canvas"
      className="scene"
      ref={viewportRef}
      data-empty={showEmpty ? "" : undefined}
      data-compact={compact ? "" : undefined}
      data-scoped={scopedMode ? "" : undefined}
      data-grid={layout.grid ? "" : undefined}
    >
      {scopedMode ? (
        <WorkspaceHeader
          scope={activeScope}
          workspace={currentWorkspace}
          git={headerGit}
          allWorkspaces={allWorkspaces}
          scopedSessions={list}
          allSessions={allList}
          variant="overlay"
        />
      ) : (
        <div className="canvas-meta" data-scene-ui>
          <h1>Ensemble</h1>
        </div>
      )}

      <div className="scene-world" ref={worldRef}>
        {/* 连线与节点使用同一坐标系，流动状态位于节点之上。 */}
        <div className="scene-plates">
          <svg className="pipes" width="1" height="1" aria-hidden="true">
            <g className="pipes-tube" ref={tubeRef} />
          </svg>
          {layout.origins.map((group) => (
            <OriginNode
              key={group.origin.key}
              origin={group.origin}
              count={group.count}
              running={group.running}
              startedAt={group.startedAt}
              hostTitle={group.hostTitle}
              compact={compact}
              // 单 Main Agent 空间里工作目录与 Git 已由顶部标头承载，来源卡不再重复写目录行。
              folderNode={group.folder !== undefined || activeScope.kind === "origin"}
              collapsed={collapsedOrigins.has(group.origin.key)}
              hidden={perOrigin.get(group.origin.key) ?? group.count}
              engine={engine}
            />
          ))}
          {folders.map((folder) => (
            <FolderNode key={folder.id} folder={folder} engine={engine} />
          ))}
          {layout.nodes.map((node) => {
            const card = node.kind === "git" ? gitCards.get(node.id) : undefined;
            return card ? <GitNode key={node.id} worktree={card.key} entry={card.entry} engine={engine} /> : null;
          })}
          {sorted.map((summary) => (
            <AgentNode key={summary.id} summary={summary} engine={engine} morph={summary.id === morphId.current} />
          ))}
        </div>
        <svg className="pipes" width="1" height="1" aria-hidden="true">
          <g className="pipes-dots" ref={dotsRef} />
        </svg>
      </div>

      {showEmpty ? (
        <EmptyScene />
      ) : showActiveEmpty ? (
        <ActiveEmptyScene />
      ) : showIdleEmpty ? (
        <IdleScene hidden={list.length} onShowAll={() => setHideIdle(false)} />
      ) : null}

      <span className="sr-only" aria-live="polite">
        {work.hidden > 0
          ? t(collapsedCount > 0 ? "scene.srHiddenAny" : "scene.srHidden", { n: list.length - work.hidden, hidden: work.hidden })
          : t("scene.sr", { n: list.length })}
      </span>
      <span className="sr-only" aria-live="polite">
        {selectionCount === undefined ? "" : t("scene.selected", { n: selectionCount })}
      </span>

      <EdgeHints engine={engine} />
      {scopedMode ? (
        <>
          <div className="arrange-wrap" data-scene-ui>
            <ArrangeBar engine={engine} />
          </div>
          {!showEmpty && !showActiveEmpty ? (
            <CanvasScale engine={engine} zoom={zoom} moved={moved} canReset={custom || drifted} />
          ) : null}
        </>
      ) : null}
      <NodeContextMenu engine={engine} />
    </div>
  );
}
