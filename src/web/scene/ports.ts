import type { LayoutEdge } from "./layout";
import { DOWN, LEFT, RIGHT, UP, type Side } from "./pipes";

/** 一条边上端口方点的状态：undefined 是没有连线接着（熄灭）；否则是接着的连线里最活跃的那条的阶段，方点按它着色。 */
export type PortPhase = LayoutEdge["phase"] | undefined;
/** 四条边的状态，下标是 Side 的值。 */
export type PortPhases = [PortPhase, PortPhase, PortPhase, PortPhase];

/** `data-side` 的取值，下标是 Side 的值。 */
const NAMES = ["right", "bottom", "left", "top"] as const;

const fmt = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * 一个节点四条边上的端口方点：连线接在哪一边，那一边的落点上就有一个；一条连线也不接的边没有（隐藏）。
 *
 * 方点是放进节点元素里的小元素 `<i class="node-port">`：节点自己的 ::before / ::after 只有两个，不够四条边用。
 * 位置（`--port-x` / `--port-y`，相对节点左上角）、显隐（`data-on`）和颜色（`data-phase`）都交给样式表
 * （scene.css 的 `.node-port`）去画。落点与连线的端点取自同一组数（pipes.ts 的 portX / portY），所以两者不会错开。
 *
 * 位置只在布局变了才写，显隐与颜色只在变了才写：逐帧调用 apply 时不会碰 DOM。
 */
export class NodePorts {
  readonly host: HTMLElement;
  private readonly dots: readonly [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
  private readonly px: [number, number, number, number] = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  private readonly py: [number, number, number, number] = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  private readonly on: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private readonly phase: [string, string, string, string] = ["", "", "", ""];

  constructor(host: HTMLElement) {
    this.host = host;
    const make = (side: Side): HTMLElement => {
      const dot = host.ownerDocument.createElement("i");
      dot.className = "node-port";
      dot.setAttribute("data-side", NAMES[side]);
      dot.setAttribute("aria-hidden", "true");
      host.appendChild(dot);
      return dot;
    };
    this.dots = [make(RIGHT), make(DOWN), make(LEFT), make(UP)];
  }

  /** 这一边的落点（相对节点左上角）。 */
  place(side: Side, x: number, y: number): void {
    if (this.px[side] === x && this.py[side] === y) return;
    this.px[side] = x;
    this.py[side] = y;
    const style = this.dots[side].style;
    style.setProperty("--port-x", `${fmt(x)}px`);
    style.setProperty("--port-y", `${fmt(y)}px`);
  }

  /**
   * 按每条边的状态点亮或熄灭方点：有连线接着（不是 undefined）的点亮，颜色取接着的连线里最活跃的那条的阶段。
   * 熄灭时保留颜色，让它带着原来的颜色淡出。
   */
  apply(phases: Readonly<PortPhases>): void {
    this.set(RIGHT, phases[RIGHT]);
    this.set(DOWN, phases[DOWN]);
    this.set(LEFT, phases[LEFT]);
    this.set(UP, phases[UP]);
  }

  /** 全部熄灭（连线都被拆掉的时候）。 */
  reset(): void {
    this.set(RIGHT, undefined);
    this.set(DOWN, undefined);
    this.set(LEFT, undefined);
    this.set(UP, undefined);
  }

  /** 节点元素卸载时把方点一并拿走。 */
  dispose(): void {
    for (const dot of this.dots) dot.remove();
  }

  private set(side: Side, phase: PortPhase): void {
    const dot = this.dots[side];
    const on = phase !== undefined;
    if (on !== this.on[side]) {
      this.on[side] = on;
      if (on) dot.setAttribute("data-on", "");
      else dot.removeAttribute("data-on");
    }
    if (phase !== undefined && phase !== this.phase[side]) {
      this.phase[side] = phase;
      dot.setAttribute("data-phase", phase);
    }
  }
}
