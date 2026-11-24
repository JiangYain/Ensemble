import { describe, expect, it } from "vitest";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { layoutScene } from "../scene/layout";
import { filterWorking, leavingNodes, settle, type Drawn, type Linger } from "./workFilter";

const PHASES: SessionPhase[] = ["ready", "starting", "queued", "running", "done", "failed", "cancelled", "stopped", "lost"];

/** 只带过滤用得到的字段；createdAt 按先后（第几秒）给，layoutScene 也读得了。 */
function s(id: string, phase: SessionPhase, extra: { origin?: string; parent?: string; workspace?: string; order?: number } = {}): SessionSummary {
  const key = extra.origin ?? "o1";
  return {
    id,
    phase,
    origin: { key, ...(extra.workspace ? { workspace: extra.workspace } : {}) },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, extra.order ?? 0)).toISOString(),
    ...(extra.parent ? { parentSessionId: extra.parent } : {}),
  } as unknown as SessionSummary;
}

const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

describe("filterWorking · 谁算“工作中”", () => {
  it.each([
    ["starting", true],
    ["queued", true],
    ["running", true],
    // 用户的决定：ready（会话在、此刻没有运行的待命）算工作中，不收起；只有结束了的才收。
    ["ready", true],
    ["done", false],
    ["failed", false],
    ["cancelled", false],
    ["stopped", false],
    ["lost", false],
  ] as const)("%s → %s", (phase, kept) => {
    const result = filterWorking([s("a", phase)]);
    expect(result.visible.has("a")).toBe(kept);
    expect(result.hidden.has("a")).toBe(!kept);
  });

  it("每个相位恰好落在 visible 与 hidden 之一，不重不漏", () => {
    const list = PHASES.map((phase) => s(phase, phase));
    const { visible, hidden } = filterWorking(list);
    expect(sorted(new Set([...visible, ...hidden]))).toEqual(sorted(new Set(PHASES)));
    expect([...visible].filter((id) => hidden.has(id))).toEqual([]);
    expect(sorted(visible)).toEqual(["queued", "ready", "running", "starting"]);
    expect(sorted(hidden)).toEqual(["cancelled", "done", "failed", "lost", "stopped"]);
  });
});

describe("filterWorking · 祖先链保真", () => {
  it("父已完成、子运行中：父留下（而且只是上下文），子不会看起来直接挂在来源上", () => {
    const result = filterWorking([s("p", "done"), s("c", "running", { parent: "p" })]);
    expect(sorted(result.visible)).toEqual(["c", "p"]);
    expect(sorted(result.context)).toEqual(["p"]);
    expect(result.hidden.size).toBe(0);
  });

  it("多层：祖父、父都已结束、孙在运行 → 整条链留下，链外的兄弟与叔伯收起", () => {
    const list = [
      s("g", "done", { order: 1 }),
      s("p", "failed", { parent: "g", order: 2 }),
      s("c", "running", { parent: "p", order: 3 }),
      s("c-sibling", "done", { parent: "p", order: 4 }),
      s("uncle", "done", { parent: "g", order: 5 }),
    ];
    const result = filterWorking(list);
    expect(sorted(result.visible)).toEqual(["c", "g", "p"]);
    expect(sorted(result.context)).toEqual(["g", "p"]);
    expect(sorted(result.hidden)).toEqual(["c-sibling", "uncle"]);
  });

  it("子已完成、父在运行：只收子；父本来就在工作，不是上下文", () => {
    const result = filterWorking([s("p", "running"), s("c", "done", { parent: "p" })]);
    expect(sorted(result.visible)).toEqual(["p"]);
    expect(result.context.size).toBe(0);
    expect(sorted(result.hidden)).toEqual(["c"]);
  });

  it("祖先链上有工作中的会话时，它自己算工作、不算上下文", () => {
    const result = filterWorking([s("g", "done"), s("p", "running", { parent: "g" }), s("c", "queued", { parent: "p" })]);
    expect(sorted(result.context)).toEqual(["g"]);
    expect(sorted(result.visible)).toEqual(["c", "g", "p"]);
  });

  it("父会话不在列表里（已被删除）：子会话照常保留，链在那里截止", () => {
    const result = filterWorking([s("c", "running", { parent: "gone" })]);
    expect(sorted(result.visible)).toEqual(["c"]);
    expect(result.context.size).toBe(0);
  });

  it("父子互指的异常数据不会死循环：环上其余会话作为上下文留下", () => {
    const result = filterWorking([s("a", "running", { parent: "b" }), s("b", "done", { parent: "a" })]);
    expect(sorted(result.visible)).toEqual(["a", "b"]);
    expect(sorted(result.context)).toEqual(["b"]);
  });

  it("被收起的数量只数真正被收起的：为保真留下的祖先不在其中，待命的（算工作中）也不在其中", () => {
    const list = [s("p", "done", { order: 1 }), s("c", "running", { parent: "p", order: 2 }), s("x", "done", { order: 3 }), s("y", "ready", { order: 4 })];
    const result = filterWorking(list);
    expect(result.hidden.size).toBe(1);
    expect(sorted(result.hidden)).toEqual(["x"]);
    expect(result.hidden.has("p")).toBe(false);
    expect(result.hidden.has("y")).toBe(false);
  });

  it("待命的会话和运行中的一样是工作中：它自己不是“上下文”，已结束的父会话却因它而留下", () => {
    const result = filterWorking([s("p", "done", { order: 1 }), s("c", "ready", { parent: "p", order: 2 })]);
    expect(sorted(result.visible)).toEqual(["c", "p"]);
    expect(sorted(result.context)).toEqual(["p"]);
    expect(result.hidden.size).toBe(0);
  });

  it("待命的父会话：父留下且不是上下文；它已结束的子会话仍然收起", () => {
    const result = filterWorking([s("p", "ready", { order: 1 }), s("c", "done", { parent: "p", order: 2 })]);
    expect(sorted(result.visible)).toEqual(["p"]);
    expect(result.context.size).toBe(0);
    expect(sorted(result.hidden)).toEqual(["c"]);
  });
});

