import { describe, expect, it } from "vitest";
import { fitPadding } from "./layout";
import { revealPan, standing, toScreen, VISIBLE_PX, type Edge } from "./offscreen";

/** 1200×800 的视口，相机不动：世界坐标就是屏幕坐标。 */
const VIEW = { w: 1200, h: 800 };
const HOME = { x: 0, y: 0, k: 1 };
const CARD = { w: 248, h: 112 };
const at = (x: number, y: number, size = CARD) => ({ x, y, ...size });

const edgeOf = (rect: ReturnType<typeof at>, camera = HOME, size = VIEW): Edge | undefined => {
  const result = standing(rect, camera, size);
  return result.state === "outside" ? result.edge : undefined;
};

describe("toScreen：世界矩形到屏幕", () => {
  it("先缩放再平移，宽高跟着缩放", () => {
    expect(toScreen(at(100, 50), { x: 30, y: -20, k: 0.5 })).toEqual({ x: 80, y: 5, w: 124, h: 56 });
  });
});

describe("standing：节点在视口里、还是在哪条边之外", () => {
  it("整个在视口里：看得见", () => {
    expect(standing(at(100, 100), HOME, VIEW)).toEqual({ state: "visible" });
  });

  it("只要还露出一部分（四个方向都算）就是看得见的，哪怕只剩一条窄边", () => {
    for (const rect of [at(-200, 100), at(1150, 100), at(100, -90), at(100, 760)]) {
      expect(standing(rect, HOME, VIEW).state, JSON.stringify(rect)).toBe("visible");
    }
  });

  it("完全在视口之外：四个方向各落在对应的边，距离是离视口最近的那一点", () => {
    expect(standing(at(1300, 300), HOME, VIEW)).toEqual({ state: "outside", edge: "right", distance: 100 });
    expect(standing(at(-400, 300), HOME, VIEW)).toEqual({ state: "outside", edge: "left", distance: 152 });
    expect(standing(at(300, 900), HOME, VIEW)).toEqual({ state: "outside", edge: "bottom", distance: 100 });
    expect(standing(at(300, -300), HOME, VIEW)).toEqual({ state: "outside", edge: "top", distance: 188 });
  });

  it("斜角：归到离得更远的那条轴所在的边；两条轴一样远时归到左右", () => {
    // 右边 100、下边 400 → 下。
    expect(edgeOf(at(1300, 1200))).toBe("bottom");
    // 右边 600、下边 50 → 右。
    expect(edgeOf(at(1800, 850))).toBe("right");
    // 左上：左边 52、上边 200 → 上。
    expect(edgeOf(at(-300, -312))).toBe("top");
    // 左下：左边 400、下边 30 → 左。
    expect(edgeOf(at(-648, 830))).toBe("left");
    // 一样远（都是 100）：左右优先。
    expect(edgeOf(at(1300, 900))).toBe("right");
    expect(edgeOf(at(-348, -212))).toBe("left");
    // 斜角的距离是两条轴的合成。
    expect(standing(at(1300, 900), HOME, VIEW)).toEqual({ state: "outside", edge: "right", distance: Math.hypot(100, 100) });
  });

  it("刚好在边界：边与边相碰（一点也没露出）算在视口之外，露出不到 1px 也算", () => {
    expect(edgeOf(at(1200, 100))).toBe("right");
    expect(edgeOf(at(-248, 100))).toBe("left");
    expect(edgeOf(at(100, 800))).toBe("bottom");
    expect(edgeOf(at(100, -112))).toBe("top");
    expect(edgeOf(at(1199.5, 100))).toBe("right");
    // 恰好露出 VISIBLE_PX 才算看得见：浮点误差不会让提示在边界上来回闪。
    expect(VISIBLE_PX).toBe(1);
    expect(standing(at(1199, 100), HOME, VIEW).state).toBe("visible");
    expect(standing(at(100, 799), HOME, VIEW).state).toBe("visible");
  });

  it("只在一条轴上露出不到 1px 时，另一条轴上完全在里面：仍按那条轴归边，距离不为负", () => {
    const result = standing(at(1199.5, 100), HOME, VIEW);
    expect(result).toMatchObject({ state: "outside", edge: "right" });
    expect((result as { distance: number }).distance).toBe(0);
  });

  it("缩放与平移之后：用屏幕上的位置判断，不是世界坐标", () => {
    const camera = { x: -2000, y: 100, k: 0.5 };
    // 世界 (4000, 0) → 屏幕 (0, 100)，宽 124：露出一整个。
    expect(standing(at(4000, 0), camera, VIEW).state).toBe("visible");
    // 世界 (4500, 0) → 屏幕 (250, 100)：在里面。
    expect(standing(at(4500, 0), camera, VIEW).state).toBe("visible");
    // 世界 (6500, 0) → 屏幕 (1250, 100)：在右边之外 50px。
    expect(standing(at(6500, 0), camera, VIEW)).toEqual({ state: "outside", edge: "right", distance: 50 });
    // 放大后同一个世界位置落到更远的地方。
    expect(standing(at(900, 0), { x: 0, y: 0, k: 1.6 }, VIEW)).toEqual({ state: "outside", edge: "right", distance: 240 });
  });

  it("视口为 0、负数或量不出来：给不出结论（unknown），不是“在视口之外”", () => {
    for (const size of [{ w: 0, h: 0 }, { w: 0, h: 800 }, { w: 1200, h: 0 }, { w: -5, h: 800 }, { w: Number.NaN, h: 800 }]) {
      expect(standing(at(100, 100), HOME, size).state, JSON.stringify(size)).toBe("unknown");
    }
    expect(standing(at(Number.NaN, 0), HOME, VIEW).state).toBe("unknown");
    expect(standing(at(0, 0), { x: Number.NaN, y: 0, k: 1 }, VIEW).state).toBe("unknown");
  });

  it("视口极小（侧栏被压到几十像素）：照常给出方向，没有 NaN", () => {
    const tiny = { w: 24, h: 24 };
    expect(standing(at(100, 0), HOME, tiny)).toEqual({ state: "outside", edge: "right", distance: 76 });
    expect(standing(at(0, 0), HOME, tiny).state).toBe("visible");
    const far = standing(at(5000, 5000), HOME, tiny);
    expect(far.state).toBe("outside");
    expect(Number.isFinite((far as { distance: number }).distance)).toBe(true);
  });
});

