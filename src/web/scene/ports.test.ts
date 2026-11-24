import { describe, expect, it, vi } from "vitest";
import { LEFT, RIGHT } from "./pipes";
import { NodePorts } from "./ports";

const dotsOf = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(":scope > i.node-port")];
const dot = (host: HTMLElement, side: "right" | "bottom" | "left" | "top"): HTMLElement => host.querySelector<HTMLElement>(`:scope > i.node-port[data-side="${side}"]`)!;

describe("端口方点（NodePorts）", () => {
  it("在节点元素里放四个方点，每条边一个，默认都是熄灭的，对读屏隐藏", () => {
    const host = document.createElement("div");
    host.append(document.createElement("span"));
    const ports = new NodePorts(host);
    expect(ports.host).toBe(host);
    const dots = dotsOf(host);
    expect(dots.map((el) => el.getAttribute("data-side")).sort()).toEqual(["bottom", "left", "right", "top"]);
    for (const el of dots) {
      expect(el.hasAttribute("data-on")).toBe(false);
      expect(el.hasAttribute("data-phase")).toBe(false);
      expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.tagName).toBe("I");
    }
    // 原有的子元素不动，方点放在后面。
    expect(host.firstElementChild?.tagName).toBe("SPAN");
  });

  it("place 把落点写成相对节点左上角的 CSS 变量；没变不重写，变了才写，小数取两位", () => {
    const host = document.createElement("div");
    const ports = new NodePorts(host);
    const right = dot(host, "right");
    const spy = vi.spyOn(right.style, "setProperty");
    ports.place(RIGHT, 212, 56);
    expect(right.style.getPropertyValue("--port-x")).toBe("212px");
    expect(right.style.getPropertyValue("--port-y")).toBe("56px");
    expect(spy).toHaveBeenCalledTimes(2);
    ports.place(RIGHT, 212, 56);
    expect(spy).toHaveBeenCalledTimes(2);
    ports.place(RIGHT, 104.456, 56.004);
    expect(right.style.getPropertyValue("--port-x")).toBe("104.46px");
    expect(right.style.getPropertyValue("--port-y")).toBe("56px");
    expect(spy).toHaveBeenCalledTimes(4);
    // 另外三条边互不影响。
    ports.place(LEFT, 0, 72);
    expect(dot(host, "left").style.getPropertyValue("--port-x")).toBe("0px");
    expect(dot(host, "left").style.getPropertyValue("--port-y")).toBe("72px");
    expect(dot(host, "top").style.getPropertyValue("--port-x")).toBe("");
  });

  it("apply：有连线的边点亮，颜色取接着的连线里最活跃的阶段；没有连线的边保持熄灭", () => {
    const host = document.createElement("div");
    const ports = new NodePorts(host);
    ports.apply(["running", undefined, undefined, undefined]);
    expect(dot(host, "right").hasAttribute("data-on")).toBe(true);
    expect(dot(host, "right").getAttribute("data-phase")).toBe("running");
    for (const side of ["bottom", "left", "top"] as const) {
      expect(dot(host, side).hasAttribute("data-on")).toBe(false);
      expect(dot(host, side).hasAttribute("data-phase")).toBe(false);
    }
    ports.apply([undefined, "link", "failed", "done"]);
    expect(dotsOf(host).filter((el) => el.hasAttribute("data-on")).map((el) => el.getAttribute("data-side")).sort()).toEqual(["bottom", "left", "top"]);
    expect(dot(host, "right").hasAttribute("data-on")).toBe(false);
    expect(dot(host, "left").getAttribute("data-phase")).toBe("failed");
    expect(dot(host, "bottom").getAttribute("data-phase")).toBe("link");
    expect(dot(host, "top").getAttribute("data-phase")).toBe("done");
    // 熄灭时保留原来的颜色，淡出的时候不会闪成灰色。
    expect(dot(host, "right").getAttribute("data-phase")).toBe("running");
  });

  it("逐帧调用 apply 不碰 DOM：状态没变就一个属性也不写", () => {
    const host = document.createElement("div");
    const ports = new NodePorts(host);
    ports.apply(["running", undefined, "done", undefined]);
    const writes = dotsOf(host).flatMap((el) => [vi.spyOn(el, "setAttribute"), vi.spyOn(el, "removeAttribute")]);
    for (let i = 0; i < 50; i++) ports.apply(["running", undefined, "done", undefined]);
    expect(writes.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    ports.apply(["failed", undefined, "done", undefined]);
    expect(dot(host, "right").getAttribute("data-phase")).toBe("failed");
    expect(writes.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(1);
  });

  it("reset 熄灭全部；dispose 把方点从节点里拿走，原有子元素不受影响", () => {
    const host = document.createElement("div");
    const child = document.createElement("section");
    host.append(child);
    const ports = new NodePorts(host);
    ports.apply(["running", "failed", "done", "link"]);
    expect(dotsOf(host).every((el) => el.hasAttribute("data-on"))).toBe(true);
    ports.reset();
    expect(dotsOf(host).some((el) => el.hasAttribute("data-on"))).toBe(false);
    ports.apply(["running", undefined, undefined, undefined]);
    expect(dot(host, "right").hasAttribute("data-on")).toBe(true);
    ports.dispose();
    expect(dotsOf(host)).toHaveLength(0);
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild).toBe(child);
  });
});
