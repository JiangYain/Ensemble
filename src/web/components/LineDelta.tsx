import type { ReactNode } from "react";
import type { ShownDelta } from "../lib/diffstat";

/** 文件变更的“+新增 −删除”：只画 shownDelta 给出的那几侧（颜色与间距在 timeline.css 的 .file-stat / i[data-sign]）。 */
export function LineDelta({ delta }: { delta: ShownDelta }): ReactNode {
  return (
    <>
      {delta.added !== undefined ? <i data-sign="add">+{delta.added}</i> : null}
      {delta.removed !== undefined ? <i data-sign="del">−{delta.removed}</i> : null}
    </>
  );
}