describe("filterWorking · 多个来源与边界", () => {
  it("来源互不影响：一个来源全部已完成 → 它的会话都收起；另一个来源照自己的规则", () => {
    const list = [
      s("a1", "done", { origin: "A", order: 1 }),
      s("a2", "failed", { origin: "A", order: 2 }),
      s("b1", "running", { origin: "B", order: 3 }),
      s("b2", "done", { origin: "B", order: 4 }),
    ];
    const result = filterWorking(list);
    expect(sorted(result.visible)).toEqual(["b1"]);
    expect(sorted(result.hidden)).toEqual(["a1", "a2", "b2"]);
  });

  it("列表为空：什么都没有，也不出错", () => {
    const result = filterWorking([]);
    expect(result.visible.size + result.context.size + result.hidden.size).toBe(0);
  });

  it("全部都在工作：什么都不收", () => {
    const result = filterWorking([s("a", "running"), s("b", "queued"), s("c", "starting", { parent: "a" })]);
    expect(result.hidden.size).toBe(0);
    expect(result.visible.size).toBe(3);
  });

  it("全部都不在工作（都已结束）：visible 为空，全部收起", () => {
    const result = filterWorking([s("a", "done"), s("b", "cancelled", { parent: "a" })]);
    expect(result.visible.size).toBe(0);
    expect(result.hidden.size).toBe(2);
  });

  it("不修改输入（列表与其中的会话都冻结了也照样能算）", () => {
    const list = Object.freeze([Object.freeze(s("p", "done")), Object.freeze(s("c", "running", { parent: "p" }))]);
    const before = JSON.stringify(list);
    expect(() => filterWorking(list)).not.toThrow();
    expect(JSON.stringify(list)).toBe(before);
  });
});

