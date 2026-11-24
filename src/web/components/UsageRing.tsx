import { useState, type CSSProperties, type ReactNode } from "react";
import { formatCount } from "@shared/format";
import { shareText, squareRing, squareRingArcs, type UsageBreakdown, type UsagePart, type UsageRole } from "../lib/usage";
import { useT } from "../lib/useT";

const SIZE = 96;
const STROKE = 6;
/** 方环的路径与一周的长度：中心线 6 到 90、外沿 3 到 93、内框 78 见方（sidebar.css 里的 .usage-total 比内框小一圈）。 */
const RING = squareRing(SIZE, STROKE);
/** 相邻两段之间的缺口，和画布里卡片的“缺口”是同一种语言。 */
const GAP = 2;
/** 占比再小的段也至少画这么长，免得 0.2% 的一段看不见。 */
const MIN_ARC = 1.6;

function labelKey(part: UsagePart): string {
  if (part.role === "input") return part.remainder ? "usage.fresh" : "usage.input";
  if (part.role === "output") return part.remainder ? "usage.reply" : "usage.output";
  return `usage.${part.role}`;
}

/**
 * 用量环（方环）：一周是全部 token（输入 + 输出），从上边中点出发，按 缓存命中 / 新输入 / 推理 / 其余输出 顺时针切开，色阶由浅到深。
 * 每一段都是同一条方形路径上的一截虚线：平头、拐角是尖角，缺口不落在拐角上（见 lib/usage.ts 的 clearCorners）。
 * 环只给比例的直觉；精确数字在图例里，完整数字和占比在悬停提示里。图例与环互相联动高亮。
 */
export function UsageRing({ breakdown }: { breakdown: UsageBreakdown }): ReactNode {
  const t = useT();
  const [hot, setHot] = useState<UsageRole | undefined>();
  const arcs = squareRingArcs(
    breakdown.parts.map((part) => part.share),
    RING,
    { gap: GAP, minArc: MIN_ARC },
  );
  const exact = new Intl.NumberFormat();
  const tipOf = (part: UsagePart): string => t("usage.tip", { label: t(labelKey(part)), tokens: exact.format(part.tokens), share: shareText(part.share) });
  const hover = (role: UsageRole) => ({ onPointerEnter: () => setHot(role), onPointerLeave: () => setHot(undefined) });

  return (
    <div className="usage" data-hot={hot}>
      <div className="usage-figure">
        <svg className="usage-ring" viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true" style={{ "--usage-perimeter": RING.length } as CSSProperties}>
          {breakdown.parts.map((part, index) => {
            const arc = arcs[index]!;
            return (
              <path
                key={part.role}
                className="usage-seg"
                data-seg={part.role}
                data-dim={hot !== undefined && hot !== part.role ? "" : undefined}
                data-tip={tipOf(part)}
                d={RING.d}
                fill="none"
                strokeWidth={STROKE}
                style={{ strokeDasharray: `${arc.length} ${RING.length - arc.length}`, strokeDashoffset: -arc.offset }}
                {...hover(part.role)}
              />
            );
          })}
        </svg>
        <div className="usage-total" data-tip={t("usage.totalTip", { tokens: exact.format(breakdown.total) })}>
          <span className="usage-total-value">{formatCount(breakdown.total)}</span>
          <span className="usage-total-label">{t("usage.total")}</span>
        </div>
      </div>
      <ul className="usage-legend">
        {breakdown.parts.map((part) => (
          <li key={part.role} className="usage-row" data-active={hot === part.role ? "" : undefined} data-tip={tipOf(part)} {...hover(part.role)}>
            <span className="usage-swatch" data-seg={part.role} />
            <span className="usage-label">{t(labelKey(part))}</span>
            <span className="usage-value num">{formatCount(part.tokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
