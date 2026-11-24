/**
 * 连线：从来源节点的一侧出发，平滑进入目标节点的对侧。默认是从左到右（来源右缘 → 目标左缘）；
 * 节点被拖到别处之后，按两端此刻的相对位置改走左右镜像或上下的边（见 chooseSide），始终是一条短而平缓的 S 形，不绕环。
 */
export interface Point {
  x: number;
  y: number;
}

export const PIPE = {
  /** 管线上流动的点列间距（沿路径，px）。 */
  packetPeriods: [167, 233],
  /** 小包的移动速度（px/s）。 */
  speed: 44,
  /** 静止细点格的间距（参考里约 4.1px）；小包的“尾巴”就落在上一格。 */
  finePeriod: 4.1,
} as const;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function fmt(value: number): string {
  return round(value).toString();
}

/**
 * 水平的 S 形：从 a 出发，朝 b 所在的一侧平滑进入 b。b 在 a 右边是默认的从左到右（出线在来源右缘、进线在目标左缘），
 * 在左边就是它的左右镜像。两种都是单调的：曲线始终落在 a、b 之间的竖带里，不会绕到两端节点的后面，也不会有环。
 */
export function pipePath(a: Point, b: Point): string {
  const dx = b.x - a.x;
  const handle = Math.abs(dx) / 2;
  const sign = dx < 0 ? -1 : 1;
  return `M${fmt(a.x)} ${fmt(a.y)}C${fmt(a.x + sign * handle)} ${fmt(a.y)} ${fmt(b.x - sign * handle)} ${fmt(b.y)} ${fmt(b.x)} ${fmt(b.y)}`;
}

// ───────────────────────── 选边与曲线 ─────────────────────────

/**
 * 连线接在节点的哪一边。出线从来源的 side 出去，进线从目标的对侧（opposite）进来，所以一条连线只需要记一个 side。
 * 取值同时是出线的方向：0 向右、1 向下、2 向左、3 向上。
 */
export const RIGHT = 0;
export const DOWN = 1;
export const LEFT = 2;
export const UP = 3;
export type Side = 0 | 1 | 2 | 3;

export function opposite(side: Side): Side {
  return ((side + 2) % 4) as Side;
}

/**
 * 节点在连线眼里的样子：矩形。连线接在四条边的中点（见 portX / portY），所以只需要位置与尺寸。
 * 引擎的节点（Body）直接满足这个形状，逐帧传进来不需要分配对象。
 */
export interface PipeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 落点（四条边的中点）相对节点左上角的位置。方点（ports.ts）与曲线的端点都取自这里，两边不会对不上。 */
export function portX(box: PipeBox, side: Side): number {
  return side === RIGHT ? box.w : side === LEFT ? 0 : box.w / 2;
}

export function portY(box: PipeBox, side: Side): number {
  return side === RIGHT || side === LEFT ? box.h / 2 : side === DOWN ? box.h : 0;
}

/**
 * 选边的规则与门槛（世界坐标，px）。
 *
 * 一条连线有四种走法（见 Side）。“空隙”是这种走法下两个落点在出线方向上的距离，也就是 S 形的行程：
 * 空隙为正，曲线就落在两个落点之间的带子里，碰不到两端的节点；空隙为负，两个节点在这个方向上是叠着的。
 *
 *   1. 横向优先：目标在来源右边（空隙够宽）走 RIGHT，在左边走 LEFT；默认布局全在这一档，与以前逐字节相同；
 *   2. 横向没有空隙（水平范围重叠，目标在上方或下方）走 DOWN / UP，接在上下边的中点：行程最短、曲率最小；
 *   3. 四个方向都没有空隙（两个节点叠在一起）：保持原来的走法，不跟着乱翻；第一次就走 RIGHT。
 *
 * 为什么不用“同侧的 C 形”：C 形要先伸出去再绕回来，必须额外留出绕行的余地，很容易又变成大环；
 * 上下边的 S 形与横向的是同一种曲线，只是转了 90°。
 *
 * 每一档都有“进入”和“离开”两个门槛，离开的比进入的低：节点刚好停在门槛附近抖动，连线不会来回翻。
 */
