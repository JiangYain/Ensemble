import { act } from "react";
import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@shared/types";
import { ApiError } from "../../lib/api";
import { setLang, store } from "../../lib/app";
import { MODELS, harness, installRig } from "./executors.rig";

/** 执行端自己的默认是 Alpha（m-a）。用户指定的默认模型是另一件事：单选（方框），不是勾选。 */
describe("设置 · 执行端：用户指定的默认模型", () => {
  const { calls, defaultCalls, effortCalls, pending, show, rows, rowOf, itemOf, expand, marks, pickOf, picks, chips, tick, bulk, settle, type } = installRig();
  const note = (): HTMLElement | null => document.body.querySelector<HTMLElement>(".mcfg-note");
  const amber = (): HTMLElement | null => document.body.querySelector<HTMLElement>(".mcfg-section .field-note--amber");
  const restoreButton = (): HTMLButtonElement | null =>
    [...document.body.querySelectorAll<HTMLButtonElement>(".mcfg-section .link-btn")].find((button) => button.textContent === "恢复执行端的默认") ?? null;
  const choose = (label: string): void => {
    act(() => pickOf(label)!.click());
  };

  describe("单选本身", () => {
    it("每个已开放的模型一个单选，同属一个单选组；没开放的模型没有，只留一个同宽的空位", () => {
      show(harness({ allowedModels: ["m-a", "m-c"] }));
      const radios = [...document.body.querySelectorAll<HTMLInputElement>(".mpick-input")];
      expect(radios).toHaveLength(2);
      expect(radios.every((radio) => radio.type === "radio")).toBe(true);
      expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
      expect(radios[0]!.name).not.toBe("");
      expect(pickOf("Beta")).toBeNull();
      expect(itemOf("Beta").querySelector(".mpick")?.hasAttribute("data-void")).toBe(true);
      expect(itemOf("Beta").querySelector(".mpick")?.getAttribute("aria-hidden")).toBe("true");
      // 每一行都有这一格：没开放的行也一样，列不会错位。
      expect([...document.body.querySelectorAll(".mline")].every((line) => line.querySelectorAll(".mpick").length === 1)).toBe(true);
    });

    it("每个单选都带完整的无障碍名字（“设为默认模型：名字”），不靠位置猜", () => {
      show(harness());
      expect(pickOf("Beta")!.getAttribute("aria-label")).toBe("设为默认模型：Beta");
      expect(pickOf("Gamma")!.getAttribute("aria-label")).toBe("设为默认模型：Gamma");
    });

    it("单选不在勾选的标签里：点单选不会改勾选（名单仍是不设限），点勾选也不会顺带改默认", async () => {
      show(harness());
      expect(rowOf("Beta").contains(pickOf("Beta"))).toBe(false);
      choose("Beta");
      expect(calls).toEqual([null]);
      expect(marks()).toEqual(["Alpha:on", "Beta:on", "Gamma:on"]);
      await settle();
      tick("Gamma");
      await settle();
      expect(calls).toEqual([null, ["m-a", "m-b"]]);
      expect(defaultCalls).toEqual(["m-b", undefined]); // 第二次保存里默认没变，不重发
      expect(picks()).toEqual(["Beta"]);
    });
  });

  describe("指定与恢复", () => {
    it("没指定时没有任何单选被选中，“默认”标在执行端自己的默认上，也没有说明句", () => {
      show(harness());
      expect(picks()).toEqual([]);
      expect(chips()).toEqual(["Alpha:默认"]);
      expect(note()).toBeNull();
      expect(restoreButton()).toBeNull();
    });

    it("点一个模型的单选：立即指定，保存只带默认模型（名单不变）；“默认”标移过去，执行端自己的默认改标“执行端默认”", async () => {
      show(harness());
      choose("Beta");
      expect(picks()).toEqual(["Beta"]);
      expect(chips()).toEqual(["Alpha:执行端默认", "Beta:默认"]);
      expect(calls).toEqual([null]);
      expect(defaultCalls).toEqual(["m-b"]);
      expect(note()?.textContent).toBe("默认模型由你指定：主 Agent 不指定模型时用「Beta」。恢复执行端的默认");

      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBe("m-b");
      expect(picks()).toEqual(["Beta"]);
      expect(store.get().pendingModelSettings).toEqual({});
    });

    it("指定的就是执行端自己的默认：只有一个“默认”标，没有“执行端默认”", () => {
      show(harness());
      choose("Alpha");
      expect(picks()).toEqual(["Alpha"]);
      expect(chips()).toEqual(["Alpha:默认"]);
      expect(note()?.textContent).toContain("用「Alpha」");
    });

    it("换一个：单选组里只有一个被选中", async () => {
      show(harness());
      choose("Beta");
      await settle();
      choose("Gamma");
      await settle();
      expect(picks()).toEqual(["Gamma"]);
      expect(defaultCalls).toEqual(["m-b", "m-c"]);
      expect(chips()).toEqual(["Alpha:执行端默认", "Gamma:默认"]);
    });

    it("“恢复执行端的默认”：清掉指定，回到执行端自己的默认，说明句消失", async () => {
      show(harness({ userDefaultModel: "m-b" }));
      expect(picks()).toEqual(["Beta"]);
      act(() => restoreButton()!.click());
      expect(picks()).toEqual([]);
      expect(chips()).toEqual(["Alpha:默认"]);
      expect(defaultCalls).toEqual([null]);
      expect(note()).toBeNull();
      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBeUndefined();
    });

    it("指定后连着改别的：在途的合并成最新一份，默认不丢也不回跳", async () => {
      show(harness({ allowedModels: ["m-a", "m-b"] }));
      choose("Beta");
      tick("Gamma");
      expect(picks()).toEqual(["Beta"]);
      await act(async () => {
        pending.shift()!.resolve();
      });
      expect(picks()).toEqual(["Beta"]);
      await settle();
      expect(calls).toEqual([["m-a", "m-b"], ["m-a", "m-b", "m-c"]]);
      // 第二份里默认没有变化：不再发送，服务端保留已存的。
      expect(defaultCalls).toEqual(["m-b", undefined]);
      expect(picks()).toEqual(["Beta"]);
      expect(store.get().harnesses[0]?.userDefaultModel).toBe("m-b");
    });

    it("保存失败：回到服务端确认的状态并提示", async () => {
      show(harness());
      choose("Beta");
      expect(picks()).toEqual(["Beta"]);
      await act(async () => {
        pending.shift()!.reject(new ApiError("model_not_allowed", "no", 422));
      });
      expect(picks()).toEqual([]);
      expect(chips()).toEqual(["Alpha:默认"]);
      expect(store.get().toasts.at(-1)?.text).toContain("没能保存模型设置");
    });
  });

  describe("和勾选的联动", () => {
    it("取消勾选指定的默认模型：不拦着，立即清掉指定，并就地说一句现在用哪个", async () => {
      show(harness({ allowedModels: ["m-a", "m-b"], userDefaultModel: "m-b" }));
      tick("Beta");
      expect(calls).toEqual([["m-a"]]);
      expect(defaultCalls).toEqual([null]);
      expect(picks()).toEqual([]);
      expect(chips()).toEqual(["Alpha:默认"]);
      expect(note()?.textContent).toBe("「Beta」已取消勾选，不再是你指定的默认模型；主 Agent 不指定模型时现在用「Alpha」。");
      expect(note()?.getAttribute("role")).toBe("status");
      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBeUndefined();
      expect(store.get().harnesses[0]?.allowedModels).toEqual(["m-a"]);
    });

    it("执行端自己的默认也没勾选时，说的是实际落点（第一个被开放的）", () => {
      show(harness({ allowedModels: ["m-b", "m-c"], userDefaultModel: "m-b" }));
      tick("Beta");
      expect(note()?.textContent).toBe("「Beta」已取消勾选，不再是你指定的默认模型；主 Agent 不指定模型时现在用「Gamma」。");
    });

    it("这句说明只是一次就地的提示：再做别的操作就收起，重新勾选也不会把默认找回来", async () => {
      show(harness({ allowedModels: ["m-a", "m-b"], userDefaultModel: "m-b" }));
      tick("Beta");
      await settle();
      expect(note()?.textContent).toContain("已取消勾选");
      tick("Beta");
      expect(note()).toBeNull();
      await settle();
      expect(picks()).toEqual([]);
      expect(store.get().harnesses[0]?.userDefaultModel).toBeUndefined();
    });

    it("取消勾选的是别的模型：默认不动，保存时也不重发默认", async () => {
      show(harness({ allowedModels: ["m-a", "m-b", "m-c"], userDefaultModel: "m-b" }));
      tick("Gamma");
      expect(picks()).toEqual(["Beta"]);
      expect(defaultCalls).toEqual([undefined]);
      expect(note()?.textContent).toBe("默认模型由你指定：主 Agent 不指定模型时用「Beta」。恢复执行端的默认");
      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBe("m-b");
    });

    it("全不选（一个都不开放）：同样清掉，不允许委派的说明在前，也说明默认被清了", async () => {
      show(harness({ userDefaultModel: "m-b" }));
      act(() => bulk("全不选").click());
      expect(calls).toEqual([[]]);
      expect(defaultCalls).toEqual([null]);
      expect(picks()).toEqual([]);
      expect(document.body.querySelectorAll(".mpick-input")).toHaveLength(0);
      expect(amber()?.textContent).toContain("没有勾选任何模型：主 Agent 无法向它委派。");
      expect(note()?.textContent).toBe("「Beta」已取消勾选，不再是你指定的默认模型。");
      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBeUndefined();
    });

    it("全部开放（回到不设限）：指定的默认保留，且不重发", async () => {
      show(harness({ allowedModels: ["m-a", "m-b"], userDefaultModel: "m-b" }));
      act(() => bulk("全部开放").click());
      expect(calls).toEqual([null]);
      expect(defaultCalls).toEqual([undefined]);
      expect(picks()).toEqual(["Beta"]);
      await settle();
      expect(store.get().harnesses[0]).toMatchObject({ userDefaultModel: "m-b" });
      expect(store.get().harnesses[0]?.allowedModels).toBeUndefined();
    });

    it("筛选后的全不选只取消筛出来的：其中包含指定的默认才会清掉", () => {
      const many = Array.from({ length: 12 }, (_, index): ModelInfo => ({ id: `model-${index}`, label: `Model ${index}` }));
      show(harness({ models: many, defaultModel: undefined, userDefaultModel: "model-5" }));
      type(document.body.querySelector<HTMLInputElement>(".mcfg-filter input")!, "model 1");
      act(() => bulk("全不选").click());
      expect(defaultCalls).toEqual([undefined]);
      expect(note()?.textContent).toContain("默认模型由你指定");
    });
  });

  describe("指定的默认失效了", () => {
    it("执行端不再提供它：不报错，说明实际用哪个，给出恢复的入口；没有单选被选中", async () => {
      show(harness({ userDefaultModel: "retired-model" }));
      expect(picks()).toEqual([]);
      expect(chips()).toEqual(["Alpha:默认"]);
      expect(amber()?.getAttribute("role")).toBe("status");
      // 名字里的连字符后跟一个零宽的字间连接符（\u2060）：真实 Chrome 里这句话折行时不会断成 “retired-” / “model”。
      expect(amber()?.textContent).toBe("你指定的默认模型「retired-\u2060model」已不可用：执行端不再提供它。主 Agent 不指定模型时现在用「Alpha」。恢复执行端的默认");

      act(() => restoreButton()!.click());
      expect(defaultCalls).toEqual([null]);
      expect(amber()).toBeNull();
      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBeUndefined();
    });

    it("没被开放（手改文件之类造成的）：说明是因为没勾选，实际用现有规则的落点", () => {
      show(harness({ allowedModels: ["m-b", "m-c"], userDefaultModel: "m-a" }));
      expect(picks()).toEqual([]);
      expect(amber()?.textContent).toContain("你指定的默认模型「Alpha」没有被开放，所以没有生效。主 Agent 不指定模型时现在用「Beta」。");
    });

    it("失效的默认不会被一次无关的保存当作新的指定再送一遍（否则整次保存会被服务端拒绝）", async () => {
      show(harness({ userDefaultModel: "retired-model" }));
      expand("Gamma");
      act(() => document.body.querySelector<HTMLInputElement>(".echip input")!.click());
      expect(effortCalls).toHaveLength(1);
      expect(defaultCalls).toEqual([undefined]);
      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBe("retired-model");
    });

    it("在有限制的名单里改勾选时，失效的默认同样被清掉（与服务端同一条规则）", async () => {
      show(harness({ allowedModels: ["m-a", "m-b"], userDefaultModel: "retired-model" }));
      tick("Gamma");
      expect(defaultCalls).toEqual([null]);
      await settle();
      expect(store.get().harnesses[0]?.userDefaultModel).toBeUndefined();
    });
  });

  describe("模型很多的时候", () => {
    const many = Array.from({ length: 12 }, (_, index): ModelInfo => ({ id: `model-${index}`, label: `Model ${index}` }));
    const input = (): HTMLInputElement => document.body.querySelector<HTMLInputElement>(".mcfg-filter input")!;

    it("筛选之后只有筛出来的行有单选，照样能指定；指定的默认被筛掉时仍然算数", async () => {
      show(harness({ models: many, defaultModel: undefined, userDefaultModel: "model-5" }));
      type(input(), "model 1");
      expect(document.body.querySelectorAll(".mpick-input")).toHaveLength(3);
      expect(picks()).toEqual([]); // model-5 被筛掉了，但它仍是默认
      expect(note()?.textContent).toContain("用「Model\u00a05」");

      choose("Model 10");
      expect(picks()).toEqual(["Model 10"]);
      expect(defaultCalls).toEqual(["model-10"]);
      await settle();
      type(input(), "");
      expect(picks()).toEqual(["Model 10"]);
    });

    it("64 个模型：每个已开放的行恰好一个单选、一个空位都不多", () => {
      const sixtyFour = Array.from({ length: 64 }, (_, index): ModelInfo => ({ id: `gpt-${index}`, label: `GPT ${index}` }));
      show(harness({ models: sixtyFour, defaultModel: "gpt-0", allowedModels: sixtyFour.slice(0, 40).map((model) => model.id) }));
      expect(rows()).toHaveLength(64);
      expect(document.body.querySelectorAll(".mpick-input")).toHaveLength(40);
      expect(document.body.querySelectorAll(".mpick[data-void]")).toHaveLength(24);
      expect(document.body.querySelectorAll(".mline")).toHaveLength(64);
    });
  });

  describe("中英文", () => {
    it("分区顶上的说明句里说的形状与实现一致：点最右边的“方框”（单选不再是圆环），中英文成对", () => {
      show(harness());
      const intro = (): string => document.body.querySelector(".settings-intro")?.textContent ?? "";
      expect(intro()).toContain("点已勾选模型最右边的方框，可指定默认模型。");
      expect(intro()).not.toContain("圆环");
      act(() => setLang("en"));
      expect(intro()).toContain("Click the box at the right end of a ticked model to make it the default.");
      expect(intro()).not.toContain("ring");
    });

    it("英文：单选的名字、标签、说明句与恢复按钮都有对应文案", () => {
      setLang("en");
      show(harness({ userDefaultModel: "m-b" }));
      expect(pickOf("Alpha")!.getAttribute("aria-label")).toBe("Set as default model: Alpha");
      expect(chips()).toEqual(["Alpha:Harness default", "Beta:Default"]);
      expect(note()?.textContent).toBe("You chose the default model: when the main Agent doesn't name a model, “Beta” is used.Restore the harness default");

      tick("Beta");
      expect(note()?.textContent).toBe("“Beta” was unticked, so it's no longer the default you chose; when the main Agent doesn't name a model, “Alpha” is now used.");
    });

    it("英文：失效的说明", () => {
      setLang("en");
      show(harness({ userDefaultModel: "gone" }));
      expect(amber()?.textContent).toBe("The default model you chose, “gone”, is no longer available: the harness doesn't offer it. When the main Agent doesn't name a model, “Alpha” is now used.Restore the harness default");
    });
  });

  it("设置没有读到 / 条目损坏时不画单选，也不说默认模型", () => {
    show(harness({ modelSettingsIssue: "invalid_entry", userDefaultModel: "m-b" }));
    expect(document.body.querySelectorAll(".mpick-input")).toHaveLength(0);
    expect(note()).toBeNull();
    expect(restoreButton()).toBeNull();
  });

  it("目录读不到时不画列表，也就没有单选", () => {
    show(harness({ models: [], defaultModel: undefined, userDefaultModel: "m-b" }));
    expect(document.body.querySelectorAll(".mpick-input")).toHaveLength(0);
  });

  it("全部开放、没有任何指定时，目录里的每个模型都有单选", () => {
    show(harness());
    expect(document.body.querySelectorAll(".mpick-input")).toHaveLength(MODELS.length);
  });
});
