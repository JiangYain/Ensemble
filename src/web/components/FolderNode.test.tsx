import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../lib/app";
import type { FolderGroup } from "../lib/folder";
import type { SceneEngine } from "../scene/engine";
import { FolderNode } from "./FolderNode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "c:/users/alice/desktop/ensemble";
const PATH = "C:\\Users\\alice\\Desktop\\Ensemble";

function folder(extra: Partial<FolderGroup> = {}): FolderGroup {
  return { key: KEY, path: PATH, origins: ["codex"], ...extra };
}

describe("Folder 卡片", () => {
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

  const render = (group: FolderGroup = folder()): HTMLElement => {
    act(() => root.render(<FolderNode folder={group} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.folder")!;
  };
  const press = (node: HTMLElement, init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      node.dispatchEvent(event);
    });
    return event;
  };

  it("以 folder:<目录> 注册到画布，并带着节点标识：节点 id 只取决于规范化后的目录，与用它的来源无关", () => {
    const node = render();
    expect(register).toHaveBeenCalledWith(`folder:${KEY}`, node);
    expect(node.getAttribute("data-node-id")).toBe(`folder:${KEY}`);
    expect(node.hasAttribute("data-node")).toBe(true);
    // 用它的来源多了一个：id 不变，不会被当成另一张卡重新注册。
    register.mockClear();
    const same = render(folder({ origins: ["codex", "cursor"] }));
    expect(same.getAttribute("data-node-id")).toBe(`folder:${KEY}`);
    expect(register).not.toHaveBeenCalled();
  });

  it("与 Git 卡一样可聚焦、可被选中：同样的节点标记与键盘结构，没有特例", () => {
    const node = render();
    expect(node.getAttribute("tabindex")).toBe("0");
    expect(node.getAttribute("role")).toBe("group");
    expect(node.matches("[data-node][data-node-id]")).toBe(true);
    expect(node.className).toBe("node folder");
  });

  it("头部最左就是文件夹图标：没有抓手或别的装饰，结构与来源卡头部一致（图标格 → 标签）", () => {
    const head = render().querySelector(".o-head")!;
    expect(head.querySelector(".node-grip")).toBeNull();
    expect([...head.children].map((child) => child.className)).toEqual(["a-mark", "o-label"]);
    expect(head.querySelector(".a-mark svg")).not.toBeNull();
    expect(head.querySelector(".o-label")?.textContent).toBe("文件夹");
  });

  it("正文：主行是目录名（带文件夹图标），次行是上级路径；内容只来自 workspace 字符串", () => {
    const node = render();
    expect(node.querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
    expect(node.querySelector(".o-main .o-ico")).not.toBeNull();
    expect(node.querySelector(".o-sub")?.textContent).toBe("C:\\Users\\alice\\Desktop");
    // 次行放不下时省略号在开头（CSS 用 rtl 实现）；路径本身必须用 ltr 隔离，否则 `C:\…` 会被双向算法翻乱。
    expect(node.querySelector(".o-sub > bdi")?.getAttribute("dir")).toBe("ltr");
    // 没有第三行、没有任何“存在 / 不存在”之类不是来自数据的断言。
    expect(node.querySelector(".o-body")!.children).toHaveLength(2);
    expect(node.querySelector(".o-title")).toBeNull();
    expect(node.textContent).not.toMatch(/存在|exist/i);
  });

  it("只有一个 Main Agent 用它时头部右端什么都不画；不止一个才写个数，并带提示", () => {
    expect(render(folder({ origins: ["codex"] })).querySelector(".o-count")).toBeNull();

    const node = render(folder({ origins: ["codex", "cursor", "pi"] }));
    const count = node.querySelector(".o-count")!;
    expect(count.textContent).toBe("3 个 Main Agent");
    expect(count.getAttribute("data-tip")).toBe("3 个 Main Agent 使用这个工作目录");
    expect([...node.querySelector(".o-head")!.children].map((child) => child.className)).toEqual(["a-mark", "o-label", "o-count"]);
  });

  it("根目录没有上级路径：不画次行，也不留空占位；主行仍写它自己", () => {
    const posix = render(folder({ key: "/", path: "/" }));
    expect(posix.querySelector(".o-main .o-text")?.textContent).toBe("/");
    expect(posix.querySelector(".o-sub")).toBeNull();

    const drive = render(folder({ key: "c:/", path: "C:\\" }));
    expect(drive.querySelector(".o-main .o-text")?.textContent).toBe("C:");
    expect(drive.querySelector(".o-sub")).toBeNull();
  });

  it("次行保留来源报告时用的分隔符与写法；结尾的分隔符不影响名字", () => {
    const node = render(folder({ key: "/home/me/repo", path: "/home/me/repo/" }));
    expect(node.querySelector(".o-main .o-text")?.textContent).toBe("repo");
    expect(node.querySelector(".o-sub")?.textContent).toBe("/home/me");
  });

  it("悬停提示给出完整路径；多个来源共用时再多一行“使用者”；单个来源时不出现", () => {
    const one = render().getAttribute("data-tip")!.split("\n");
    expect(one).toEqual(["工作目录", `目录: ${PATH}`]);

    const many = render(folder({ origins: ["codex", "cursor"] })).getAttribute("data-tip")!.split("\n");
    expect(many).toEqual(["工作目录", `目录: ${PATH}`, "2 个 Main Agent 使用这个工作目录"]);
  });

  it("无障碍：名字与键盘说明", () => {
    const node = render();
    expect(node.getAttribute("aria-label")).toBe("文件夹：Ensemble");
    expect(node.getAttribute("aria-description")).toBe("方向键移动文件夹节点，按住 Shift 加速；Shift 加空格选择节点。");
  });

  it("方向键移动节点（Shift 加速），Shift+空格选择；焦点在内部控件上或带修饰键时不处理", () => {
    const node = render();
    expect(press(node, { key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(moveNode).toHaveBeenLastCalledWith(`folder:${KEY}`, 10, 0);
    press(node, { key: "ArrowUp", shiftKey: true });
    expect(moveNode).toHaveBeenLastCalledWith(`folder:${KEY}`, 0, -50);
    press(node, { key: " ", shiftKey: true });
    expect(toggleSelection).toHaveBeenCalledWith(`folder:${KEY}`);

    moveNode.mockClear();
    press(node, { key: "ArrowLeft", ctrlKey: true });
    const inner = node.querySelector(".o-text")!;
    act(() => {
      inner.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(moveNode).not.toHaveBeenCalled();
  });

  it("英文界面：标签、单复数与措辞", () => {
    setLang("en");
    const node = render(folder({ origins: ["codex", "cursor"] }));
    expect(node.querySelector(".o-label")?.textContent).toBe("Folder");
    expect(node.querySelector(".o-count")?.textContent).toBe("2 Main Agents");
    expect(node.querySelector(".o-count")?.getAttribute("data-tip")).toBe("Used by 2 Main Agents");
    expect(node.getAttribute("aria-label")).toBe("Folder: Ensemble");
    expect(node.getAttribute("data-tip")!.split("\n")).toEqual(["Working directory", `Directory: ${PATH}`, "Used by 2 Main Agents"]);
    expect(node.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    setLang("zh");
  });
});
