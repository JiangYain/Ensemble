import { useEffect, useRef } from "react";
import { selectWorkspace, store, toast, type Route } from "./app";
import { useT } from "./useT";
import { resolveWorkspace, workspaceDisplayTitle, type WorkspaceItem, type WorkspaceScope } from "./workspaces";

/**
 * 正看着的 Main Agent 空间被归档清空时（自己归档整个空间、批量归档、别处发起的归档、留存清扫都一样）怎么办。
 *
 * 空间是从未归档的会话里算出来的（buildWorkspaces），所以它名下的会话全归档之后，这个空间就从侧栏里消失了。
 * 概览本来就会用 resolveWorkspace 把画面回退到别的空间，但有两处不对劲：
 * · 地址栏还停在 `#/m/<已经没有的空间>`，刷新、后退、复制链接都指向一个看不到的地方；
 *   而且恰好是最后一个空间时，resolveWorkspace 的“快照还没到就保留直链”规则会让画面停在一块空空的、属于已消失空间的画布上。
 * · 画面毫无征兆地换了一个空间，用户不知道发生了什么、东西去了哪里。
 * 所以这里只做两件事：用同一套回退规则（上次看的空间 → 排第一的空间 → 全部空间）改写地址，并在确有归档记录时用一条提示说明去向。
 *
 * 只有“看着它、它又从有变无”才算被清空：直链打开一个本来就不存在的空间（过期的书签）沿用原来的静默回退，不弹提示。
 * 提示只在确实能找到这个空间的已归档会话时才说“已全部归档”——会话是被删除的（而不是归档），这句话就是假的。
 * 已归档的会话没读全也不影响：归档时服务端推过来的摘要会进已归档表（lib/app.routeSummary），所以刚归档的会话一定在里面。
 */
export function useEmptiedSpace(route: Route, scope: WorkspaceScope, workspaces: readonly WorkspaceItem[], ready: boolean): void {
  const t = useT();
  // 上一次看见这个空间时的样子（key 与显示名）：空间一旦消失，名字就再也算不出来了，提示要用它。
  const seen = useRef<{ key: string; title: string } | undefined>(undefined);

  useEffect(() => {
    // 快照到达之前什么都不认定：空的 workspaces 不代表“被清空”。
    if (!ready) return;
    // 只有概览页上的某个 Main Agent 空间才有“被清空”这回事；聚焦页、“已归档”视图、全部空间、进行中都不涉及。
    if (route.kind !== "overview" || scope.kind !== "origin") {
      seen.current = undefined;
      return;
    }
    const item = workspaces.find((candidate) => candidate.key === scope.key);
    if (item) {
      seen.current = { key: item.key, title: workspaceDisplayTitle(item, t) };
      return;
    }
    const gone = seen.current;
    seen.current = undefined;
    if (!gone || gone.key !== scope.key) return;

    const state = store.get();
    const target = resolveWorkspace(undefined, state.lastWorkspace, workspaces);
    selectWorkspace(target);

    const archivedHere = Object.values(state.archived).some((session) => session.origin.key === gone.key);
    if (!archivedHere) return;
    const targetItem = target.kind === "origin" ? workspaces.find((candidate) => candidate.key === target.key) : undefined;
    const targetName = targetItem ? workspaceDisplayTitle(targetItem, t) : target.kind === "active" ? t("rail.active") : t("rail.all");
    toast("info", t("archive.spaceGone", { name: gone.title, target: targetName }), 6000);
  }, [ready, route, scope, workspaces, t]);
}
