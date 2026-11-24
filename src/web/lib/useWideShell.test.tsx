import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWideShell, WIDE_SHELL_MIN } from "./useWideShell";

/**
 * 外壳宽窄状态要在浏览器布局与 `ResizeObserver` 之前同步完成（LAYOUT7 · W13）。
 *
 * 浏览器里的顺序：`resize` 事件 → 监听器返回后的微任务检查点 → 布局 → `ResizeObserver`；而 React 对 `resize` 里的 `setState` 用连续事件优先级、
 * 交给调度器的宏任务，所以旧写法（`useState` 加监听器）会让画布量到“窗口已变、外壳还没换”的过渡区域。
 * 测试里没有布局，只能量到前半段：不用 `act` 包裹事件（`act` 会替 React 把所有更新冲刷干净，什么顺序都看不出来），
 * 派发 `resize` 之后只等一个微任务，DOM 就已经是新的状态——这对应的就是“早于布局与 `ResizeObserver`”。
 * happy-dom 没有实现 `window.event`，旧写法的更新落在默认优先级上，同样走宏任务，所以对照用例在这里与真实浏览器等价。
 */

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalWidth = window.innerWidth;

const setWidth = (width: number): void => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
};
/** 改窗口宽度并派发 `resize`：不包 `act`。 */
const resize = (width: number): void => {
  setWidth(width);
  window.dispatchEvent(new Event("resize"));
};

let renders = 0;
function Probe(): ReactNode {
  renders += 1;
  return <div id="probe" data-wide={String(useWideShell())} />;
}

/** 旧写法（`useState` 加 `resize` 监听），只用来对照。 */
function useLegacyWideShell(): boolean {
  const [wide, setWide] = useState<boolean>(() => window.innerWidth >= WIDE_SHELL_MIN);
  useEffect(() => {
    const onResize = (): void => setWide(window.innerWidth >= WIDE_SHELL_MIN);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return wide;
}
function LegacyProbe(): ReactNode {
  return <div id="probe" data-wide={String(useLegacyWideShell())} />;
}

describe("useWideShell：外壳宽窄状态在同一个微任务里换好", () => {
  let host: HTMLDivElement;
  let root: Root;
  let previousEnv: boolean | undefined;
  let mounted: boolean;

  const wide = (): string | null => host.querySelector("#probe")?.getAttribute("data-wide") ?? null;
  /** 挂载要靠 `act` 冲刷（订阅在 effect 里）；挂好之后关掉 act 环境，后面的事件不再有它帮忙。 */
  const mount = (element: ReactNode): void => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.render(element));
    mounted = true;
    env.IS_REACT_ACT_ENVIRONMENT = false;
  };
  const unmount = (): void => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.unmount());
    mounted = false;
    env.IS_REACT_ACT_ENVIRONMENT = false;
  };
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const until = async (check: () => boolean): Promise<void> => {
    for (let tries = 0; tries < 60 && !check(); tries++) await sleep(5);
  };

  beforeEach(() => {
    previousEnv = env.IS_REACT_ACT_ENVIRONMENT;
    renders = 0;
    setWidth(1280);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mounted = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (mounted) unmount();
    host.remove();
    setWidth(originalWidth);
    env.IS_REACT_ACT_ENVIRONMENT = previousEnv;
  });

  it("没有 act 帮忙：resize 之后只过一个微任务，DOM 就已经换成新的宽窄状态（宽 → 窄 → 宽）", async () => {
    mount(<Probe />);
    expect(wide()).toBe("true");
    resize(800);
    await Promise.resolve();
    expect(wide()).toBe("false");
    resize(1440);
    await Promise.resolve();
    expect(wide()).toBe("true");
  });

  it("对照：旧写法（useState + 监听器）同样的事件之后，一个微任务里还没换，要等调度器的宏任务", async () => {
    mount(<LegacyProbe />);
    expect(wide()).toBe("true");
    resize(800);
    await Promise.resolve();
    expect(wide(), "旧写法在微任务里还是旧的状态——外壳还没换，此时浏览器已经在布局").toBe("true");
    await until(() => wide() === "false");
    expect(wide(), "宏任务之后才换过来").toBe("false");
  });

  it.each([
    [859, "false"],
    [860, "true"],
    [861, "true"],
  ])("阈值：宽度 %i 时宽屏 = %s（刚挂载与从另一侧 resize 过来都一样）", async (width, expected) => {
    setWidth(width);
    mount(<Probe />);
    expect(wide(), "刚挂载").toBe(expected);

    resize(width < WIDE_SHELL_MIN ? 1280 : 300);
    await Promise.resolve();
    expect(wide(), "先到另一侧").toBe(width < WIDE_SHELL_MIN ? "true" : "false");
    resize(width);
    await Promise.resolve();
    expect(wide(), "再回到这个宽度").toBe(expected);
  });

  it("阈值就是 860：窄屏顶栏与宽屏侧栏的分界，沿用 app.tsx 原来的取值（样式里没有按它写的媒体查询，外壳只由这个状态决定）", () => {
    expect(WIDE_SHELL_MIN).toBe(860);
  });

  it("连续多次：每一次翻转都立刻跟上；同一个任务里来回几次，以最后一次的宽度为准", async () => {
    mount(<Probe />);
    for (const [width, expected] of [[500, "false"], [1200, "true"], [859, "false"], [860, "true"], [300, "false"]] as const) {
      resize(width);
      await Promise.resolve();
      expect(wide(), `${width}`).toBe(expected);
    }
    resize(1200);
    resize(500);
    resize(1000);
    resize(700);
    await Promise.resolve();
    expect(wide(), "最后一次是 700").toBe("false");
    resize(300);
    resize(1000);
    await Promise.resolve();
    expect(wide(), "最后一次是 1000").toBe("true");
  });

  it("宽窄没变的 resize（在同一侧拖动窗口）不引起重渲染：整个 App 不会随窗口宽度每一帧重画", async () => {
    mount(<Probe />);
    const before = renders;
    for (const width of [1281, 1300, 1500, 1920, 1100, 860]) resize(width);
    await Promise.resolve();
    await sleep(50); // 再给调度器的宏任务留出时间：也不能有迟到的渲染
    expect(renders).toBe(before);
    expect(wide()).toBe("true");
  });

  it("卸载之后不再监听：登记过的 resize 监听器被原样摘掉，之后的 resize 不再引起任何更新或警告", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(<Probe />);
    const listeners = added.mock.calls.filter(([type]) => type === "resize").map(([, listener]) => listener);
    expect(listeners, "挂载时只登记一次").toHaveLength(1);

    unmount();
    expect(
      removed.mock.calls.some(([type, listener]) => type === "resize" && listener === listeners[0]),
      "卸载时摘掉的就是登记的那一个",
    ).toBe(true);

    const before = renders;
    resize(500);
    await Promise.resolve();
    await sleep(50);
    expect(renders).toBe(before);
    expect(errors).not.toHaveBeenCalled();
  });

  it("服务端渲染（没有 window）按宽屏：与改写之前一致", () => {
    vi.stubGlobal("window", undefined);
    try {
      expect(renderToString(<Probe />)).toContain('data-wide="true"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