describe("settle · 规则不要了的会话怎样离场", () => {
  const NOW = 10_000;
  const EXIT = 240;
  const idle = (): boolean => false;
  const list = [s("a", "running", { order: 1 }), s("b", "running", { order: 2 })];
  const afterFinish = [s("a", "running", { order: 1 }), s("b", "done", { order: 2 })];
  const rule = (sessions: readonly SessionSummary[]) => filterWorking(sessions).visible;
  const first = (sessions: readonly SessionSummary[]): Drawn => {
    const settled = settle({ sessions, rule: rule(sessions), prev: undefined, operated: idle, now: NOW, exitMs: EXIT });
    return { drawn: settled.drawn, linger: settled.linger };
  };

  it("没有开过滤：全部画着，没有任何逗留", () => {
    const settled = settle({ sessions: list, rule: undefined, prev: undefined, operated: idle, now: NOW, exitMs: EXIT });
    expect(settled.drawn).toBe("all");
    expect(settled.leaving.size + settled.held.size).toBe(0);
  });

  it("第一次结算（页面刚打开）：直接是规则的结果，不会让已经收起的会话先画一遍再淡出", () => {
    const settled = settle({ sessions: afterFinish, rule: rule(afterFinish), prev: undefined, operated: idle, now: NOW, exitMs: EXIT });
    expect(sorted(settled.drawn as Set<string>)).toEqual(["a"]);
    expect(settled.leaving.size).toBe(0);
  });

  it("运行中的会话完成：不立刻消失，开始淡出；淡出期间仍画着、仍在布局里；到时间才离开", () => {
    const prev = first(list);
    const fading = settle({ sessions: afterFinish, rule: rule(afterFinish), prev, operated: idle, now: NOW, exitMs: EXIT });
    expect(sorted(fading.drawn as Set<string>)).toEqual(["a", "b"]);
    expect([...fading.leaving]).toEqual(["b"]);
    expect(fading.linger.get("b")).toBe(NOW);
    expect(fading.wakeAt).toBe(NOW + EXIT);

    const mid = settle({ sessions: afterFinish, rule: rule(afterFinish), prev: fading, operated: idle, now: NOW + EXIT - 1, exitMs: EXIT });
    expect([...mid.leaving]).toEqual(["b"]);
    expect(mid.linger.get("b")).toBe(NOW);

    const gone = settle({ sessions: afterFinish, rule: rule(afterFinish), prev: mid, operated: idle, now: NOW + EXIT, exitMs: EXIT });
    expect(sorted(gone.drawn as Set<string>)).toEqual(["a"]);
    expect(gone.leaving.size).toBe(0);
    expect(gone.linger.size).toBe(0);
    expect(gone.wakeAt).toBeUndefined();
  });

  it("正被操作（拖动、菜单开着、键盘焦点）：不淡出、不离开；操作一结束，下一次结算才开始淡出", () => {
    const prev = first(list);
    let busy = true;
    const operated = (id: string): boolean => busy && id === "b";
    const held = settle({ sessions: afterFinish, rule: rule(afterFinish), prev, operated, now: NOW, exitMs: EXIT });
    expect([...held.held]).toEqual(["b"]);
    expect(held.leaving.size).toBe(0);
    expect(held.linger.get("b")).toBe("held");
    expect(held.wakeAt).toBeUndefined();

    // 很久以后还是被操作着：仍然留着。
    const still = settle({ sessions: afterFinish, rule: rule(afterFinish), prev: held, operated, now: NOW + 60_000, exitMs: EXIT });
    expect(sorted(still.drawn as Set<string>)).toEqual(["a", "b"]);
    expect([...still.held]).toEqual(["b"]);

    busy = false;
    const releasedAt = NOW + 61_000;
    const fading = settle({ sessions: afterFinish, rule: rule(afterFinish), prev: still, operated, now: releasedAt, exitMs: EXIT });
    expect([...fading.leaving]).toEqual(["b"]);
    expect(fading.linger.get("b")).toBe(releasedAt);
    expect(fading.held.size).toBe(0);
  });

  it("已经开始淡出的不会因为随后被碰到而被拦下（淡出中的卡片不可操作）", () => {
    const prev = first(list);
    const fading = settle({ sessions: afterFinish, rule: rule(afterFinish), prev, operated: idle, now: NOW, exitMs: EXIT });
    const touched = settle({ sessions: afterFinish, rule: rule(afterFinish), prev: fading, operated: () => true, now: NOW + 100, exitMs: EXIT });
    expect([...touched.leaving]).toEqual(["b"]);
    expect(touched.linger.get("b")).toBe(NOW);
  });

  it("淡出途中又被规则需要（用户继续交代了它）：不再逗留，直接留下", () => {
    const prev = first(list);
    const fading = settle({ sessions: afterFinish, rule: rule(afterFinish), prev, operated: idle, now: NOW, exitMs: EXIT });
    const again = settle({ sessions: list, rule: rule(list), prev: fading, operated: idle, now: NOW + 100, exitMs: EXIT });
    expect(sorted(again.drawn as Set<string>)).toEqual(["a", "b"]);
    expect(again.leaving.size + again.held.size).toBe(0);
    expect(again.linger.size).toBe(0);
  });

  it("逗留期间会话被删除：立刻不画", () => {
    const prev = first(list);
    const fading = settle({ sessions: afterFinish, rule: rule(afterFinish), prev, operated: idle, now: NOW, exitMs: EXIT });
    const only = [s("a", "running", { order: 1 })];
    const removed = settle({ sessions: only, rule: rule(only), prev: fading, operated: idle, now: NOW + 50, exitMs: EXIT });
    expect(sorted(removed.drawn as Set<string>)).toEqual(["a"]);
    expect(removed.linger.size).toBe(0);
  });

  it("减少动效（exitMs = 0）：不淡出，当场离开；但正被操作的仍然等", () => {
    const prev = first(list);
    const now = settle({ sessions: afterFinish, rule: rule(afterFinish), prev, operated: idle, now: NOW, exitMs: 0 });
    expect(sorted(now.drawn as Set<string>)).toEqual(["a"]);
    const held = settle({ sessions: afterFinish, rule: rule(afterFinish), prev, operated: (id) => id === "b", now: NOW, exitMs: 0 });
    expect(sorted(held.drawn as Set<string>)).toEqual(["a", "b"]);
  });

  it("刚打开过滤：此前画着的全部会话里，规则不要的一起开始淡出", () => {
    const sessions = [s("a", "running", { order: 1 }), s("b", "done", { order: 2 }), s("c", "cancelled", { order: 3 }), s("d", "ready", { order: 4 })];
    const settled = settle({ sessions, rule: rule(sessions), prev: { drawn: "all", linger: new Map() }, operated: idle, now: NOW, exitMs: EXIT });
    // 待命的 d 算工作中，规则要它：不淡出。
    expect(sorted(settled.leaving)).toEqual(["b", "c"]);
    expect(sorted(settled.drawn as Set<string>)).toEqual(["a", "b", "c", "d"]);
  });

  describe("祖先不早于后代离开", () => {
    const chain = [s("p", "running", { order: 1 }), s("c", "running", { parent: "p", order: 2 })];
    const finished = [s("p", "done", { order: 1 }), s("c", "done", { parent: "p", order: 2 })];

    it("子被操作着：父也留着（哪怕父没人碰），免得子看起来直接挂在来源上；子松手后两个一起淡出", () => {
      const prev = first(chain);
      const operated = (id: string): boolean => id === "c";
      const held = settle({ sessions: finished, rule: rule(finished), prev, operated, now: NOW, exitMs: EXIT });
      expect(sorted(held.held)).toEqual(["c", "p"]);
      expect(held.leaving.size).toBe(0);

      const fading = settle({ sessions: finished, rule: rule(finished), prev: held, operated: idle, now: NOW + 500, exitMs: EXIT });
      expect(sorted(fading.leaving)).toEqual(["c", "p"]);
      expect(fading.linger.get("p")).toBe(NOW + 500);
      expect(fading.linger.get("c")).toBe(NOW + 500);
    });

    it("父被操作着、子没人碰：子照常淡出离开，父留着", () => {
      const prev = first(chain);
      const operated = (id: string): boolean => id === "p";
      const held = settle({ sessions: finished, rule: rule(finished), prev, operated, now: NOW, exitMs: EXIT });
      expect(sorted(held.held)).toEqual(["p"]);
      expect(sorted(held.leaving)).toEqual(["c"]);
      const later = settle({ sessions: finished, rule: rule(finished), prev: held, operated, now: NOW + EXIT, exitMs: EXIT });
      expect(sorted(later.drawn as Set<string>)).toEqual(["p"]);
    });

    it("父比子更早开始淡出时，也要等子离开之后才离开", () => {
      const linger = new Map<string, Linger>([["p", NOW], ["c", NOW + 100]]);
      const prev: Drawn = { drawn: new Set(["p", "c"]), linger };
      const mid = settle({ sessions: finished, rule: rule(finished), prev, operated: idle, now: NOW + 250, exitMs: EXIT });
      expect(sorted(mid.drawn as Set<string>)).toEqual(["c", "p"]);
      const end = settle({ sessions: finished, rule: rule(finished), prev: { drawn: mid.drawn, linger: mid.linger }, operated: idle, now: NOW + 340, exitMs: EXIT });
      expect((end.drawn as Set<string>).size).toBe(0);
    });
  });
});

