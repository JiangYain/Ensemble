import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArrivalWatch, type ArrivalPort, THROTTLE_MS } from "./arrivals";
import { fitPadding, type LayoutNode } from "./layout";
import { revealPan } from "./offscreen";
import type { Rect } from "./placement";

/** 视口 1200×800，相机不动；节点是 248×112 的卡片，位置直接写屏幕坐标。 */
function rig() {
  const camera = { x: 0, y: 0, k: 1 };
  const size = { w: 1200, h: 800 };
  const boxes = new Map<string, Rect>();
  const pans: [number, number][] = [];
  const box = vi.fn((id: string) => boxes.get(id));
  const port: ArrivalPort = {
    camera,
    size: () => ({ ...size }),
    box,
    panBy: (dx, dy) => {
      pans.push([dx, dy]);
      camera.x += dx;
      camera.y += dy;
    },
  };
  const watch = new ArrivalWatch(port);
  const put = (id: string, x: number, y: number): string => {
    boxes.set(id, { x, y, w: 248, h: 112 });
    return id;
  };
  const nodes = (...ids: string[]): Pick<LayoutNode, "id" | "kind">[] => ids.map((id) => ({ id, kind: id.startsWith("agent:") ? "agent" : "origin" }));
  const edges = () => watch.getHints().map((hint) => `${hint.edge}:${hint.ids.join(",")}`);
  return { camera, size, boxes, pans, box, watch, put, nodes, edges };
}

/** 先交一份“现状”布局把监视武装起来（第一份布局永远是基线，不提示）。 */
function armed(...ids: string[]) {
  const r = rig();
  for (const [i, id] of ids.entries()) r.put(id, 100 + i * 20, 100);
  r.watch.layoutChanged(r.nodes(...ids), new Set(ids), false);
  return r;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("到达判定：什么算“用户看着画布时新到的”", () => {
  it("第一份布局是现状：就算节点在视口之外、也都算新节点，也不提示（首次载入、刷新）", () => {
    const r = rig();
    r.put("agent:a", 5000, 100);
    r.put("agent:b", 100, 5000);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:b"), new Set(["agent:a", "agent:b"]), false);
    expect(r.watch.getHints()).toEqual([]);
  });

  it("新到的会话在视口之外才提示；落在视口里的不提示", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.put("agent:near", 600, 300);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far", "agent:near"), new Set(["agent:far", "agent:near"]), false);
    expect(r.edges()).toEqual(["right:agent:far"]);
  });

  it("不是新到的（fresh 里没有）就不提示，哪怕它此刻在视口之外：隐藏开关收起后再显示、重置布局都是这种情况", () => {
    const r = armed("agent:a");
    r.put("agent:hiddenBefore", 2000, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:hiddenBefore"), new Set(), false);
    expect(r.watch.getHints()).toEqual([]);
  });

  it("只有会话节点提示：来源、Git、Folder 卡片到了视口之外不算", () => {
    const r = armed("agent:a");
    r.put("origin:x", 2000, 100);
    r.put("agent:y", 2000, 300);
    r.watch.layoutChanged(r.nodes("agent:a", "origin:x", "agent:y"), new Set(["origin:x", "agent:y"]), false);
    expect(r.edges()).toEqual(["right:agent:y"]);
  });

  it("容器重新挂载时引擎用旧布局重放一遍（replay）：不武装；紧接着的第一份真布局仍是基线（聚焦页回到概览）", () => {
    const r = rig();
    r.put("agent:a", 100, 100);
    r.put("agent:new", 3000, 100);
    r.watch.layoutChanged(r.nodes("agent:a"), new Set(), true);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:new"), new Set(["agent:new"]), false);
    expect(r.watch.getHints()).toEqual([]);
    // 之后才是真正的新到。
    r.put("agent:later", 3000, 400);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:new", "agent:later"), new Set(["agent:later"]), false);
    expect(r.edges()).toEqual(["right:agent:later"]);
  });

  it("重置（卸载）清掉所有提示，下一份布局重新当作基线", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(["agent:far"]), false);
    expect(r.edges()).toHaveLength(1);
    r.watch.reset();
    expect(r.watch.getHints()).toEqual([]);
    r.put("agent:far2", 1700, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far", "agent:far2"), new Set(["agent:far2"]), false);
    expect(r.watch.getHints()).toEqual([]);
  });
});

describe("提示何时消失", () => {
  it("节点进入视口（用户平移 / 缩放）就消失，而且不再回来：看见过就不再算“新到的”", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(["agent:far"]), false);
    expect(r.edges()).toEqual(["right:agent:far"]);

    r.camera.x = -600; // 用户把画布往左拖：节点滑进来
    r.watch.touch();
    expect(r.watch.getHints()).toEqual([]);

    r.camera.x = 600; // 又拖走了：不会再提示
    vi.advanceTimersByTime(THROTTLE_MS * 2);
    r.watch.touch();
    expect(r.watch.getHints()).toEqual([]);
  });

  it("节点从布局里消失（被删除，或被隐藏开关收起）就去掉", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.put("agent:far2", 1500, 300);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far", "agent:far2"), new Set(["agent:far", "agent:far2"]), false);
    expect(r.edges()).toEqual(["right:agent:far,agent:far2"]);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far2"), new Set(), false);
    expect(r.edges()).toEqual(["right:agent:far2"]);
    r.watch.layoutChanged(r.nodes("agent:a"), new Set(), false);
    expect(r.watch.getHints()).toEqual([]);
  });

  it("没有这个节点的矩形（引擎里已经不存在）也去掉，不留悬空的提示", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(["agent:far"]), false);
    r.boxes.delete("agent:far");
    r.watch.touch();
    expect(r.watch.getHints()).toEqual([]);
  });
});

