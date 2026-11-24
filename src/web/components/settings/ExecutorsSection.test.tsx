import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@shared/types";
import { ApiError } from "../../lib/api";
import { store } from "../../lib/app";
import { MODELS, harness, installRig } from "./executors.rig";

describe("设置 · 执行端：主 Agent 可选的模型", () => {
  const { pending, calls, stats, show, rows, rowOf, moreOf, marks, tick, bulk, count, settle, type } = installRig();

  it("列出目录里的全部模型，勾选状态来自已保存的名单；没有限制时全部是勾上的", () => {
    show(harness({ allowedModels: ["m-b"] }));
    expect(marks()).toEqual(["Alpha:off", "Beta:on", "Gamma:off"]);
    expect(count()).toBe("1 / 3");

    show(harness());
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:on"]);
    expect(count()).toBe("3 / 3");
  });

  it("逐项勾满仍保存精确名单，只有点全部开放才解除限制", async () => {
    show(harness({ allowedModels: ["m-b"] }));
    tick("Alpha");
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:off"]);
    expect(calls).toEqual([["m-a", "m-b"]]);
    await settle();
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:off"]);
    expect(store.get().harnesses[0]?.allowedModels).toEqual(["m-a", "m-b"]);

    tick("Gamma");
    await settle();
    expect(calls).toEqual([["m-a", "m-b"], ["m-a", "m-b", "m-c"]]);
    expect(store.get().harnesses[0]?.allowedModels).toEqual(["m-a", "m-b", "m-c"]);
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:on"]);
    expect(count()).toBe("3 / 3");

    act(() => bulk("全部开放").click());
    await settle();
    expect(calls.at(-1)).toBeNull();
    expect(store.get().harnesses[0]?.allowedModels).toBeUndefined();
    expect(bulk("全部开放").disabled).toBe(true);
  });

  it("取消勾选同样保存；全部取消是合法的，并说明主 Agent 因此无法委派", async () => {
    show(harness());
    tick("Beta");
    await settle();
    expect(calls).toEqual([["m-a", "m-c"]]);

    act(() => bulk("全不选").click());
    await settle();
    expect(calls.at(-1)).toEqual([]);
    expect(marks()).toEqual(["Alpha:off", "Beta:off", "Gamma:off"]);
    expect(count()).toBe("0 / 3");
    expect(document.body.querySelector(".field-note")?.textContent).toContain("没有勾选任何模型：主 Agent 无法向它委派。");
  });

  it("连续点击不会并发请求：同一时刻只有一个在途，后面的合并成最新的一份，界面不回跳", async () => {
    show(harness({ allowedModels: ["m-b"] }));
    tick("Alpha");
    tick("Gamma");
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:on"]);
    expect(calls).toEqual([["m-a", "m-b"]]);

    await act(async () => {
      pending.shift()!.resolve();
    });
    // 第一份已确认，但还有更新的在途：界面停在用户最后的选择上，不能退回第一份。
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:on"]);
    await settle();
    expect(calls).toEqual([["m-a", "m-b"], ["m-a", "m-b", "m-c"]]);
    expect(stats.peak).toBe(1);
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:on"]);
  });

  it("关闭再打开后继续修改，最新选择与之前的在途选择合并并按顺序保存", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      show(harness({ models: [...MODELS, { id: "m-d", label: "Delta" }], allowedModels: ["m-b"] }));
      tick("Alpha");
      tick("Gamma");
      act(() => store.set({ settings: { open: false, section: "executors" } }));
      act(() => vi.advanceTimersByTime(200));
      expect(rows()).toHaveLength(0);

      act(() => store.set({ settings: { open: true, section: "executors" } }));
      expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:on", "Delta:off"]);
      tick("Delta");
      expect(calls).toEqual([["m-a", "m-b"]]);
      await settle();
      expect(stats.peak).toBe(1);
      expect(calls.at(-1)).toEqual(["m-a", "m-b", "m-c", "m-d"]);
      expect(store.get().harnesses[0]?.allowedModels).toEqual(["m-a", "m-b", "m-c", "m-d"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("修改可见的勾选时保留目录暂时没有返回的模型 ID", async () => {
    show(harness({ allowedModels: ["m-b", "not-in-catalog"] }));
    tick("Alpha");
    await settle();
    expect(calls).toEqual([["m-a", "m-b", "not-in-catalog"]]);
  });

  it("保存失败：回到服务端确认的状态并提示，不让界面停在没有生效的名单上", async () => {
    show(harness({ allowedModels: ["m-b"] }));
    tick("Alpha");
    expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:off"]);
    await act(async () => {
      pending.shift()!.reject(new ApiError("internal", "boom", 500));
    });
    expect(marks()).toEqual(["Alpha:off", "Beta:on", "Gamma:off"]);
    expect(store.get().toasts.at(-1)?.text).toContain("没能保存模型设置");
    expect(store.get().harnesses[0]?.allowedModels).toEqual(["m-b"]);
  });

  it("默认模型没勾选时，告诉用户不指定模型会落到哪一个", () => {
    show(harness({ allowedModels: ["m-b", "m-c"] }));
    expect(document.body.querySelector(".mcfg-note")?.textContent).toBe("默认模型没有勾选；主 Agent 不指定模型时会用「Beta」。");

    show(harness({ allowedModels: ["m-a", "m-c"] }));
    expect(document.body.querySelector(".mcfg-note")).toBeNull();
    show(harness());
    expect(document.body.querySelector(".mcfg-note")).toBeNull();
  });

  it("提示句里的模型名带着不换行空格：折行时名字整体挪走，不会断在名字中间", () => {
    show(
      harness({
        models: [{ id: "m-a", label: "Alpha", isDefault: true }, { id: "m-b", label: "Claude 4.5 Sonnet" }],
        allowedModels: ["m-b"],
      }),
    );
    expect(document.body.querySelector(".mcfg-note")?.textContent).toBe("默认模型没有勾选；主 Agent 不指定模型时会用「Claude\u00a04.5\u00a0Sonnet」。");
  });

  it("只有执行端自己的默认模型带“默认”标；档位不再挤在行里，而是收在展开钮后面", () => {
    show(harness({ allowedModels: ["m-b", "m-c"] }));
    expect(rowOf("Alpha").querySelector(".chip")?.textContent).toBe("默认");
    expect(rowOf("Beta").querySelector(".chip")).toBeNull();
    expect(rowOf("Gamma").textContent).not.toContain("low");
    expect(moreOf("Gamma")?.textContent).toContain("2/2");
  });
  describe("模型很多的时候", () => {
    const many = Array.from({ length: 12 }, (_, index): ModelInfo => ({ id: `model-${index}`, label: `Model ${index}` }));
    const input = (): HTMLInputElement | null => document.body.querySelector<HTMLInputElement>(".mcfg-filter input");

    it("出现筛选框；模型不多时不出现", () => {
      show(harness({ models: many, allowedModels: [] }));
      expect(input()).not.toBeNull();
      show(harness({ models: many.slice(0, 8), allowedModels: [] }));
      expect(input()).toBeNull();
    });

    it("全选与全不选只作用于筛选出来的那几个", async () => {
      show(harness({ models: many, defaultModel: undefined, allowedModels: ["model-0"] }));
      type(input()!, "model 1");
      expect(rows().map((row) => row.querySelector(".mrow-name")?.textContent)).toEqual(["Model 1", "Model 10", "Model 11"]);

      act(() => bulk("全选").click());
      expect(calls).toEqual([["model-0", "model-1", "model-10", "model-11"]]);
      await settle();
      expect(bulk("全选").disabled).toBe(true);

      act(() => bulk("全不选").click());
      await settle();
      expect(calls.at(-1)).toEqual(["model-0"]);
    });

    it("没有匹配时给出说明；Esc 先清掉筛选，再按一次才关设置窗口", () => {
      show(harness({ models: many, allowedModels: [] }));
      type(input()!, "zzz");
      expect(document.body.querySelector(".mcfg-empty")?.textContent).toBe("没有匹配的模型");

      const press = (): void => {
        act(() => {
          document.activeElement === input() || input()!.focus();
          input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        });
      };
      press();
      expect(input()!.value).toBe("");
      expect(rows()).toHaveLength(12);
      expect(store.get().settings.open).toBe(true);

      press();
      expect(store.get().settings.open).toBe(false);
    });
  });

  it("认得出家族的模型带家族标，认不出的用中性图标占位；全都认不出时不留空位", () => {
    show(
      harness({
        models: [
          { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
          { id: "house-model", label: "House model" },
        ],
      }),
    );
    expect(rowOf("Claude Sonnet 4.5").querySelector(".model-mark")?.getAttribute("data-family")).toBe("claude");
    expect(rowOf("House model").querySelector(".model-mark")).toBeNull();
    expect(rowOf("House model").querySelector(".model-glyph")).not.toBeNull();

    show(harness({ models: [{ id: "fixture-a", label: "Fixture A" }, { id: "fixture-b", label: "Fixture B" }] }));
    expect(document.body.querySelectorAll(".mrow .model-mark, .mrow .model-glyph")).toHaveLength(0);
  });

  it("鼠标悬停才显示模型 id；名字与 id 相同时不重复", () => {
    show(harness({ models: [{ id: "gpt-9", label: "GPT 9" }, { id: "same", label: "same" }] }));
    expect(rowOf("GPT 9").querySelector(".mrow-name")?.getAttribute("data-tip")).toBe("GPT 9\ngpt-9");
    expect(rowOf("same").querySelector(".mrow-name")?.hasAttribute("data-tip")).toBe(false);
  });

  it("不再展示“能力与验证状态”，也没有“向它委派”按钮；访问权限仍在", () => {
    show(harness());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("能力与验证状态");
    expect(text).not.toContain("向它委派");
    expect(document.body.querySelector(".hcard-foot")).toBeNull();
    expect([...document.body.querySelectorAll(".hcard .section-title")].map((node) => node.textContent)).toEqual(["允许主 Agent 选用的模型", "访问权限与约束"]);
    expect(text).toContain("只有勾选的模型，主 Agent 才能选用。");
  });

  it("目录读不到时不画空的勾选框，只说明没有读到", () => {
    show(harness({ models: [], defaultModel: undefined }));
    expect(rows()).toHaveLength(0);
    expect(document.body.querySelector(".hcard-body")?.textContent).toContain("没有读取到模型列表。");
  });

  it("没就绪的执行端不显示模型区块，只给出设置提示", () => {
    show(harness({ status: "needs_setup", models: [], setup: { code: "codex_login_required", message: "Sign in to Codex." } }));
    expect(document.body.querySelector(".hcard-body")).toBeNull();
    expect(document.body.querySelector(".hcard-setup")).not.toBeNull();
  });
});
