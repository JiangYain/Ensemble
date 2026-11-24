import type { ReactNode } from "react";
import { useT } from "../lib/useT";
import { pipePath } from "../scene/pipes";
import { HarnessMark } from "./HarnessMark";

/** 真实画布的缩影：来源卡与会话卡同高（见 scene/layout.ts 的 NODE），两张会话卡之间留一个行距。 */
const GHOST = { w: 456, h: 156, originW: 156, originH: 66, agentW: 196, agentH: 66 };

/** 画布为空时的引导：一幅“虚线版”的委派关系图，加一句话说明委派从哪里发起。 */
export function EmptyScene(): ReactNode {
  const t = useT();
  const originY = (GHOST.h - GHOST.originH) / 2;
  const a = { x: GHOST.originW, y: originY + GHOST.originH / 2 };
  const agentX = GHOST.w - GHOST.agentW;
  const top = { x: agentX, y: GHOST.agentH / 2 };
  const bottom = { x: agentX, y: GHOST.h - GHOST.agentH / 2 };
  const paths = [pipePath(a, top), pipePath(a, bottom)];

  return (
    <div className="empty" data-scene-ui>
      <div className="ghost" style={{ width: GHOST.w, height: GHOST.h }} aria-hidden="true">
        <svg width={GHOST.w} height={GHOST.h}>
          {paths.map((d, index) => (
            <path key={index} className="pipe-tube" data-phase="idle" d={d} fill="none" />
          ))}
        </svg>
        <div className="ghost-node ghost-origin" style={{ left: 0, top: originY, width: GHOST.originW, height: GHOST.originH }}>
          <span className="ghost-mark">
            <HarnessMark harness="codex" size={18} variant="bare" />
          </span>
          <span className="ghost-lines">
            <i style={{ width: "64%" }} />
            <i style={{ width: "40%" }} />
          </span>
        </div>
        {(
          [
            ["cursor", 0],
            ["pi", GHOST.h - GHOST.agentH],
          ] as const
        ).map(([harness, y]) => (
          <div key={harness} className="ghost-node ghost-agent" style={{ left: agentX, top: y, width: GHOST.agentW, height: GHOST.agentH }}>
            <span className="ghost-mark">
              <HarnessMark harness={harness} size={30} />
            </span>
            <span className="ghost-lines">
              <i style={{ width: "72%" }} />
              <i style={{ width: "46%" }} />
            </span>
          </div>
        ))}
      </div>

      <h2 className="empty-title">{t("empty.title")}</h2>
      <p className="empty-sub">{t("empty.sub")}</p>
    </div>
  );
}
