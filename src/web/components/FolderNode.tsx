import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { folderName, parentPath, type FolderGroup } from "../lib/folder";
import { useT } from "../lib/useT";
import { folderNodeId } from "../scene/layout";
import type { SceneEngine } from "../scene/engine";
import { Icon } from "./Icons";
import { nodeKeyHandler } from "./nodeKeys";

/** 头部图标的大小：线性图标比品牌标的墨迹小，与来源卡头部的线性宿主图标（控制台、终端）同样放大 1.2 倍（12 × 1.2），见 HostMark 的 fit。 */
const HEAD_ICON = 14.4;

export interface FolderNodeProps {
  /** 这张卡对应的真实目录，和用它当工作目录的来源（见 lib/folder 的 groupFolders）。 */
  folder: FolderGroup;
  engine: SceneEngine;
}

/**
 * Folder 卡片：来源（Main Agent）自己带着的工作目录，接在来源节点左边；同一个真实目录只有一张卡，
 * 用它的每个来源各有一条连线。内容全部来自来源已经带着的 `workspace` 字符串，不读文件系统，也不说这个目录“存在”还是“不存在”：
 * 主行是目录名，次行是它的上级路径（放不下时省略在开头，留下最靠近这个目录的几级；完整路径在悬停提示里）。头部是身份（文件夹），
 * 右端只在不止一个 Main Agent 用它时才有“N 个 Main Agent”——只有一个时数字没有信息量，不画。
 * 没有的东西不画：根目录没有上级路径就没有次行。
 * 头部复用来源卡的 `.o-head`，版式与来源卡、Git 卡共用同一套基准（见 styles/scene.css 里 `.o-head` 之后的注释）。
 */
export const FolderNode = memo(function FolderNode({ folder, engine }: FolderNodeProps): ReactNode {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const id = folderNodeId(folder.key);

  useLayoutEffect(() => {
    const el = ref.current;
    return el ? engine.register(id, el) : undefined;
  }, [engine, id]);
  const onKeyDown = useMemo(() => nodeKeyHandler(engine, id), [engine, id]);

  const name = folderName(folder.path);
  const parent = parentPath(folder.path);
  const count = folder.origins.length;
  const tip = [t("folder.tipHead"), `${t("folder.path")}: ${folder.path}`, count > 1 ? t("folder.usedBy", { n: count }) : undefined].filter(Boolean).join("\n");

  return (
    <div ref={ref} className="node folder" data-node data-node-id={id} data-tip={tip}
      tabIndex={0} role="group" aria-label={t("folder.label", { name })} aria-description={t("folder.keyboard")}
      onKeyDown={onKeyDown}>
      <header className="o-head">
        <span className="a-mark">
          <Icon name="folder" size={HEAD_ICON} />
        </span>
        <span className="o-label">{t("folder.head")}</span>
        {count > 1 ? (
          <span className="o-count" data-tip={t("folder.usedBy", { n: count })}>
            {t("folder.count", { n: count })}
          </span>
        ) : null}
      </header>

      <div className="o-body">
        <div className="o-main">
          <Icon name="folder" size={13} className="o-ico" />
          <span className="o-text">{name}</span>
        </div>
        {parent ? (
          <span className="o-sub">
            <bdi dir="ltr">{parent}</bdi>
          </span>
        ) : null}
      </div>
    </div>
  );
});