export const ROUTE = {
  /** 横向：空隙达到这个宽度才改走（或回到）左右边。必须低于默认布局里最窄的空隙 28（窄画布里来源到会话）。 */
  enterSide: 24,
  /** 已经走着左右边的，空隙缩到这个宽度以下才放弃。与进入门槛之间的 18 是滞回带。 */
  leaveSide: 6,
  /** 纵向：同理。 */
  enterStack: 16,
  leaveStack: 4,
  /** 换边时，曲线从旧的形状过渡到新的形状用的时间（秒）。 */
  morph: 0.24,
} as const;

/** 某种走法的空隙，也是 routeCurve 里 S 形的行程。 */
export function gapOf(s: PipeBox, t: PipeBox, side: Side): number {
  switch (side) {
    case RIGHT:
      return t.x - (s.x + s.w);
    case LEFT:
      return s.x - (t.x + t.w);
    case DOWN:
      return t.y - (s.y + s.h);
    default:
      return s.y - (t.y + t.h);
  }
}

/**
 * 给一条连线选边。prev 是它上一次的走法（还没有就传 -1）：滞回靠它，所以必须传，不传就等于没有滞回。
 * 位置有 NaN 或无穷时没法判断，原样保持。
 */
export function chooseSide(prev: number, s: PipeBox, t: PipeBox): Side {
  const right = gapOf(s, t, RIGHT);
  const left = gapOf(s, t, LEFT);
  const down = gapOf(s, t, DOWN);
  const up = gapOf(s, t, UP);
  if (!Number.isFinite(right + left + down + up)) return prev === LEFT || prev === DOWN || prev === UP ? prev : RIGHT;

  // 1. 横向。已经在走的，空隙收窄到离开门槛以下才放弃；没走的，要到进入门槛才改走。
  if (prev === RIGHT && right >= ROUTE.leaveSide) return RIGHT;
  if (prev === LEFT && left >= ROUTE.leaveSide) return LEFT;
  if (right >= ROUTE.enterSide) return RIGHT;
  if (left >= ROUTE.enterSide) return LEFT;
  // 2. 纵向，同样有进入与离开两个门槛；横向合格时轮不到它。
  if (prev === DOWN && down >= ROUTE.leaveStack) return DOWN;
  if (prev === UP && up >= ROUTE.leaveStack) return UP;
  if (down >= ROUTE.enterStack) return DOWN;
  if (up >= ROUTE.enterStack) return UP;
  // 3. 没有哪个方向的空隙够：取空隙最大的（并列时横向优先）；全都不为正就是两个节点叠在一起，保持原样。
  let best: Side = RIGHT;
  let gap = right;
  if (left > gap) {
    best = LEFT;
    gap = left;
  }
  if (down > gap) {
    best = DOWN;
    gap = down;
  }
  if (up > gap) {
    best = UP;
    gap = up;
  }
  if (gap > 0) return best;
  return prev === LEFT || prev === DOWN || prev === UP ? prev : RIGHT;
}

/** 一段三次贝塞尔：起点 (x0, y0)、两个控制点、终点 (x3, y3)。对象可以反复复用，逐帧计算不分配。 */
export class Curve {
  x0 = 0;
  y0 = 0;
  x1 = 0;
  y1 = 0;
  x2 = 0;
  y2 = 0;
  x3 = 0;
  y3 = 0;
}

/**
 * 从来源 s 的 side 边到目标 t 的对边的 S 形：两个控制点沿出线方向各让出行程的一半，
 * 所以曲线在这个方向上单调，两端都垂直于各自的边。默认的 RIGHT 与旧版的算法逐位相同。
 * 行程不为正（两个节点叠着）时把控制点收回端点：一条直线，不会向外探出再绕回来。
 */
export function routeCurve(s: PipeBox, t: PipeBox, side: Side, out: Curve): Curve {
  const into = opposite(side);
  const x0 = s.x + portX(s, side);
  const y0 = s.y + portY(s, side);
  const x3 = t.x + portX(t, into);
  const y3 = t.y + portY(t, into);
  const reach = gapOf(s, t, side);
  const handle = reach > 0 ? reach / 2 : 0;
  const ux = side === RIGHT ? 1 : side === LEFT ? -1 : 0;
  const uy = side === DOWN ? 1 : side === UP ? -1 : 0;
  out.x0 = x0;
  out.y0 = y0;
  out.x1 = x0 + ux * handle;
  out.y1 = y0 + uy * handle;
  out.x2 = x3 - ux * handle;
  out.y2 = y3 - uy * handle;
  out.x3 = x3;
  out.y3 = y3;
  return out;
}

