import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../lib/app";
import { EmptyScene } from "./EmptyScene";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("空画布的引导图", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("装饰用的两条线与连线改成按方向选边之前一模一样：从来源卡右缘出发、进入两张会话卡的左缘", () => {
    act(() => root.render(<EmptyScene />));
    const paths = [...host.querySelectorAll<SVGPathElement>(".ghost svg path.pipe-tube")];
    // 来源卡 156×66 居中于 156 高的画布（右缘中点 (156, 78)）；会话卡 196×66，左缘在 x = 260，中点高 33 / 123。
    expect(paths.map((path) => path.getAttribute("d"))).toEqual(["M156 78C208 78 208 33 260 33", "M156 78C208 78 208 123 260 123"]);
    for (const path of paths) {
      expect(path.getAttribute("fill")).toBe("none");
      expect(path.getAttribute("data-phase")).toBe("idle");
    }
  });

  it("引导图里没有端口方点（它们只属于引擎管理的真实节点）", () => {
    act(() => root.render(<EmptyScene />));
    expect(host.querySelectorAll(".node-port")).toHaveLength(0);
  });

  it("页面不发起委派：没有任何可点的入口，只有标题与一句说明委派从哪里发起（中英文）", () => {
    act(() => root.render(<EmptyScene />));
    expect(host.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    expect(host.querySelector(".empty-title")?.textContent).toBe("还没有被委派出去的会话");
    expect(host.querySelector(".empty-sub")?.textContent).toBe("委派由主 Agent 通过 Ensemble 的 MCP 工具发起，派出的会话会显示在这里。");

    act(() => setLang("en"));
    act(() => root.render(<EmptyScene />));
    expect(host.querySelector(".empty-title")?.textContent).toBe("Nothing has been delegated yet");
    expect(host.querySelector(".empty-sub")?.textContent).toBe("Delegations are started by the main Agent through Ensemble's MCP tools. The sessions it starts will show up here.");
  });
});
