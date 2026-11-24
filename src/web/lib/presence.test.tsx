import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./presence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ open, exitMs = 200 }: { open: boolean; exitMs?: number }) {
  const { present, closing } = usePresence(open, exitMs);
  return present ? <div id="body" data-state={closing ? "closing" : "open"} /> : null;
}

describe("退出动画期间保持挂载", () => {
  let host: HTMLDivElement;
  let root: Root;
  const matchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    window.matchMedia = matchMedia;
  });

  const render = (open: boolean, exitMs?: number): void => {
    act(() => root.render(<Probe open={open} {...(exitMs !== undefined ? { exitMs } : {})} />));
  };
  const state = (): string | null | undefined => host.querySelector("#body")?.getAttribute("data-state");

  it("打开的同一帧就挂载，关闭后先进入 closing，播完退出动画才卸载", () => {
    render(false);
    expect(state()).toBeUndefined();

    render(true);
    expect(state()).toBe("open");

    render(false);
    expect(state()).toBe("closing");
    act(() => vi.advanceTimersByTime(199));
    expect(state()).toBe("closing");
    act(() => vi.advanceTimersByTime(2));
    expect(state()).toBeUndefined();
  });

  it("初始就是打开的：直接挂载，没有进入阶段的额外状态", () => {
    render(true);
    expect(state()).toBe("open");
  });

  it("退出动画期间重新打开：取消卸载，回到 open", () => {
    render(true);
    render(false);
    expect(state()).toBe("closing");
    act(() => vi.advanceTimersByTime(120));
    render(true);
    expect(state()).toBe("open");
    act(() => vi.advanceTimersByTime(1000));
    expect(state()).toBe("open");
  });

  it("exitMs 为 0 时关闭后立刻卸载", () => {
    render(true, 0);
    render(false, 0);
    expect(state()).toBeUndefined();
  });

  it("用户偏好减少动态效果时不等退出动画", () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
    render(true);
    render(false);
    expect(state()).toBeUndefined();
  });
});
