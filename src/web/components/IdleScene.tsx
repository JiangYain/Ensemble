import type { ReactNode } from "react";
import { useT } from "../lib/useT";
import { Icon } from "./Icons";

/**
 * “只看工作中”开着、而眼下没有任何会话在工作时的画布：会话都在，只是被收起了。
 * 它不是 EmptyScene——那是“还没有委派过”的引导，写“新建第一个”会误导；这里只说清楚现状（有几个被收起）并给出恢复显示的出口。
 * 版式沿用 EmptyScene（同一个 `.empty` 容器、标题与按钮），不另起一套视觉语言；没有那幅示意图：这里没有什么需要教的。
 */
export function IdleScene({ hidden, onShowAll }: { hidden: number; onShowAll: () => void }): ReactNode {
  const t = useT();
  return (
    <div className="empty" data-idle data-scene-ui>
      <h2 className="empty-title">{t("idle.title")}</h2>
      <p className="empty-sub">{t("idle.sub", { n: hidden })}</p>
      <div className="empty-actions">
        <button type="button" className="btn btn--primary" onClick={onShowAll}>
          <Icon name="eye" size={15} strokeWidth={2} />
          {t("idle.showAll")}
        </button>
      </div>
    </div>
  );
}
