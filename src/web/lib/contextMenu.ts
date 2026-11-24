import { Store, useStore } from "./store";

/**
 * 画布上正在为哪个节点打开右键菜单（只记“菜单只作用于这一个节点”的那种）。
 * 会话节点据此在菜单打开期间保持悬停外观，与头部“···”菜单打开时一样；多选菜单的对象由“已选中”的外观表达，不记在这里。
 */
export const contextMenuNode = new Store<{ nodeId: string | undefined }>({ nodeId: undefined });

export function useContextMenuOpen(nodeId: string): boolean {
  return useStore(contextMenuNode, (state) => state.nodeId === nodeId);
}
