import { writeNode, type Body } from "./engine-body";

const STIFFNESS = 240;
const DAMPING = 27;
const EPS = 0.04;

/**
 * 用户是否要求减少动效（系统设置）：挂载时读一次并开始监听，之后以最近一次的结果为准。
 * 卸载只摘掉监听，不清掉最近一次的结果。
 */
export class MotionPreference {
  private media: MediaQueryList | undefined;
  private matches = false;

  get reduced(): boolean {
    return this.matches;
  }

  attach(): void {
    this.media = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.matches = this.media.matches;
    this.media.addEventListener("change", this.onChange);
  }

  detach(): void {
    this.media?.removeEventListener("change", this.onChange);
  }

  private readonly onChange = (): void => {
    this.matches = this.media?.matches ?? false;
  };
}

/** 节点的弹簧走一帧（`steps` 个子步，每步 `h` 秒）；返回是否还有节点没落定。减少动效时节点直接落到目标。 */
function stepBodies(bodies: ReadonlyMap<string, Body>, reducedMotion: boolean, steps: number, h: number): boolean {
  let moving = false;
  for (const body of bodies.values()) {
    if (!body.placed) continue;
    if (reducedMotion) {
      body.x = body.tx;
      body.y = body.ty;
      body.vx = 0;
      body.vy = 0;
    }
    for (let i = 0; i < steps; i++) {
      body.vx += (-STIFFNESS * (body.x - body.tx) - DAMPING * body.vx) * h;
      body.vy += (-STIFFNESS * (body.y - body.ty) - DAMPING * body.vy) * h;
      body.x += body.vx * h;
      body.y += body.vy * h;
    }
    if (Math.abs(body.x - body.tx) < EPS && Math.abs(body.y - body.ty) < EPS && Math.abs(body.vx) < EPS && Math.abs(body.vy) < EPS) {
      body.x = body.tx;
      body.y = body.ty;
      body.vx = 0;
      body.vy = 0;
    } else {
      moving = true;
    }
    writeNode(body);
  }
  return moving;
}

/** 帧循环向引擎问的几件事（帧循环不认识引擎本身）。 */
export interface FrameHost {
  readonly bodies: ReadonlyMap<string, Body>;
  /** 已经挂载：没挂载时不排帧。 */
  mounted(): boolean;
  reducedMotion(): boolean;
  /** 正在拖动节点或画布：相机不走弹簧。 */
  holding(): boolean;
  /** 相机的弹簧走一帧，返回相机是否还没落定。 */
  stepCamera(steps: number, h: number): boolean;
  /** 连线跟着节点此刻的位置重算，返回是否还有连线停在换边的过渡里。 */
  pipes(now: number): boolean;
}

/** 帧循环：只在有东西在动（节点、相机或连线的过渡）时排下一帧，都落定了就停。 */
export class FrameLoop {
  private raf = 0;
  private last = 0;

  constructor(private readonly host: FrameHost) {}

  wake(): void {
    if (this.raf || !this.host.mounted()) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  cancel(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;

    let moving = stepBodies(this.host.bodies, this.host.reducedMotion(), steps, h);
    if (!this.host.holding() && this.host.stepCamera(steps, h)) moving = true;

    const morphing = this.host.pipes(now);
    if (moving || morphing) this.raf = requestAnimationFrame(this.frame);
  };
}
