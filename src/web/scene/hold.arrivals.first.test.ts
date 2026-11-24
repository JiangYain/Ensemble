import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountScene, node, sceneOf, type SceneRig } from "./engine.fixtures";
import type { SceneLayout } from "./layout";

/**
 * 页面打开后的第一个新会话也要进“视口外提示”（LAYOUT5 · W14）。
 *
 * 根因：`Overview` 载入进某个来源的画布（`#/m/<来源>`）时，布局副作用先调 `engine.switchSpace(spaceId)`，
 * 它曾把“下一份布局当作重放”（`spaceReplay`）交给 `ArrivalWatch.layoutChanged(…, replay = true)`，后者整个忽略——连“见过现状”都不记。
 * 紧接着第一个真正的新会话到来时监视器仍未就绪，它被当成“第一份现状布局”吞掉；第二个起一切正常，所以提示永远少一个、少的永远是第一个。
 * `switchSpace` 本来就调了 `arrivals.reset()`：下一份布局自然是新空间的现状。真正的重放只有一种——容器重新挂载时用旧布局重放（`mount`）。
 *
 * 夹具视口 1200×800；老节点排成 4 列 × 若干行，新节点放在远在画面下方的同一列，所以“整块在视口之外”与哪一边都没有歧义。
 */

const far = (id: string, x: number, y: number) => node(id, x, y);
const edges = (rig: SceneRig) => rig.engine.arrivals.getHints().map((hint) => `${hint.edge}:${hint.ids.join(",")}`);
const hinted = (rig: SceneRig) => rig.engine.arrivals.getHints().flatMap((hint) => hint.ids);

/** 4 列 × 若干行的老节点：根 1…n（都在视口里）。 */
const roots = (count: number, prefix = "r") =>
  Array.from({ length: count }, (_, i) => node(`agent:${prefix}${i + 1}`, (i % 4) * 260, Math.floor(i / 4) * 160));

/** 画面下方很远的新会话：根 n（同一列，越往后越远）。 */
const arrival = (n: number, prefix = "r") => far(`agent:${prefix}${n}`, 0, 1200 + (n - 13) * 160);

/** 用户的一次平移：和真实手势一样走视口上的滚轮事件，之后相机归用户，不再自动取景。 */
const wheel = (rig: SceneRig, deltaX: number): void => {
  rig.viewport.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY: 0, bubbles: true, cancelable: true }));
};

/** 与页面一致：先给新节点挂元素，再交布局。 */
const show = (rig: SceneRig, layout: SceneLayout): void => {
  for (const spec of layout.nodes) if (!rig.els.has(spec.id)) rig.attach(spec.id);
  rig.engine.setLayout(layout);
};

/**
 * 与 `Overview` 的载入顺序一致：挂载 → `switchSpace(空间)` → 第一份布局。
 * `mountScene` 只用来搭 DOM 与引擎（它自己会先交一份空布局）；`switchSpace` 之后监视器、已知节点、持有的排布都被清空，与第一次载入没有区别。
 */
const loadInto = (space: string, layout: SceneLayout): SceneRig => {
  const rig = mountScene(sceneOf([]));
  rig.engine.switchSpace(space);
  show(rig, layout);
  return rig;
};