describe("revealPan：把节点带进视口所需的平移（屏幕像素，不涉及缩放）", () => {
  const pad = fitPadding(VIEW.w); // 宽屏：上 126、右 56、下 110、左 56
  const after = (rect: ReturnType<typeof at>, camera = HOME, size = VIEW, padding = pad) => {
    const { dx, dy } = revealPan(rect, camera, size, padding);
    return { dx, dy, shifted: toScreen(rect, { ...camera, x: camera.x + dx, y: camera.y + dy }) };
  };

  it("已经在留白之内：不动", () => {
    expect(revealPan(at(300, 300), HOME, VIEW, pad)).toEqual({ dx: 0, dy: 0 });
  });

  it("右边之外：最小的位移，让节点落在右留白之内（右缘离视口右缘正好是右留白）", () => {
    const { dx, dy, shifted } = after(at(1300, 300));
    expect(dy).toBe(0);
    expect(dx).toBe(1200 - 56 - (1300 + 248));
    expect(VIEW.w - (shifted.x + shifted.w)).toBe(56);
  });

  it("左、上、下三个方向同理，各落在自己那一边的留白上", () => {
    const left = after(at(-500, 300));
    expect(left.shifted.x).toBe(56);
    expect(left.dy).toBe(0);
    const top = after(at(300, -400));
    expect(top.shifted.y).toBe(126);
    expect(top.dx).toBe(0);
    const bottom = after(at(300, 1000));
    expect(VIEW.h - (bottom.shifted.y + bottom.shifted.h)).toBe(64);
    expect(bottom.dx).toBe(0);
  });

  it("斜角：两条轴都动", () => {
    const { shifted } = after(at(1500, 1200));
    expect(VIEW.w - (shifted.x + shifted.w)).toBe(56);
    expect(VIEW.h - (shifted.y + shifted.h)).toBe(64);
  });

  it("缩放不影响结果的含义：位移是屏幕像素，平移后四边的留白一样", () => {
    for (const k of [0.3, 0.72, 1, 1.6]) {
      const camera = { x: -100, y: 40, k };
      const rect = at(2500, 2200);
      const { dx, dy, shifted } = after(rect, camera);
      expect(standing(rect, { ...camera, x: camera.x + dx, y: camera.y + dy }, VIEW).state, `k=${k}`).toBe("visible");
      expect(shifted.x).toBeGreaterThanOrEqual(pad.left - 1e-9);
      expect(shifted.x + shifted.w).toBeLessThanOrEqual(VIEW.w - pad.right + 1e-9);
      expect(shifted.y).toBeGreaterThanOrEqual(pad.top - 1e-9);
      expect(shifted.y + shifted.h).toBeLessThanOrEqual(VIEW.h - pad.bottom + 1e-9);
    }
  });

  it("窄画布（侧栏 390 宽）用窄的留白：左右各 20", () => {
    const narrow = { w: 390, h: 700 };
    const { shifted } = after(at(600, 100), HOME, narrow, fitPadding(narrow.w));
    expect(shifted.x + shifted.w).toBe(390 - 20);
  });

  it("节点比留白之内的区域还大：对齐起点（左 / 上），不去居中", () => {
    const huge = at(2000, 2000, { w: 1400, h: 900 });
    const { shifted } = after(huge);
    expect(shifted.x).toBe(56);
    expect(shifted.y).toBe(126);
  });

  it("留白把视口吃光（极小的视口）：居中，不出现 NaN", () => {
    const tiny = { w: 100, h: 100 };
    const { dx, dy, shifted } = after(at(500, 500), HOME, tiny, { top: 60, right: 60, bottom: 60, left: 60 });
    expect(shifted.x + shifted.w / 2).toBeCloseTo(50, 6);
    expect(shifted.y + shifted.h / 2).toBeCloseTo(50, 6);
    expect(Number.isFinite(dx) && Number.isFinite(dy)).toBe(true);
  });

  it("输入不是有限的数、或视口量不出来时：不动", () => {
    expect(revealPan(at(Number.NaN, 0), HOME, VIEW, pad)).toEqual({ dx: 0, dy: 0 });
    expect(revealPan(at(0, 0), HOME, { w: 0, h: 0 }, pad)).toEqual({ dx: 0, dy: 0 });
  });
});