describe("聚合与去向", () => {
  function crowded() {
    const r = armed("agent:a");
    r.put("agent:r2", 2400, 100); // 离视口右缘 1200
    r.put("agent:r1", 1300, 100); // 100
    r.put("agent:r3", 1900, 600); // 700
    r.put("agent:b1", 100, 1000); // 离视口下缘 200
    r.watch.layoutChanged(r.nodes("agent:a", "agent:r2", "agent:r1", "agent:r3", "agent:b1"), new Set(["agent:r2", "agent:r1", "agent:r3", "agent:b1"]), false);
    return r;
  }

  it("同一边聚合成一个提示，节点按离视口的远近排（最近的在前）；不同的边各一个，按上、右、下、左排", () => {
    const r = crowded();
    expect(r.edges()).toEqual(["right:agent:r1,agent:r3,agent:r2", "bottom:agent:b1"]);
  });

  it("点击聚合的提示：去最近的一个，平移量就是 revealPan 的结果，不改缩放；其余的仍留在提示里", () => {
    const r = crowded();
    const expected = revealPan({ x: 1300, y: 100, w: 248, h: 112 }, r.camera, r.size, fitPadding(r.size.w));
    const id = r.watch.go("right");
    expect(id).toBe("agent:r1");
    // 右缘落在右留白上（1200 − 56 − 1548），顶缘低于上留白 126 的补上 26。
    expect(r.pans).toEqual([[-404, 26]]);
    expect(r.pans).toEqual([[expected.dx, expected.dy]]);
    expect(r.camera.k).toBe(1);
    expect(r.edges()).toEqual(["right:agent:r3,agent:r2", "bottom:agent:b1"]);
  });

  it("平移顺带带进视口的节点一并算看见", () => {
    const r = armed("agent:a");
    r.put("agent:n1", 1300, 100);
    r.put("agent:n2", 1350, 300); // 与 n1 一起被带进来
    r.watch.layoutChanged(r.nodes("agent:a", "agent:n1", "agent:n2"), new Set(["agent:n1", "agent:n2"]), false);
    expect(r.edges()).toEqual(["right:agent:n1,agent:n2"]);
    r.watch.go("right");
    expect(r.watch.getHints()).toEqual([]);
  });

  it("没有这条边的提示：什么都不做", () => {
    const r = crowded();
    expect(r.watch.go("top")).toBeUndefined();
    expect(r.pans).toEqual([]);
  });

  it("留白之内本来就放得下时按最小位移走：节点落在离视口边缘正好是留白的位置", () => {
    const r = armed("agent:a");
    r.put("agent:n", 1500, 300);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:n"), new Set(["agent:n"]), false);
    r.watch.go("right");
    expect(r.pans).toEqual([[1200 - fitPadding(1200).right - (1500 + 248), 0]]);
  });
});

describe("视口量不出来、节流与快照", () => {
  it("视口还没有尺寸（0）：不下结论，节点留着；量得出来以后再提示", () => {
    const r = armed("agent:a");
    r.size.w = 0;
    r.size.h = 0;
    r.put("agent:far", 1500, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(["agent:far"]), false);
    expect(r.watch.getHints()).toEqual([]);
    r.size.w = 1200;
    r.size.h = 800;
    r.watch.touch();
    expect(r.edges()).toEqual(["right:agent:far"]);
  });

  it("没有待提示的节点时 touch 什么都不算：每帧都会调用它，常态下必须是空操作", () => {
    const r = armed("agent:a");
    r.box.mockClear();
    for (let i = 0; i < 500; i++) r.watch.touch();
    expect(r.box).not.toHaveBeenCalled();
  });

  it("相机连续变化时节流：第一次立即算，其余合并成一次收尾，最终状态一定被算到", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(["agent:far"]), false);
    r.box.mockClear();
    for (let i = 0; i < 200; i++) {
      r.camera.x = -i; // 一直拖到 -199：节点始终在视口右边之外
      r.watch.touch();
    }
    expect(r.box).toHaveBeenCalledTimes(1); // 只有最前面那一次
    vi.advanceTimersByTime(THROTTLE_MS);
    expect(r.box).toHaveBeenCalledTimes(2); // 加上收尾的一次
    vi.advanceTimersByTime(THROTTLE_MS * 10);
    expect(r.box).toHaveBeenCalledTimes(2); // 之后没有人再变，就不再算
    expect(r.edges()).toEqual(["right:agent:far"]);
  });

  it("收尾那一次读到的是最后的相机", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(["agent:far"]), false);
    r.watch.touch(); // 立即算：仍在视口之外
    expect(r.edges()).toEqual(["right:agent:far"]);
    r.camera.x = -600;
    r.watch.touch(); // 节流中：这一次先不算
    expect(r.edges()).toEqual(["right:agent:far"]);
    vi.advanceTimersByTime(THROTTLE_MS);
    expect(r.watch.getHints()).toEqual([]);
  });

  it("订阅者只在提示真的变了时收到通知，没变时快照引用不变", () => {
    const r = armed("agent:a");
    r.put("agent:far", 1500, 100);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(["agent:far"]), false);
    const listener = vi.fn();
    const off = r.watch.subscribe(listener);
    const before = r.watch.getHints();
    vi.advanceTimersByTime(THROTTLE_MS * 2);
    r.watch.touch();
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far"), new Set(), false);
    expect(r.watch.getHints()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    r.put("agent:far2", 1500, 300);
    r.watch.layoutChanged(r.nodes("agent:a", "agent:far", "agent:far2"), new Set(["agent:far2"]), false);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    r.watch.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
