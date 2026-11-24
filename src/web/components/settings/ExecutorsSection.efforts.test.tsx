import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HarnessInfo, ModelInfo } from "@shared/types";
import { ApiError } from "../../lib/api";
import { store } from "../../lib/app";
import { harness, installRig } from "./executors.rig";

describe("设置 · 执行端：主 Agent 可选的模型", () => {
  const { pending, calls, effortCalls, stats, show, rows, rowOf, moreOf, regionOf, levelsOf, levelInput, expand, tick, bulk, settle } = installRig();

  describe("推理强度（次级区）", () => {
    const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const LONG = "GPT-5.6-Codex-Max-Preview-2026-11-01（含扩展推理与长上下文）";
    const LEVELED: ModelInfo[] = [
      { id: "gpt-long", label: LONG, isDefault: true, efforts: LEVELS },
      { id: "plain", label: "Plain" },
      { id: "luna", label: "Luna", efforts: ["low", "medium", "high"] },
    ];
    const leveled = (patch: Partial<HarnessInfo> = {}): HarnessInfo => harness({ models: LEVELED, defaultModel: "gpt-long", ...patch });

    it("初始列表不铺开档位，也不默认展开；名字完整，没有档位的模型没有假控件", () => {
      show(leveled());
      expect(document.body.querySelector(".mefforts")).toBeNull();
      expect(document.body.textContent).not.toContain("xhigh");
      expect(rowOf(LONG).querySelector(".mrow-name")?.textContent).toBe(LONG);
      expect(moreOf("Plain")).toBeNull();
      for (const label of [LONG, "Luna"]) {
        expect(moreOf(label)?.getAttribute("aria-expanded")).toBe("false");
        expect(moreOf(label)?.tagName).toBe("BUTTON");
      }
      expect(moreOf(LONG)?.textContent).toContain("6/6");
      expect(moreOf("Luna")?.textContent).toContain("3/3");
    });

    it("展开钮是独立的按钮，不在勾选框的标签里；展开后是带分组名的一组复选框，默认全勾上", () => {
      show(leveled());
      expect(rowOf("Luna").contains(moreOf("Luna"))).toBe(false);
      expand("Luna");
      expect(moreOf("Luna")?.getAttribute("aria-expanded")).toBe("true");
      const region = regionOf("Luna")!;
      expect(moreOf("Luna")?.getAttribute("aria-controls")).toBe(region.id);
      expect(region.getAttribute("role")).toBe("group");
      expect(region.getAttribute("aria-label")).toContain("Luna");
      expect(levelsOf("Luna")).toEqual(["low:on", "medium:on", "high:on"]);
      expect([...region.querySelectorAll("input")].every((input) => input.type === "checkbox")).toBe(true);
      // 展开的只有这一个模型；再点一次收起。
      expect(regionOf(LONG)).toBeNull();
      expand("Luna");
      expect(regionOf("Luna")).toBeNull();
    });

    it("取消某一档保存按模型 id 的整份档位快照；模型名单原样带上；计数与样式随之变化", async () => {
      show(leveled({ allowedModels: ["gpt-long", "luna"] }));
      expand(LONG);
      act(() => levelInput(LONG, "xhigh").click());
      expect(levelsOf(LONG)).toEqual(["low:on", "medium:on", "high:on", "xhigh:off", "max:on", "ultra:on"]);
      expect(calls).toEqual([["gpt-long", "luna"]]);
      expect(effortCalls).toEqual([{ "gpt-long": ["low", "medium", "high", "max", "ultra"] }]);
      await settle();
      expect(store.get().harnesses[0]?.allowedEfforts).toEqual({ "gpt-long": ["low", "medium", "high", "max", "ultra"] });
      expect(moreOf(LONG)?.textContent).toContain("5/6");
      expect(moreOf(LONG)?.getAttribute("data-state")).toBe("limited");

      // 再勾回来：保存的是精确的全部档位，而不是悄悄变回“没有记录”。
      act(() => levelInput(LONG, "xhigh").click());
      await settle();
      expect(effortCalls.at(-1)).toEqual({ "gpt-long": LEVELS });
      expect(moreOf(LONG)?.getAttribute("data-state")).toBe("limited");
    });

    it("显式取消限制只清掉当前模型的档位规则，恢复原生默认", async () => {
      show(leveled({ allowedModels: ["gpt-long", "luna"], allowedEfforts: { "gpt-long": LEVELS, luna: ["high"] } }));
      expand(LONG);
      const reset = regionOf(LONG)?.querySelector("button");
      expect(reset?.textContent).toBe("取消档位限制");
      act(() => reset!.click());
      await settle();
      expect(effortCalls).toEqual([{ luna: ["high"] }]);
      expect(calls).toEqual([["gpt-long", "luna"]]);
      expect(moreOf(LONG)?.getAttribute("data-state")).toBeNull();
      expect(regionOf(LONG)?.querySelector("button")).toBeNull();
      expect(levelsOf(LONG)).toEqual(LEVELS.map((level) => `${level}:on`));
    });

    it("开放的模型至少留一档：最后一档保持可聚焦但不响应；没勾的档位可以重新勾上", async () => {
      show(leveled({ allowedEfforts: { luna: ["high"] } }));
      expand("Luna");
      expect(levelsOf("Luna")).toEqual(["low:off", "medium:off", "high:on"]);
      const last = levelInput("Luna", "high");
      expect(last.disabled).toBe(false);
      expect(last.getAttribute("aria-disabled")).toBe("true");
      act(() => last.click());
      expect(calls).toEqual([]);
      expect(levelsOf("Luna")).toEqual(["low:off", "medium:off", "high:on"]);

      act(() => levelInput("Luna", "low").click());
      await settle();
      expect(effortCalls).toEqual([{ luna: ["low", "high"] }]);
      expect(levelInput("Luna", "high").getAttribute("aria-disabled")).toBeNull();
    });

    it("关闭模型时次级区与展开钮一并消失，重新开放从收起开始；已选档位仍留着", async () => {
      show(leveled({ allowedEfforts: { luna: ["low", "high"] } }));
      expand("Luna");
      tick("Luna");
      expect(regionOf("Luna")).toBeNull();
      expect(moreOf("Luna")).toBeNull();
      await settle();
      tick("Luna");
      await settle();
      expect(moreOf("Luna")?.getAttribute("aria-expanded")).toBe("false");
      expect(regionOf("Luna")).toBeNull();
      expand("Luna");
      expect(levelsOf("Luna")).toEqual(["low:on", "medium:off", "high:on"]);
      // 名单变化时，已有的档位记录原样带着，不被顺手清掉。
      expect(effortCalls.every((efforts) => JSON.stringify(efforts) === JSON.stringify({ luna: ["low", "high"] }))).toBe(true);
    });

    it("“全部开放”只解除模型限制，不动档位记录", async () => {
      show(leveled({ allowedModels: ["gpt-long", "luna"], allowedEfforts: { luna: ["high"] } }));
      act(() => bulk("全部开放").click());
      await settle();
      expect(calls.at(-1)).toBeNull();
      expect(effortCalls.at(-1)).toEqual({ luna: ["high"] });
      expect(store.get().harnesses[0]?.allowedEfforts).toEqual({ luna: ["high"] });
    });

    it("连续修改合并成最新一份，同一时刻只有一个请求；关掉再打开设置窗口仍是用户最后的选择", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        show(leveled());
        expand("Luna");
        act(() => levelInput("Luna", "medium").click());
        act(() => levelInput("Luna", "low").click());
        expect(levelsOf("Luna")).toEqual(["low:off", "medium:off", "high:on"]);
        expect(effortCalls).toEqual([{ luna: ["low", "high"] }]);

        act(() => store.set({ settings: { open: false, section: "executors" } }));
        act(() => vi.advanceTimersByTime(200));
        expect(rows()).toHaveLength(0);
        act(() => store.set({ settings: { open: true, section: "executors" } }));
        expand("Luna");
        // 第一份还没确认，界面显示的是在途的最新选择，而不是服务端旧的全选。
        expect(levelsOf("Luna")).toEqual(["low:off", "medium:off", "high:on"]);

        await settle();
        expect(stats.peak).toBe(1);
        expect(effortCalls.at(-1)).toEqual({ luna: ["high"] });
        expect(store.get().harnesses[0]?.allowedEfforts).toEqual({ luna: ["high"] });
        expect(levelsOf("Luna")).toEqual(["low:off", "medium:off", "high:on"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("保存失败：回到服务端确认的档位并提示", async () => {
      show(leveled({ allowedEfforts: { luna: ["low", "high"] } }));
      expand("Luna");
      act(() => levelInput("Luna", "medium").click());
      expect(levelsOf("Luna")).toEqual(["low:on", "medium:on", "high:on"]);
      await act(async () => {
        pending.shift()!.reject(new ApiError("internal", "boom", 500));
      });
      expect(levelsOf("Luna")).toEqual(["low:on", "medium:off", "high:on"]);
      expect(store.get().toasts.at(-1)?.text).toContain("没能保存模型设置");
    });

    it("修改可见的档位时，保留目录暂时没有返回的档位", async () => {
      show(leveled({ allowedEfforts: { luna: ["high", "retired"] } }));
      expand("Luna");
      expect(levelsOf("Luna")).toEqual(["low:off", "medium:off", "high:on"]);
      act(() => levelInput("Luna", "low").click());
      await settle();
      expect(effortCalls).toEqual([{ luna: ["low", "high", "retired"] }]);
    });

    it("记录与目录对不上时：展开钮标出来、说明原因，选一档即可修复，原有记录不丢", async () => {
      show(leveled({ allowedModels: ["luna"], allowedEfforts: { luna: ["max"] } }));
      expect(moreOf("Luna")?.getAttribute("data-state")).toBe("empty");
      expect(moreOf("Luna")?.textContent).toContain("0/3");
      expect(document.body.querySelector(".field-note")?.textContent).toContain("没有可用的推理强度");
      expand("Luna");
      expect(levelsOf("Luna")).toEqual(["low:off", "medium:off", "high:off"]);
      act(() => levelInput("Luna", "medium").click());
      await settle();
      expect(effortCalls.at(-1)).toEqual({ luna: ["medium", "max"] });
    });
  });
});
