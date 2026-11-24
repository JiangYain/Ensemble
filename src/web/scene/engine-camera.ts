import type { Camera, MountOptions } from "./engine-types";
import { FIT_ALL_MIN_ZOOM, fitCamera, fitPadding, MIN_ZOOM, type Bounds } from "./layout";

const CAMERA_STIFFNESS = 170;
const CAMERA_DAMPING = 26;
const MAX_ZOOM = 1.6;

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 相机向引擎问的几件事（相机不认识引擎本身）。 */
export interface CameraHost {
  mounted(): MountOptions | undefined;
  /** 布局要求“全部节点入画”：规划式排布放不下 100% 的（layout.fitAll），或排成网格的（layout.grid）。 */
  wide(): boolean;
  /** 已经有一份布局：外框才有意义，容器尺寸变化时才取景。 */
  framed(): boolean;
  reducedMotion(): boolean;
  wake(): void;
  /** 相机的变换写到画布上之后：新到会话的提示要据此重算。 */
  applied(): void;
}

interface SpaceCamera {
  camera: Camera;
  userMoved: boolean;
  cap: number | undefined;
}

/**
 * 相机：当前位置、弹簧要去的目标、取景、用户手动与否，以及各空间记忆的视角。
 * `target` 是对外的那一个相机（“落定后的位置”）：它的对象始终是同一个，别处按引用持有它。
 */
export class CameraRig {
  readonly camera: Camera = { x: 0, y: 0, k: 1 };
  readonly target: Camera = { x: 0, y: 0, k: 1 };
  private velocity = { x: 0, y: 0, k: 0 };
  private bounds: Bounds = { x: 0, y: 0, w: 0, h: 0 };
  private moved = false;
  /** 自动取景（`moved` 为假）时保持的缩放，即点“重置节点布局”那一刻看到的：放不下才缩到刚好放下（layout-geometry.ts 的 holdScale），没有就按布局自己的规则；寿命见 engine.ts 的 `resetLayout`。 */
  private autoCap: number | undefined;
  private observer: ResizeObserver | undefined;
  /** 宿主最近一次听到的缩放与归属（`report()` 靠它省掉没变化的通知）；刚挂载的宿主从 100%、自动取景起步，所以起点是这个，卸载时回到它（见 `detach`）。 */
  private reportedK = 1;
  private reportedMoved = false;
  /** 各空间记忆的相机状态（仅内存，切换 Main Agent 画布时保持独立视角）。 */
  private readonly spaces = new Map<string, SpaceCamera>();

  constructor(private readonly host: CameraHost) {}

  /** 相机是用户动过的：新节点出现、窗口变化都不再自动取景。 */
  get userMoved(): boolean {
    return this.moved;
  }

  /** 全部节点正在走向的位置围成的外框（取景用）。 */
  setBounds(bounds: Bounds): void {
    this.bounds = bounds;
  }

  /** 从此相机归用户。 */
  claim(): void {
    this.moved = true;
  }

  /** 相机回到自动取景，并带着保持缩放的上限（见 `autoCap`）。 */
  release(cap: number): void {
    this.moved = false;
    this.autoCap = cap;
  }

  /** 回到自动取景（并恢复“新节点出现时自动取景”的行为）。显式的“适应”也释放重置时保持的缩放上限：用户要的就是按内容取景。 */
  fit(animate = true, fitAll = false): void {
    this.moved = false;
    this.autoCap = undefined;
    this.refit(!animate, fitAll);
  }

  /** 布局变了：相机没被用户动过就重新取景。 */
  follow(immediate: boolean): void {
    if (!this.moved) this.refit(immediate);
  }

  private fitTarget(fitAll = false): Camera {
    const mounted = this.host.mounted();
    const viewport = mounted?.viewport;
    if (!viewport) return { x: 0, y: 0, k: 1 };
    const { clientWidth: w, clientHeight: h } = viewport;
    // 规划式排布放不下 100% 的（layout.fitAll）或排成网格的（layout.grid）按“全部节点入画”取景；重置后有保持缩放的上限（见 resetLayout）时以它为准，`fitAll` 不再起作用。
    const wide = fitAll || this.host.wide();
    return fitCamera(this.bounds, { w, h }, mounted?.padding ?? fitPadding(w), wide, this.autoCap);
  }

