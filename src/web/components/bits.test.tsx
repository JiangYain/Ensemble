import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Clamp, MiddleText, PathText } from "./bits";

/**
 * happy-dom 没有排版：用桩让“量字符串宽度”变成每个字符 7px，并把元素的可用宽度（max-width）固定下来，
 * 这样可以检验组件在“放得下 / 放不下”两种情况下渲染出的结构，而不依赖任何字体。
 */
function stubLayout(available: number): void {
  vi.stubGlobal("getComputedStyle", () => ({ maxWidth: `${available}px` }));
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const isMeasurer = this instanceof HTMLElement && this.style.position === "fixed";
    return { width: isMeasurer ? Array.from(this.textContent ?? "").length * 7 : 0 } as DOMRect;
  });
}

function mount(node: React.ReactNode): { host: HTMLElement; cleanup: () => void } {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

it("lays an identifier out to exactly the characters that fit, keeping the full text in the DOM", () => {
  stubLayout(120);
  const id = "agent-29b3312c-7fda-481f-9447-f4fb2a3549ea";
  const { host, cleanup } = mount(<MiddleText value={id} />);
  try {
    const text = host.querySelector<HTMLElement>(".mid-text")!;
    expect(text.hasAttribute("data-clipped")).toBe(true);
    // 120px / 7px = 17 个字符：头 10 + “…” + 尾 6。
    expect(host.querySelector(".mid-head")?.textContent).toBe("agent-29b3");
    expect(host.querySelector(".mid-tail")?.textContent).toBe("3549ea");
    // 被省略的中段还在 DOM 里（宽度为 0 的那一段），所以选中、复制得到的是完整原文；“…”是伪元素，不在文本里。
    expect(host.querySelector(".fit-hidden")?.textContent).toBe(id.slice(10, -6));
    expect(text.textContent).toBe(id);
    expect(text.dataset["tip"]).toBe(id);
  } finally {
    cleanup();
  }
});

it("lays a path out from its end, hiding only the front", () => {
  stubLayout(120);
  const path = "C:\\Users\\alice\\Desktop\\Ensemble";
  const { host, cleanup } = mount(<PathText value={path} />);
  try {
    const text = host.querySelector<HTMLElement>(".path-text")!;
    expect(text.hasAttribute("data-clipped")).toBe(true);
    expect(host.querySelector(".fit-hidden")?.textContent).toBe("C:\\Users\\alice\\");
    expect(host.querySelector(".path-shown")?.textContent).toBe("Desktop\\Ensemble");
    expect(text.textContent).toBe(path);
  } finally {
    cleanup();
  }
});

it("renders text untouched when it fits", () => {
  stubLayout(400);
  const { host, cleanup } = mount(
    <>
      <MiddleText value="ses_01m7cqe58n82cwqn2v0pgzmhad" />
      <PathText value={"C:\\work\\demo"} />
    </>,
  );
  try {
    expect(host.querySelector("[data-clipped]")).toBeNull();
    expect(host.querySelector(".fit-hidden")).toBeNull();
    expect(host.querySelector(".mid-text")?.textContent).toBe("ses_01m7cqe58n82cwqn2v0pgzmhad");
    expect(host.querySelector(".path-shown")?.textContent).toBe("C:\\work\\demo");
  } finally {
    cleanup();
  }
});

it("splits an identifier into head and tail without duplicating or altering any text", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const id = "agent-29b3312c-7fda-481f-9447-f4fb2a3549ea";
    act(() => root.render(<MiddleText value={id} />));
    const text = host.querySelector<HTMLElement>(".mid-text")!;
    // 选中、复制、读屏得到的都是完整原文，而不是被切成两份的拷贝。
    expect(text.textContent).toBe(id);
    expect(host.querySelector(".mid-tail")?.textContent).toBe("3549ea");
    expect(host.querySelector(".mid-head")?.textContent).toBe(id.slice(0, -6));
    expect(text.dataset["tip"]).toBe(id);
    // 尾部宽度由文字本身决定（比例字体下没有“几个字符 = 几 ch”这回事），不再往元素上塞内联样式。
    expect(text.getAttribute("style")).toBeNull();

    // 悬停提示可以带上额外说明（例如标识符的类型），仍然不改变显示的文本。
    act(() => root.render(<MiddleText value={id} tail={4} tip={`Cursor Agent\n${id}`} />));
    expect(host.querySelector<HTMLElement>(".mid-text")!.dataset["tip"]).toBe(`Cursor Agent\n${id}`);
    expect(host.querySelector(".mid-tail")?.textContent).toBe("49ea");
    expect(host.querySelector<HTMLElement>(".mid-text")!.textContent).toBe(id);

    // 比尾部还短的值：头部为空、尾部是整个值，不会出现负数切片。
    act(() => root.render(<MiddleText value="abc" />));
    expect(host.querySelector(".mid-head")?.textContent).toBe("");
    expect(host.querySelector(".mid-tail")?.textContent).toBe("abc");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("offers expansion when a resize makes previously fitting text overflow", () => {
  let resize: (() => void) | undefined;
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      resize = () => callback([], this as unknown as ResizeObserver);
    }
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", Observer);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Clamp lines={3} expandLabel="展开" collapseLabel="收起">长文字</Clamp>));
    const body = host.querySelector(".clamp-body")!;
    let height = 100;
    Object.defineProperties(body, { clientHeight: { get: () => 100 }, scrollHeight: { get: () => height } });
    expect(host.querySelector("button")).toBeNull();
    height = 180;
    act(() => resize?.());
    expect(host.querySelector("button")?.textContent).toBe("展开");
    act(() => host.querySelector("button")?.click());
    expect(host.querySelector("button")?.textContent).toBe("收起");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
