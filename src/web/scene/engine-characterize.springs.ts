/**
 * `engine.characterize.*.test.ts` 里补洞用的参考弹簧，仅供测试使用（没有任何运行时代码引用它）：纯计算，不含断言，也不依赖 vitest。
 * 它独立于引擎复算节点与相机的弹簧（刚度 / 阻尼 / 落定条件按 `engine-frame.ts`、`engine-camera.ts` 里的常数抄成字面量），
 * 测试里“逐帧该写出什么”与“该在第几帧落定”都由它算出来，不是从引擎里抄的。
 */

const NODE_STIFFNESS = 240;
const NODE_DAMPING = 27;
const NODE_EPS = 0.04;
const CAMERA_STIFFNESS = 170;
const CAMERA_DAMPING = 26;

export interface CameraPose {
  x: number;
  y: number;
  k: number;
}

export interface SpringRun<Last = number> {
  /** 每一帧之后写出来的读数（到位的那一帧精确落在目标上）。 */
  rows: string[];
  /** 在第几帧落定（从 1 数起）；跑完给定的帧也没落定就是 undefined。 */
  settledAt: number | undefined;
  /** 跑完这些帧（或在落定的那一帧）之后弹簧精确停在哪里：没有经过 `toFixed`，是引擎里弹簧此刻的数。 */
  last: Last;
}

/** 一帧该走几个子步、每步多长：帧间隔夹在 1ms 到 50ms 之间，再按 1/120 秒细分。 */
export function stepsOf(ms: number): { steps: number; h: number } {
  const dt = Math.min(0.05, Math.max(0.001, ms / 1000));
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  return { steps, h: dt / steps };
}

/** 一个节点沿一根轴从 `from` 走向 `to`，帧间隔依次取自 `dts`；读数是 `toFixed(2)` 的像素值（与 `translate` 里的写法一致）。 */
export function nodeRun(from: number, to: number, dts: readonly number[]): SpringRun<number> {
  let x = from;
  let v = 0;
  const rows: string[] = [];
  for (const [index, ms] of dts.entries()) {
    const { steps, h } = stepsOf(ms);
    for (let i = 0; i < steps; i++) {
      v += (-NODE_STIFFNESS * (x - to) - NODE_DAMPING * v) * h;
      x += v * h;
    }
    const settled = Math.abs(x - to) < NODE_EPS && Math.abs(v) < NODE_EPS;
    if (settled) {
      x = to;
      v = 0;
    }
    rows.push(`${x.toFixed(2)}px`);
    if (settled) return { rows, settledAt: index + 1, last: x };
  }
  return { rows, settledAt: undefined, last: x };
}

/** 相机三个分量一起从 `from` 走向 `to`；读数是世界层 `transform` 的写法。 */
export function cameraRun(from: CameraPose, to: CameraPose, dts: readonly number[]): SpringRun<CameraPose> {
  const cam = { ...from };
  const v = { x: 0, y: 0, k: 0 };
  const rows: string[] = [];
  for (const [index, ms] of dts.entries()) {
    const { steps, h } = stepsOf(ms);
    for (let i = 0; i < steps; i++) {
      v.x += (-CAMERA_STIFFNESS * (cam.x - to.x) - CAMERA_DAMPING * v.x) * h;
      v.y += (-CAMERA_STIFFNESS * (cam.y - to.y) - CAMERA_DAMPING * v.y) * h;
      v.k += (-CAMERA_STIFFNESS * (cam.k - to.k) - CAMERA_DAMPING * v.k) * h;
      cam.x += v.x * h;
      cam.y += v.y * h;
      cam.k += v.k * h;
    }
    const settled =
      Math.abs(cam.x - to.x) < 0.05 && Math.abs(cam.y - to.y) < 0.05 && Math.abs(cam.k - to.k) < 0.0004 &&
      Math.abs(v.x) < 0.05 && Math.abs(v.y) < 0.05 && Math.abs(v.k) < 0.001;
    if (settled) Object.assign(cam, to);
    rows.push(`translate3d(${cam.x.toFixed(2)}px,${cam.y.toFixed(2)}px,0) scale(${cam.k.toFixed(4)})`);
    if (settled) return { rows, settledAt: index + 1, last: { ...cam } };
  }
  return { rows, settledAt: undefined, last: { ...cam } };
}