  private refit(immediate: boolean, fitAll = false): void {
    Object.assign(this.target, this.fitTarget(fitAll));
    this.settle(immediate);
  }

  /** 相机的目标改好之后的收尾：要求立即到位（或减少动效）就直接落定，否则交给弹簧；再通知并唤醒帧循环。 */
  private settle(immediate: boolean): void {
    if (immediate || this.host.reducedMotion()) {
      Object.assign(this.camera, this.target);
      this.velocity = { x: 0, y: 0, k: 0 };
      this.apply();
    }
    this.report();
    this.host.wake();
  }

  /** 平移相机 (dx, dy) 个屏幕像素（不改缩放），走与适应、缩放同一条弹簧；从此相机归用户，新节点出现不再自动取景。 */
  panBy(dx: number, dy: number): void {
    this.target.x += dx;
    this.target.y += dy;
    this.moved = true;
    this.settle(false);
  }

  zoomBy(factor: number): void {
    const viewport = this.host.mounted()?.viewport;
    if (!viewport) return;
    this.zoomAround(viewport.clientWidth / 2, viewport.clientHeight / 2, factor, false);
  }

  zoomAround(px: number, py: number, factor: number, immediate: boolean): void {
    const k = clamp(this.target.k * factor, Math.min(MIN_ZOOM, FIT_ALL_MIN_ZOOM), MAX_ZOOM);
    const real = k / this.target.k;
    this.target.x = px - (px - this.target.x) * real;
    this.target.y = py - (py - this.target.y) * real;
    this.target.k = k;
    this.moved = true;
    this.settle(immediate);
  }

  /** 滚轮平移：相机立即跟上，不走弹簧。 */
  scrollBy(dx: number, dy: number): void {
    this.target.x -= dx;
    this.target.y -= dy;
    this.camera.x = this.target.x;
    this.camera.y = this.target.y;
    this.camera.k = this.target.k;
    this.velocity = { x: 0, y: 0, k: 0 };
    this.moved = true;
    this.apply();
    this.report();
  }

  /** 拖动开始的那一刻：相机归用户，弹簧停在当前位置（手里的画面不能被弹簧拉走）。 */
  grab(): void {
    this.moved = true;
    Object.assign(this.target, this.camera);
    this.velocity = { x: 0, y: 0, k: 0 };
  }

  /** 拖动平移：相机跟着手，目标与相机重合。 */
  dragTo(x: number, y: number): void {
    this.camera.x = x;
    this.camera.y = y;
    this.target.x = this.camera.x;
    this.target.y = this.camera.y;
    this.target.k = this.camera.k;
    this.velocity = { x: 0, y: 0, k: 0 };
    this.apply();
    this.report();
  }

  /** 弹簧走一帧（`steps` 个子步，每步 `h` 秒）；返回相机是否还没落定。 */
  step(steps: number, h: number): boolean {
    const cam = this.camera;
    const target = this.target;
    const v = this.velocity;
    let moving = false;
    for (let i = 0; i < steps; i++) {
      v.x += (-CAMERA_STIFFNESS * (cam.x - target.x) - CAMERA_DAMPING * v.x) * h;
      v.y += (-CAMERA_STIFFNESS * (cam.y - target.y) - CAMERA_DAMPING * v.y) * h;
      v.k += (-CAMERA_STIFFNESS * (cam.k - target.k) - CAMERA_DAMPING * v.k) * h;
      cam.x += v.x * h;
      cam.y += v.y * h;
      cam.k += v.k * h;
    }
    const settled =
      Math.abs(cam.x - target.x) < 0.05 &&
      Math.abs(cam.y - target.y) < 0.05 &&
      Math.abs(cam.k - target.k) < 0.0004 &&
      Math.abs(v.x) < 0.05 &&
      Math.abs(v.y) < 0.05 &&
      Math.abs(v.k) < 0.001;
    if (settled) {
      cam.x = target.x;
      cam.y = target.y;
      cam.k = target.k;
      v.x = 0;
      v.y = 0;
      v.k = 0;
    } else {
      moving = true;
    }
    this.apply();
    return moving;
  }