export function copyCurve(from: Curve, to: Curve): Curve {
  to.x0 = from.x0;
  to.y0 = from.y0;
  to.x1 = from.x1;
  to.y1 = from.y1;
  to.x2 = from.x2;
  to.y2 = from.y2;
  to.x3 = from.x3;
  to.y3 = from.y3;
  return to;
}

/** 两段曲线逐个数相等（含 NaN 不等于任何东西：从没画过的曲线记成 NaN，第一次一定会画）。 */
export function sameCurve(a: Curve, b: Curve): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2 && a.x3 === b.x3 && a.y3 === b.y3;
}

export function curvePath(c: Curve): string {
  return `M${fmt(c.x0)} ${fmt(c.y0)}C${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x2)} ${fmt(c.y2)} ${fmt(c.x3)} ${fmt(c.y3)}`;
}

/**
 * 把一段曲线记成“跟着两端节点”的形式：起点与第一个控制点相对来源，第二个控制点与终点相对目标。
 * 换边的过渡从它出发：过渡期间节点还在被拖、被弹簧带着走，曲线的两端始终贴着各自的节点。
 */
export function pinCurve(c: Curve, s: PipeBox, t: PipeBox, out: Curve): Curve {
  out.x0 = c.x0 - s.x;
  out.y0 = c.y0 - s.y;
  out.x1 = c.x1 - s.x;
  out.y1 = c.y1 - s.y;
  out.x2 = c.x2 - t.x;
  out.y2 = c.y2 - t.y;
  out.x3 = c.x3 - t.x;
  out.y3 = c.y3 - t.y;
  return out;
}

/** pinCurve 记下的形状（此刻落在 s、t 身上的位置）与 to 之间，按 k（0..1）混合。 */
export function mixCurve(pinned: Curve, to: Curve, k: number, s: PipeBox, t: PipeBox, out: Curve): Curve {
  const j = 1 - k;
  out.x0 = (s.x + pinned.x0) * j + to.x0 * k;
  out.y0 = (s.y + pinned.y0) * j + to.y0 * k;
  out.x1 = (s.x + pinned.x1) * j + to.x1 * k;
  out.y1 = (s.y + pinned.y1) * j + to.y1 * k;
  out.x2 = (t.x + pinned.x2) * j + to.x2 * k;
  out.y2 = (t.y + pinned.y2) * j + to.y2 * k;
  out.x3 = (t.x + pinned.x3) * j + to.x3 * k;
  out.y3 = (t.y + pinned.y3) * j + to.y3 * k;
  return out;
}

/** 起止都缓、中间快：换边的过渡看起来是“滑过去”，而不是平移。 */
export function ease(k: number): number {
  return k * k * (3 - 2 * k);
}

const SVG_NS = "http://www.w3.org/2000/svg";

export interface PipeGroups {
  tube: SVGGElement;
  dots: SVGGElement;
}

export interface PipeElements {
  tube: SVGPathElement;
  /** 静止的细点格。 */
  fine: SVGPathElement;
  /** 小包列：[头 0, 尾 0, 头 1, 尾 1, …]，同一列的头和尾间距 finePeriod。 */
  packets: SVGPathElement[];
  /** 点的颜色：沿管线从来源端到执行端的渐变。 */
  gradient: SVGLinearGradientElement;
  /** 最近一次写进 DOM 的路径与渐变端点（取整后）。没变就不再碰 DOM：弹簧与拖动时每帧都会重算所有连线，大多数其实没动。 */
  written: { tube: string; dots: string; x1: number; y1: number; x2: number; y2: number };
}

let gradientCounter = 0;

/** 流动点在连线两端淡出。 */
const GRADIENT_STOPS: ReadonlyArray<readonly [offset: number, opacity: number]> = [
  [0, 0.15],
  [0.1, 1],
  [0.3, 1],
  [0.5, 1],
  [0.7, 1],
  [0.9, 1],
  [1, 0.2],
];

