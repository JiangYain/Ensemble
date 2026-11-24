import { NODE } from "./layout-geometry";

/**
 * 格点排布的尺寸（规划式排布，见 `LayoutOptions.grid`）。画布上的卡片都落在同一张格子里：
 * 第 c 列的左缘是 `c × pitchX`，第 r 行的上缘是 `r × pitchY`；相邻两列、相邻两行之间的空白处处相同（`gapX`、`gapY`）。
 * 规划只在整数的列数与行数上做，换算成像素只在最后一步——所以任何两张卡之间的间距都是同一个数的整数倍。
 * 来源卡、Folder 卡、Git 卡比会话卡窄，贴着所在格子的左缘。
 */
export interface Cells {
  agentW: number;
  originW: number;
  /** 一格的宽、高：卡片加上它与下一格之间的空白。 */
  pitchX: number;
  pitchY: number;
  gapX: number;
  gapY: number;
}

/**
 * 相邻两列之间的空白。父会话与它的子会话也隔这一列，所以要给管线留出看得见的一段（ROUTE.enterSide 是 24）；
 * 再宽就是在拿缩放换空白，32 比 24 只多 3% 的宽度。紧凑模式（宿主侧栏）一格也要省，取管线能走侧面的下限。
 */
const GAP_X = 32;
const GAP_X_COMPACT = 24;
/** 紧凑模式的行距：窄而高的侧栏里竖直方向最紧，沿用原来网格形态的 16（会话之间不画横向的线，不需要更多）。 */
const GAP_Y_COMPACT = 16;

export function cellsFor(compact: boolean): Cells {
  const agentW = compact ? NODE.agentWCompact : NODE.agentW;
  const originW = compact ? NODE.originWCompact : NODE.originW;
  const gapX = compact ? GAP_X_COMPACT : GAP_X;
  const gapY = compact ? GAP_Y_COMPACT : NODE.rowGap;
  return { agentW, originW, gapX, gapY, pitchX: agentW + gapX, pitchY: NODE.agentH + gapY };
}

/** cols 列占的宽度（像素）：最后一列后面没有空白。 */
export const spanX = (cells: Cells, cols: number): number => cols * cells.pitchX - cells.gapX;
/** rows 行占的高度（像素）。 */
export const spanY = (cells: Cells, rows: number): number => rows * cells.pitchY - cells.gapY;

/**
 * 来源块与来源块之间空几格。0 是紧挨着：块之间的间距与块内相同，靠来源卡、连线与 Folder / Git 卡分开；
 * 空一格会让多来源的画布整体放大一圈（缩放小一截），所以默认不空。
 * `rows`：竖直叠放的来源块之间；`cols`：并排的两列之间。
 */
export const GUTTER = { rows: 0, cols: 0 } as const;