  /** 把相机写到画布上。 */
  apply(): void {
    const mounted = this.host.mounted();
    if (!mounted) return;
    const { x, y, k } = this.camera;
    mounted.world.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${k.toFixed(4)})`;
    this.host.applied();
  }

  /** 缩放或归属变了才通知宿主（缩放读数、“适应”按钮的状态），拖动与动画里每一帧的细小变化不通知。 */
  report(): void {
    if (Math.abs(this.reportedK - this.target.k) < 0.004 && this.reportedMoved === this.moved) return;
    this.reportedK = this.target.k;
    this.reportedMoved = this.moved;
    this.host.mounted()?.onCamera?.(this.target, this.moved);
  }

  /** 视口尺寸变了：自动取景的相机重新取景；用户摆过的相机保持视口中心对着的那个世界点。 */
  watch(viewport: HTMLElement): void {
    let width = viewport.clientWidth;
    let height = viewport.clientHeight;
    this.observer = new ResizeObserver(() => {
      const nextWidth = viewport.clientWidth;
      const nextHeight = viewport.clientHeight;
      const dx = (nextWidth - width) / 2;
      const dy = (nextHeight - height) / 2;
      const wasVisible = width > 0 && height > 0;
      width = nextWidth;
      height = nextHeight;
      if (!this.host.framed() || nextWidth <= 0 || nextHeight <= 0) return;
      if (!this.moved) {
        this.refit(false);
      } else if (wasVisible && (dx !== 0 || dy !== 0)) {
        // Preserve the world point at the viewport center after manual panning or dragging.
        this.camera.x += dx;
        this.camera.y += dy;
        this.target.x += dx;
        this.target.y += dy;
        this.apply();
      }
    });
    this.observer.observe(viewport);
  }

  /** 撤掉画布上的相机变换，并停止观察视口。 */
  detach(): void {
    this.host.mounted()?.world.style.removeProperty("transform");
    this.observer?.disconnect();
    this.observer = undefined;
    // 宿主走了：下一个宿主（聚焦页返回后重新挂载的 Overview）的读数从 100%、自动取景起步，不记得这一个听到过什么。
    // 缓存不回到起点，相机没变的重新挂载就被 `report()` 当成“没变化”而不通知，读数一直停在 100%；回到起点后，相机不在起点才通知。
    // 重新挂载时 engine.ts 的 `mount()` 会先 `report()` 一次，所以回放布局时不取景、也不换空间的用户动过的相机，同样会通知到新宿主。
    this.reportedK = 1;
    this.reportedMoved = false;
  }

  /** 离开一个空间之前记下它的相机状态。 */
  remember(space: string): void {
    this.spaces.set(space, { camera: { ...this.target }, userMoved: this.moved, cap: this.autoCap });
  }

  /** 进入一个空间：取回它记下的相机状态；没记过（或相机是自动取景的）就回到默认视角。 */
  recall(space: string): void {
    const saved = this.spaces.get(space);
    // 保持缩放的上限跟着空间走，而且不论相机是不是用户动过的：相机自动取景的空间回来后，第一次布局仍然按它保持缩放。
    this.autoCap = saved?.cap;
    if (saved?.userMoved) {
      Object.assign(this.camera, saved.camera);
      Object.assign(this.target, saved.camera);
      this.moved = true;
    } else {
      Object.assign(this.camera, { x: 0, y: 0, k: 1 });
      Object.assign(this.target, { x: 0, y: 0, k: 1 });
      this.moved = false;
    }
    this.velocity = { x: 0, y: 0, k: 0 };
  }
}