export function createPipeElements(groups: PipeGroups): PipeElements {
  const make = (className: string, parent: SVGGElement, style?: string): SVGPathElement => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", className);
    path.setAttribute("fill", "none");
    if (style) path.setAttribute("style", style);
    parent.appendChild(path);
    return path;
  };

  const id = `pipe-flow-${(gradientCounter += 1)}`;
  const gradient = document.createElementNS(SVG_NS, "linearGradient");
  gradient.setAttribute("id", id);
  gradient.setAttribute("gradientUnits", "userSpaceOnUse");
  for (const [offset, opacity] of GRADIENT_STOPS) {
    const stop = document.createElementNS(SVG_NS, "stop");
    stop.setAttribute("offset", String(offset));
    stop.setAttribute("stop-color", "#d94632");
    stop.setAttribute("stop-opacity", String(opacity));
    gradient.appendChild(stop);
  }
  groups.dots.appendChild(gradient);

  const flow = `--flow:url(#${id});`;
  const lag = PIPE.finePeriod / PIPE.speed;
  const tube = make("pipe-tube", groups.tube);
  const fine = make("pipe-fine", groups.dots, flow);
  const packets: SVGPathElement[] = [];
  PIPE.packetPeriods.forEach((period, index) => {
    const style = `${flow}--period:${period};--dur:${(period / PIPE.speed).toFixed(2)}s;--phase:${(-(index * 0.83 + 0.4)).toFixed(2)}s;`;
    packets.push(make("pipe-packet head", groups.dots, style));
    packets.push(make("pipe-packet tail", groups.dots, `${style}--lag:${lag.toFixed(3)}s;`));
  });
  return { tube, fine, packets, gradient, written: { tube: "", dots: "", x1: Number.NaN, y1: Number.NaN, x2: Number.NaN, y2: Number.NaN } };
}

/** tube 是管壁的路径；dots 是点用的路径（默认与管壁相同）。 */
export function setPipe(elements: PipeElements, tube: string, dots: string = tube): void {
  const written = elements.written;
  if (written.tube !== tube) {
    written.tube = tube;
    elements.tube.setAttribute("d", tube);
  }
  if (written.dots !== dots) {
    written.dots = dots;
    elements.fine.setAttribute("d", dots);
    for (const packet of elements.packets) packet.setAttribute("d", dots);
  }
}

/** 渐变的方向跟着来源端 → 目标端的连线走：向左的连线里，流动的点也是自然地向左流。 */
export function setPipeFlow(elements: PipeElements, x1: number, y1: number, x2: number, y2: number): void {
  const written = elements.written;
  const a = round(x1);
  const b = round(y1);
  const c = round(x2);
  const d = round(y2);
  if (a === written.x1 && b === written.y1 && c === written.x2 && d === written.y2) return;
  written.x1 = a;
  written.y1 = b;
  written.x2 = c;
  written.y2 = d;
  const g = elements.gradient;
  g.setAttribute("x1", String(a));
  g.setAttribute("y1", String(b));
  g.setAttribute("x2", String(c));
  g.setAttribute("y2", String(d));
}

export function setPipePhase(elements: PipeElements, phase: string): void {
  elements.tube.setAttribute("data-phase", phase);
  elements.fine.setAttribute("data-phase", phase);
  for (const packet of elements.packets) packet.setAttribute("data-phase", phase);
}

export function removePipe(elements: PipeElements): void {
  elements.tube.remove();
  elements.fine.remove();
  elements.gradient.remove();
  for (const packet of elements.packets) packet.remove();
}

/**
 * 同一处重叠时，越“活跃”的管线越靠上。静止的线之间同色同宽、不透明（见 scene.css 的 `.pipe-tube`），谁压着谁看不出来；
 * 要分清的是活跃的线：来源扇出的一大把静止线再多，运行中、失败的线也压在它们上面。
 */
export function pipePriority(phase: string): number {
  switch (phase) {
    case "running":
      return 4;
    case "failed":
      return 3;
    case "starting":
    case "queued":
      return 2;
    case "done":
      return 1;
    default:
      return 0;
  }
}
