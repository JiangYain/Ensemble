import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SessionSummary } from "@shared/types";
import { store } from "../lib/app";
import { contextMenuNode } from "../lib/contextMenu";
import { sessionsPerOrigin } from "../lib/originCollapse";
import { useStore } from "../lib/store";
import { useT } from "../lib/useT";
import type { NodeContextRequest, SceneEngine } from "../scene/engine";
import { agentNodeId } from "../scene/layout";
import { MenuPopup } from "./Menu";
import { originKeyOfNode, originMenuEntries } from "./originMenu";
import { selectionMenuEntries } from "./selectionMenu";
import { nodeMenuItems } from "./sessionActions";

/** 键盘打开时没有可靠的指针位置：菜单放在节点左上角往里各缩进这么多。 */
const KEYBOARD_INSET = 14;

/** `agentNodeId` 的逆运算：不是会话节点（来源、Git、Folder……）返回 undefined。 */
export function sessionIdOfNode(nodeId: string): string | undefined {
  const prefix = agentNodeId("");
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : undefined;
}

interface OpenMenu {
  seq: number;
  request: NodeContextRequest;
  /** 菜单左上角想贴的位置（视口坐标）；放不下时由弹层翻转、夹取。 */
  at: { x: number; y: number };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * 画布节点的右键菜单（也是键盘上 ContextMenu 键 / Shift+F10 的菜单），Overview 里只挂这一个。
 * - 单个会话节点：与头部“···”完全相同的菜单（同一个 `nodeMenuItems` 调用）。
 * - 单个来源（Main Agent）节点：隐藏 / 显示它的相关节点（`originMenuEntries`）。
 * - 属于“选中 ≥2 个”集合的任一节点（任何类型）：作用于整个选中集合的多选菜单。
 * - 其余（没有多选时的 Git、Folder 节点、画布空白、输入框……）不接管，浏览器的原生菜单照常出现。
 * “哪个节点、作用范围是什么”由引擎判断（`onNodeContext`）；这里只决定要不要接管，并把菜单画出来。
 */
export function NodeContextMenu({ engine }: { engine: SceneEngine }): ReactNode {
  const t = useT();
  const sessions = useStore(store, (state) => state.sessions);
  const collapsedOrigins = useStore(store, (state) => state.collapsedOrigins);
  // 服务懂归档才给归档的菜单项（老服务没有这些接口）。
  const archiveSupported = useStore(store, (state) => state.archivedCount !== undefined);
  const selectedIds = useSyncExternalStore(engine.subscribeSelection, engine.getSelectedIds);
  const { canUndo, canRedo } = useSyncExternalStore(engine.subscribe, engine.getState);
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const sequence = useRef(0);
  const current = useRef<OpenMenu | undefined>(undefined);
  current.current = menu;

  const closeMenu = useCallback((open: OpenMenu, restoreFocus: boolean) => {
    // 已经被新的菜单替换、或已经关过：不处理，免得误关新开的那个。
    if (current.current?.seq !== open.seq) return;
    current.current = undefined;
    setMenu(undefined);
    // 同步还焦点：紧接着可能弹出确认对话框，它要记住的是节点而不是即将消失的菜单项。
    if (restoreFocus && open.request.el.isConnected) open.request.el.focus({ preventScroll: true });
  }, []);

  useEffect(
    () =>
      engine.onNodeContext((request) => {
        if (request.scope === "node") {
          // 只有会话与来源节点有菜单；Git、Folder 节点没有，不凭空发明内容，交还给浏览器。
          const sessionId = sessionIdOfNode(request.nodeId);
          if (sessionId !== undefined) {
            if (store.get().sessions[sessionId] === undefined) return false;
          } else {
            const key = originKeyOfNode(request.nodeId);
            if (key === undefined || !sessionsPerOrigin(Object.values(store.get().sessions)).has(key)) return false;
          }
        }
        const rect = request.el.getBoundingClientRect();
        sequence.current += 1;
        setAnnouncement("");
        setMenu({ seq: sequence.current, request, at: request.point ?? { x: rect.left + KEYBOARD_INSET, y: rect.top + KEYBOARD_INSET } });
        return true;
      }),
    [engine],
  );

  // 菜单所指的对象不在了、或选中集合变了（多选菜单的对象已经失效）：收起来。
  const nodeSessionId = menu?.request.scope === "node" ? sessionIdOfNode(menu.request.nodeId) : undefined;
  const nodeOriginKey = menu?.request.scope === "node" ? originKeyOfNode(menu.request.nodeId) : undefined;
  const originCounts = useMemo(() => (nodeOriginKey === undefined ? undefined : sessionsPerOrigin(Object.values(sessions))), [nodeOriginKey, sessions]);
  const nodeOriginGone = nodeOriginKey !== undefined && originCounts?.has(nodeOriginKey) !== true;
  const nodeSessionGone =
    menu?.request.scope === "node" && nodeOriginKey === undefined && (nodeSessionId === undefined || sessions[nodeSessionId] === undefined);
  const selectionChanged = menu?.request.scope === "selection" && !sameIds(selectedIds, menu.request.ids);
  const nodeGone = menu !== undefined && !menu.request.el.isConnected;
  useEffect(() => {
    if (menu && (nodeSessionGone || nodeOriginGone || selectionChanged || nodeGone)) closeMenu(menu, false);
  }, [menu, nodeSessionGone, nodeOriginGone, selectionChanged, nodeGone, closeMenu]);

  // 菜单只作用于一个节点时，让这个节点在菜单打开期间保持悬停外观。
  useEffect(() => {
    if (menu?.request.scope !== "node") return;
    contextMenuNode.set({ nodeId: menu.request.nodeId });
    return () => contextMenuNode.set({ nodeId: undefined });
  }, [menu]);

  let popup: ReactNode = null;
  if (menu) {
    const { request } = menu;
    const anchor = { kind: "point", x: menu.at.x, y: menu.at.y } as const;
    if (request.scope === "node" && nodeOriginKey !== undefined) {
      const entries = originMenuEntries({ key: nodeOriginKey, sessions: Object.values(sessions), collapsed: collapsedOrigins, t, announce: setAnnouncement, archiveSupported });
      if (entries) {
        popup = <MenuPopup key={menu.seq} entries={entries} label={t("origin.menu")} anchor={anchor} onClose={(restore) => closeMenu(menu, restore)} />;
      }
    } else if (request.scope === "node") {
      const summary = nodeSessionId === undefined ? undefined : sessions[nodeSessionId];
      if (summary) {
        popup = <MenuPopup key={menu.seq} entries={nodeMenuItems(summary, t)} label={t("node.menu")} anchor={anchor} onClose={(restore) => closeMenu(menu, restore)} />;
      }
    } else {
      const picked: SessionSummary[] = [];
      for (const id of request.ids) {
        const sessionId = sessionIdOfNode(id);
        const summary = sessionId === undefined ? undefined : sessions[sessionId];
        if (summary) picked.push(summary);
      }
      popup = (
        <MenuPopup
          key={menu.seq}
          entries={selectionMenuEntries({ engine, count: request.ids.length, sessions: picked, canUndo, canRedo, t, announce: setAnnouncement, archiveSupported })}
          label={t("scene.selected", { n: request.ids.length })}
          anchor={anchor}
          onClose={(restore) => closeMenu(menu, restore)}
        />
      );
    }
  }

  return (
    <>
      {popup}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
