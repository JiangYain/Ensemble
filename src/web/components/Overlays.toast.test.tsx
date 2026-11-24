import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, store, toast } from "../lib/app";
import { Toasts } from "./Overlays";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Toasts：提示里的小动作（例如归档之后的“撤销”）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ toasts: [] });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Toasts />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
  });

  const actions = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>(".toast .toast-action")];

  it("没有动作的提示和以前一样：只有文字和关闭按钮", () => {
    act(() => toast("success", "已归档 1 个会话", 0));
    expect(host.querySelector(".toast-text")?.textContent).toBe("已归档 1 个会话");
    expect(actions()).toEqual([]);
    expect(host.querySelectorAll(".toast button")).toHaveLength(1);
  });

  it("带动作的提示多一个按钮（普通的 button，Tab 可达），写着动作的名字，夹在文字与“忽略”之间", () => {
    act(() => toast("success", "已归档 2 个会话", 0, { label: "撤销", run: () => undefined }));
    const [action] = actions();
    expect(action?.tagName).toBe("BUTTON");
    expect(action?.textContent).toBe("撤销");
    expect(action?.getAttribute("type")).toBe("button");
    expect(action?.getAttribute("tabindex")).toBeNull();
    // 第一个是图标（svg，类名不是字符串），所以按 class 属性取第一个词，再跳过图标。
    const order = [...host.querySelector(".toast")!.children].map((child) => child.getAttribute("class")?.split(" ")[0]);
    expect(order.slice(1)).toEqual(["toast-text", "link-btn", "icon-btn"]);
  });

  it("点它：先收起这条提示，再执行动作，动作只执行一次", () => {
    const seen: number[] = [];
    const run = vi.fn(() => {
      // 执行动作的时候，这条提示已经不在了。
      seen.push(store.get().toasts.length);
    });
    act(() => toast("success", "已归档 2 个会话", 0, { label: "撤销", run }));
    act(() => actions()[0]!.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([0]);
    expect(store.get().toasts).toEqual([]);
    expect(host.querySelector(".toast")).toBeNull();
  });

  it("只有带动作的那一条有按钮；点“忽略”不会执行动作", () => {
    const run = vi.fn();
    act(() => {
      toast("info", "别的提示", 0);
      toast("success", "已归档 3 个会话", 0, { label: "撤销", run });
    });
    expect(host.querySelectorAll(".toast")).toHaveLength(2);
    expect(actions()).toHaveLength(1);
    expect(actions()[0]?.closest(".toast")?.querySelector(".toast-text")?.textContent).toBe("已归档 3 个会话");

    const dismiss = actions()[0]!.closest(".toast")!.querySelector<HTMLButtonElement>('button[aria-label="忽略"]');
    act(() => dismiss!.click());
    expect(run).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".toast")).toHaveLength(1);
  });
});