describe("leavingNodes · 哪些节点跟着淡出", () => {
  const area = { w: 1200, h: 700 };
  const sessions = [
    s("a1", "running", { origin: "A", order: 1, workspace: "C:\\repo" }),
    s("a2", "done", { origin: "A", order: 2, workspace: "C:\\repo" }),
    s("b1", "done", { origin: "B", order: 3, workspace: "C:\\repo" }),
  ];
  const layout = layoutScene(sessions, { area, git: new Map([["A", "wt"], ["B", "wt"]]) });

  it("没有淡出的会话：空", () => {
    expect(leavingNodes(layout, new Set()).size).toBe(0);
  });

  it("只有一个会话淡出、同来源还有别的：只有这一个会话节点", () => {
    expect(sorted(leavingNodes(layout, new Set(["a2"])))).toEqual(["agent:a2"]);
  });

  it("来源下的会话全部淡出：来源卡一起；它的 Folder / Git 还服务着别的来源时不动", () => {
    const out = leavingNodes(layout, new Set(["b1"]));
    expect(out.has("agent:b1")).toBe(true);
    expect(out.has("origin:B")).toBe(true);
    expect(out.has("origin:A")).toBe(false);
    expect([...out].some((id) => id.startsWith("folder:"))).toBe(false);
    expect([...out].some((id) => id.startsWith("git:"))).toBe(false);
  });

  it("共用的 Folder 与 Git 在所有来源都淡出时才一起淡出", () => {
    const out = leavingNodes(layout, new Set(["a1", "a2", "b1"]));
    expect(out.has("origin:A")).toBe(true);
    expect(out.has("origin:B")).toBe(true);
    expect([...out].some((id) => id.startsWith("folder:"))).toBe(true);
    expect([...out].some((id) => id.startsWith("git:"))).toBe(true);
  });

  describe("keep：被隐藏了相关节点的来源卡自己留下，会话与只为它服务的 Folder / Git 卡淡出", () => {
    const kinds = (out: ReadonlySet<string>, prefix: string): boolean => [...out].some((id) => id.startsWith(prefix));

    it("来源的会话全部淡出：来源卡不淡出（它要留着当入口），它独占的 Folder / Git 随会话一起淡出", () => {
      const alone = [s("a1", "running", { origin: "A", order: 1, workspace: "C:\\repo" }), s("a2", "running", { origin: "A", order: 2, workspace: "C:\\repo" })];
      const own = layoutScene(alone, { area, git: new Map([["A", "wt"]]) });
      const out = leavingNodes(own, new Set(["a1", "a2"]), new Set(["origin:A"]));
      expect(sorted(out).filter((id) => id.startsWith("agent:"))).toEqual(["agent:a1", "agent:a2"]);
      expect(out.has("origin:A")).toBe(false);
      expect(kinds(out, "folder:")).toBe(true);
      expect(kinds(out, "git:")).toBe(true);
      // 不给 keep：与以前一样，来源卡也淡出。
      expect(leavingNodes(own, new Set(["a1", "a2"])).has("origin:A")).toBe(true);
    });

    it("共用的 Folder / Git 还有别的来源留着：不淡出", () => {
      // A 隐藏了：它的会话（a1、a2）淡出；B 的 b1 仍留着，Folder / Git 还在为 B 服务。
      const out = leavingNodes(layout, new Set(["a1", "a2"]), new Set(["origin:A"]));
      expect(out.has("origin:A")).toBe(false);
      expect(kinds(out, "folder:")).toBe(false);
      expect(kinds(out, "git:")).toBe(false);
    });

    it("它的会话还有没淡出的（正被操作而暂缓）：来源仍在为它们服务，上游的卡不淡出", () => {
      const alone = [s("a1", "running", { origin: "A", order: 1, workspace: "C:\\repo" }), s("a2", "running", { origin: "A", order: 2, workspace: "C:\\repo" })];
      const own = layoutScene(alone, { area, git: new Map([["A", "wt"]]) });
      const out = leavingNodes(own, new Set(["a1"]), new Set(["origin:A"]));
      expect(out.has("origin:A")).toBe(false);
      expect(kinds(out, "folder:")).toBe(false);
      expect(kinds(out, "git:")).toBe(false);
    });

    it("keep 里没有的来源照旧：全部淡出时一起淡出", () => {
      const out = leavingNodes(layout, new Set(["b1"]), new Set(["origin:A"]));
      expect(out.has("origin:B")).toBe(true);
      expect(out.has("origin:A")).toBe(false);
    });
  });
});
