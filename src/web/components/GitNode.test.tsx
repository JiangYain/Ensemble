import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitSnapshot } from "@shared/protocol";
import type { GitEntry } from "../lib/git";
import { setLang } from "../lib/app";
import type { SceneEngine } from "../scene/engine";
import { GitNode } from "./GitNode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 工作树的标识（`GitSnapshot.root` 规范化后的写法，见 worktreeKey）。 */
const WORKTREE = "c:/users/alice/desktop/ensemble";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const checkedAt = new Date(2026, 0, 2, 17, 50, 22).toISOString();
const committedAt = new Date(2026, 0, 2, 9, 5, 0).toISOString();

function snapshot(extra: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    root: "C:\\Users\\alice\\Desktop\\Ensemble",
    branch: "main",
    detached: false,
    head: { sha: SHA, subject: "feat(web): Git 节点", committedAt },
    changes: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    checkedAt,
    ...extra,
  };
}

describe("Git 卡片", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const register = vi.fn(() => () => undefined);
  const toggleSelection = vi.fn();
  const moveNode = vi.fn();
  const engine = { register, toggleSelection, moveNode } as unknown as SceneEngine;

  beforeEach(() => {
    setLang("zh");
    register.mockClear();
    toggleSelection.mockClear();
    moveNode.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (git: Partial<GitSnapshot> = {}, stale = false): HTMLElement => {
    const entry: GitEntry = { git: snapshot(git), stale };
    act(() => root.render(<GitNode worktree={WORKTREE} entry={entry} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.git")!;
  };
  const press = (node: HTMLElement, init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      node.dispatchEvent(event);
    });
    return event;
  };

  it("以 git:<工作树> 注册到画布，并带着节点标识：节点 id 只取决于工作树，与指向它的来源无关", () => {
    const node = render();
    expect(register).toHaveBeenCalledWith(`git:${WORKTREE}`, node);
    expect(node.getAttribute("data-node-id")).toBe(`git:${WORKTREE}`);
    expect(node.hasAttribute("data-node")).toBe(true);
  });

  it("头部是身份（Git / 仓库目录名），正文依次是分支、最近提交（短哈希 + 说明）、工作区状态", () => {
    const node = render({ changes: { files: 3, staged: 1, unstaged: 1, untracked: 1, conflicted: 0 } });
    expect(node.querySelector(".o-label")?.textContent).toBe("Git");
    expect(node.querySelector(".a-model")?.textContent).toBe("Ensemble");
    expect(node.querySelector(".o-main .o-text")?.textContent).toBe("main");
    expect(node.querySelector(".o-sub .g-sha")?.textContent).toBe("a1b2c3d");
    expect(node.querySelector(".o-sub")?.textContent).toBe("a1b2c3dfeat(web): Git 节点");
    expect(node.querySelector(".o-title")?.textContent).toBe("3 个文件有改动");
    expect(node.querySelector(".o-title")?.hasAttribute("data-kind")).toBe(false);
    // 没有上游、读取正常：头部右端什么都不画。
    expect(node.querySelector(".o-count")).toBeNull();
    expect(node.getAttribute("aria-label")).toBe("Git 仓库：Ensemble");
  });

  it("头部最左就是 Git 图标：没有抓手或别的装饰，结构与来源卡头部一致（图标格 → 标签 → 名字）", () => {
    const head = render().querySelector(".o-head")!;
    expect(head.querySelector(".node-grip")).toBeNull();
    expect([...head.children].map((child) => child.className)).toEqual(["a-mark", "o-label", "a-model"]);
    expect(head.querySelector(".a-mark svg")).not.toBeNull();
  });

  it("工作区干净就这么写", () => {
    expect(render().querySelector(".o-title")?.textContent).toBe("工作区干净");
  });

  it("有冲突时状态行写冲突数，并标成需要处理的样式", () => {
    const node = render({ changes: { files: 5, staged: 0, unstaged: 3, untracked: 0, conflicted: 2 } });
    const status = node.querySelector(".o-title")!;
    expect(status.textContent).toBe("2 个冲突");
    expect(status.getAttribute("data-kind")).toBe("attention");
  });

  it("与上游有差距时头部右端显示领先 / 落后的提交数，各自带提示；差距为零的一边不画", () => {
    const node = render({ upstream: { name: "origin/main", ahead: 2, behind: 0 } });
    const chips = [...node.querySelectorAll(".g-chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["2"]);
    expect(chips[0]!.getAttribute("data-tip")).toBe("上游: origin/main · 领先 2 个提交");

    const both = render({ upstream: { name: "origin/main", ahead: 1, behind: 14 } });
    const text = [...both.querySelectorAll(".g-chip")].map((chip) => chip.textContent);
    expect(text).toEqual(["1", "14"]);
    expect(both.querySelectorAll(".g-chip")[1]!.getAttribute("data-tip")).toBe("上游: origin/main · 落后 14 个提交");

    // 与上游一致：不画，悬停提示里说明。
    const same = render({ upstream: { name: "origin/main", ahead: 0, behind: 0 } });
    expect(same.querySelector(".o-count")).toBeNull();
    expect(same.getAttribute("data-tip")).toContain("上游: origin/main · 与上游一致");
  });

  it("游离 HEAD：主行写明，提交行仍给出短哈希", () => {
    const node = render({ branch: undefined, detached: true });
    expect(node.querySelector(".o-main .o-text")?.textContent).toBe("游离 HEAD");
    expect(node.querySelector(".o-sub .g-sha")?.textContent).toBe("a1b2c3d");
    expect(node.getAttribute("data-tip")).toContain("分支: 游离 HEAD");
  });

  it("还没有任何提交的新仓库：提交行如实写“还没有提交”", () => {
    const node = render({ head: undefined });
    expect(node.querySelector(".o-main .o-text")?.textContent).toBe("main");
    expect(node.querySelector(".o-sub")?.textContent).toBe("还没有提交");
    expect(node.querySelector(".g-sha")).toBeNull();
  });

  it("悬停提示给出目录、分支、上游、最近提交、改动明细、远程和读取时间", () => {
    const node = render({
      upstream: { name: "origin/main", ahead: 1, behind: 0 },
      changes: { files: 6, staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
      remote: { name: "origin", url: "github.com/alice/ensemble" },
    });
    const lines = node.getAttribute("data-tip")!.split("\n");
    expect(lines[0]).toBe("Git 仓库");
    expect(lines).toContain("目录: C:\\Users\\alice\\Desktop\\Ensemble");
    expect(lines).toContain("分支: main");
    expect(lines).toContain("上游: origin/main · 领先 1 个提交");
    expect(lines).toContain("最近提交: a1b2c3d feat(web): Git 节点 (2026年1月2日 09:05)");
    expect(lines).toContain("改动: 已暂存 1 · 未暂存 2 · 未跟踪 3");
    expect(lines).toContain("远程: origin github.com/alice/ensemble");
    expect(lines.at(-1)).toMatch(/^读取于: /);
  });

  it("没有改动、没有远程、没有上游时，提示里不出现对应的行", () => {
    const lines = render().getAttribute("data-tip")!.split("\n");
    expect(lines.some((line) => line.startsWith("远程"))).toBe(false);
    expect(lines.some((line) => line.startsWith("上游"))).toBe(false);
    expect(lines).toContain("改动: 工作区干净");
  });

  it("最近一次读取失败时：卡片标成旧的，头部多一个钟表，提示里写明显示的是哪个时刻的状态", () => {
    const fresh = render();
    expect(fresh.hasAttribute("data-stale")).toBe(false);
    expect(fresh.querySelector(".g-stale")).toBeNull();

    const node = render({}, true);
    expect(node.hasAttribute("data-stale")).toBe(true);
    const clock = node.querySelector(".g-stale")!;
    expect(clock.getAttribute("data-tip")).toMatch(/^最近一次读取失败，显示的是 .+ 的状态$/);
    expect(node.getAttribute("data-tip")!.split("\n").at(-1)).toMatch(/^最近一次读取失败/);
  });

  it("方向键移动节点（Shift 加速），Shift+空格选择；焦点在内部控件上或带修饰键时不处理", () => {
    const node = render();
    expect(press(node, { key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(moveNode).toHaveBeenLastCalledWith(`git:${WORKTREE}`, 10, 0);
    press(node, { key: "ArrowUp", shiftKey: true });
    expect(moveNode).toHaveBeenLastCalledWith(`git:${WORKTREE}`, 0, -50);
    press(node, { key: " ", shiftKey: true });
    expect(toggleSelection).toHaveBeenCalledWith(`git:${WORKTREE}`);

    moveNode.mockClear();
    press(node, { key: "ArrowLeft", ctrlKey: true });
    const inner = node.querySelector(".o-text")!;
    act(() => {
      inner.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(moveNode).not.toHaveBeenCalled();
  });

  it("英文界面：单复数与措辞", () => {
    setLang("en");
    const one = render({ changes: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }, upstream: { name: "origin/main", ahead: 1, behind: 3 } });
    expect(one.querySelector(".o-title")?.textContent).toBe("1 changed file");
    expect([...one.querySelectorAll(".g-chip")].map((chip) => chip.getAttribute("data-tip"))).toEqual(["Upstream: origin/main · 1 commit ahead", "Upstream: origin/main · 3 commits behind"]);
    expect(one.querySelector(".o-main .o-text")?.textContent).toBe("main");
    const clean = render({ head: undefined });
    expect(clean.querySelector(".o-sub")?.textContent).toBe("No commits yet");
    expect(clean.querySelector(".o-title")?.textContent).toBe("Working tree clean");
    setLang("zh");
  });
});