describe("页面载入与空间切换之后，第一个新到的会话也进提示", () => {
  let rig: SceneRig | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    rig?.dispose();
    rig = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("载入进某个来源的画布：载入时的节点不提示，之后第一个新会话落在视口外就有提示", () => {
    rig = loadInto("origin:x", sceneOf(roots(12)));
    wheel(rig, 1);
    expect(edges(rig)).toEqual([]);
    show(rig, sceneOf([...roots(12), arrival(13)]));
    expect(edges(rig)).toEqual(["bottom:agent:r13"]);
  });

  it("对照：载入进“全部”画布（switchSpace 是空操作）时，第一个新会话本来就进提示——两条路径现在一致", () => {
    rig = mountScene(sceneOf(roots(12)));
    wheel(rig, 1);
    show(rig, sceneOf([...roots(12), arrival(13)]));
    expect(edges(rig)).toEqual(["bottom:agent:r13"]);
  });

  it("载入时就落在视口之外的老会话没有提示；第一个新会话只提示它自己", () => {
    // 老节点把外框撑到 5212×4112，自动取景缩到 0.3：x=5000 与 y=4000 的两张老卡在视口之外；新会话放得更远（y=6000）。
    const old = [...roots(3), far("agent:old", 5000, 100), far("agent:older", 0, 4000)];
    rig = loadInto("origin:x", sceneOf(old));
    wheel(rig, 1);
    expect(edges(rig)).toEqual([]);
    show(rig, sceneOf([...old, far("agent:r13", 0, 6000)]));
    expect(hinted(rig)).toEqual(["agent:r13"]);
  });

  it("用户把缩放定到 150%，逐个加根 13…20：提示依次是 1…8 张，悬停列出的从根 13 起一个不少", () => {
    rig = loadInto("origin:x", sceneOf(roots(12)));
    rig.engine.zoomBy(1.5);
    expect(rig.engine.getCamera().k).toBeCloseTo(1.5, 5);
    expect(edges(rig)).toEqual([]);

    const added: ReturnType<typeof arrival>[] = [];
    for (let n = 13; n <= 20; n++) {
      added.push(arrival(n));
      show(rig, sceneOf([...roots(12), ...added]));
      expect(hinted(rig), `根 ${n} 到来之后`).toEqual(added.map((spec) => spec.id));
      expect(edges(rig)).toHaveLength(1);
    }
    expect(hinted(rig)[0]).toBe("agent:r13");
  });

  it("空间切换：新空间里第一个新会话进提示；旧空间的提示不带过去，新空间载入时的节点也不提示", () => {
    rig = loadInto("origin:a", sceneOf(roots(3, "a")));
    wheel(rig, 1);
    show(rig, sceneOf([...roots(3, "a"), arrival(13, "a")]));
    expect(edges(rig)).toEqual(["bottom:agent:a13"]);

    for (const release of rig.releases.values()) release(); // 旧空间的节点随页面卸载
    rig.engine.switchSpace("origin:b");
    expect(edges(rig)).toEqual([]);
    show(rig, sceneOf(roots(3, "b")));
    wheel(rig, 1);
    expect(edges(rig)).toEqual([]);

    show(rig, sceneOf([...roots(3, "b"), arrival(13, "b")]));
    expect(edges(rig)).toEqual(["bottom:agent:b13"]);
  });

  it("连着切两次空间也一样：最后落脚的那个空间里第一个新会话进提示", () => {
    rig = loadInto("origin:a", sceneOf(roots(3, "a")));
    for (const release of rig.releases.values()) release();
    rig.engine.switchSpace("origin:b");
    rig.engine.switchSpace("origin:c");
    show(rig, sceneOf(roots(3, "c")));
    wheel(rig, 1);
    show(rig, sceneOf([...roots(3, "c"), arrival(13, "c")]));
    expect(edges(rig)).toEqual(["bottom:agent:c13"]);
  });

  it("聚焦页往返（容器重新挂载）：期间新建的会话不算新到，提示也不带过去；回到概览之后再来的才算", () => {
    rig = loadInto("origin:x", sceneOf(roots(3)));
    wheel(rig, 1);
    show(rig, sceneOf([...roots(3), arrival(13)]));
    expect(edges(rig)).toEqual(["bottom:agent:r13"]);

    rig.engine.unmount();
    expect(edges(rig)).toEqual([]);
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots } });
    show(rig, sceneOf([...roots(3), arrival(13), arrival(14)])); // 14 是聚焦页期间新建的
    wheel(rig, 1);
    expect(edges(rig)).toEqual([]);

    show(rig, sceneOf([...roots(3), arrival(13), arrival(14), arrival(15)]));
    expect(hinted(rig)).toEqual(["agent:r15"]);
  });

  it("真正的重放不受影响：引擎被明确告知是重放（replay = true）的那一份布局，不提示也不算见过现状", () => {
    rig = loadInto("origin:x", sceneOf(roots(3)));
    wheel(rig, 1);
    rig.engine.unmount();
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots } });
    wheel(rig, 1);
    // 挂载时的重放没有武装监视器：紧接着的第一份真实布局是现状，里面多出来的 13 不算新到。
    show(rig, sceneOf([...roots(3), arrival(13)]));
    expect(edges(rig)).toEqual([]);
    show(rig, sceneOf([...roots(3), arrival(13), arrival(14)]));
    expect(hinted(rig)).toEqual(["agent:r14"]);
  });
});
