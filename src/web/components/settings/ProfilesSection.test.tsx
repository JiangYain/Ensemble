import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PROFILE_LIMIT, type ProfileEntry, type ProfilesView } from "@shared/profiles";
import type { ProfilesResponse } from "@shared/protocol";
import type { HarnessInfo } from "@shared/types";
import { api } from "../../lib/api";
import { applyProfiles, store, type AppState } from "../../lib/app";
import { bindT } from "../../lib/i18n";
import { ProfilesSection, profilesSummary } from "./ProfilesSection";
import { info, scout, tick, upsert, verify, type Field, type Held } from "./ProfilesSection.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 设置 · 角色。不挂完整的设置窗口，只渲染这个分区本身：假服务端把每个请求挂起，由用例决定什么时候回、回什么（含“推送比回执先到”）。
 * 字段怎么联动、选项从哪来、名称怎么校验这些纯逻辑在 lib/profiles.test.ts；这里测的是它们在界面上的样子与操作：
 * 即时生效、乐观显示与回退、草稿何时落成角色、行的身份在新增与改名时保持不变、键盘、删除确认、不可用与无效条目的呈现。
 * 这一份是之一：外观与导航项下面的小字；新增在 ProfilesSection.create.test.tsx，修改、改名与删除在 ProfilesSection.edit.test.tsx，共用的样本与假服务端的请求记录在 ProfilesSection.fixtures.ts。
 */

describe("设置 · 角色（ProfilesSection）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let put: MockInstance<typeof api.putProfile>;
  let rename: MockInstance<typeof api.renameProfile>;
  let remove: MockInstance<typeof api.removeProfile>;
  let held: Held[];
  const previous = store.get();

  // ───────────────────────── 假服务端 ─────────────────────────

  const hold = (run: Held["run"]): Promise<ProfilesResponse> =>
    new Promise<ProfilesResponse>((resolve, reject) => {
      held.push({ settled: false, run, resolve, reject });
    });

  const refuse = (index: number, error: Error): Promise<void> =>
    act(async () => {
      held[index]!.settled = true;
      held[index]!.reject(error);
      await tick();
    });

  /** 写入走的是串行队列，请求在下一个微任务才发出：做完操作要让它跑完，才看得到请求。 */
  const flush = (): Promise<void> =>
    act(async () => {
      await tick();
    });

  beforeEach(() => {
    held = [];
    store.set({ lang: "zh", toasts: [], confirm: undefined, profiles: { entries: [] }, harnesses: [] });
    put = vi.spyOn(api, "putProfile").mockImplementation((name, body) => hold((entries) => upsert(entries, name, body)));
    rename = vi.spyOn(api, "renameProfile").mockImplementation((name, to) =>
      hold((entries) =>
        entries.map((entry) => {
          if (entry.name !== name) return entry;
          // 改名之后服务端重新判断：名称合规了，“名称不合规”的标记就没有了。
          const { invalid: _invalid, ...rest } = entry;
          return { ...rest, name: to };
        }),
      ),
    );
    remove = vi.spyOn(api, "removeProfile").mockImplementation((name) => hold((entries) => entries.filter((entry) => entry.name !== name)));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    // 没有回执的请求统统拒绝掉：写入队列是模块级的，留着一个悬着的请求会把后面用例的写入全堵住。
    for (let guard = 0; guard < 40; guard += 1) {
      const index = held.findIndex((request) => !request.settled);
      if (index < 0) break;
      await refuse(index, new Error("test over"));
    }
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    store.set({ lang: previous.lang, toasts: previous.toasts, confirm: previous.confirm, profiles: previous.profiles, harnesses: previous.harnesses });
    vi.restoreAllMocks();
  });

  // ───────────────────────── 夹具与操作 ─────────────────────────

  const show = (entries: ProfileEntry[], harnesses: HarnessInfo[] = [info("codex"), info("pi")]): void => {
    act(() => {
      store.set({ profiles: { entries }, harnesses });
      root.render(<ProfilesSection />);
    });
  };

  const rows = (): HTMLLIElement[] => [...host.querySelectorAll<HTMLLIElement>(".prof-row")];
  const nameInput = (row: Element): HTMLInputElement => row.querySelector<HTMLInputElement>(".prof-name")!;
  const rowOf = (name: string): HTMLLIElement => {
    const found = rows().find((row) => nameInput(row).value === name);
    if (!found) throw new Error(`no row ${name}`);
    return found;
  };
  const draftRow = (): HTMLLIElement => {
    const found = rows().find((row) => row.hasAttribute("data-draft"));
    if (!found) throw new Error("no draft row");
    return found;
  };
  const select = (row: Element, field: Field): HTMLSelectElement => row.querySelector<HTMLSelectElement>(`[data-field="${field}"] select`)!;
  const values = (row: Element): Record<Field, string> => ({
    harness: select(row, "harness").value,
    model: select(row, "model").value,
    effort: select(row, "effort").value,
    access: select(row, "access").value,
  });
  const options = (element: HTMLSelectElement): HTMLOptionElement[] => [...element.querySelectorAll<HTMLOptionElement>("option")];
  const labels = (element: HTMLSelectElement): string[] => options(element).map((option) => option.textContent ?? "");
  const message = (row: Element): string | undefined => row.querySelector(".prof-msg")?.textContent ?? undefined;
  const pip = (row: Element): string | null | undefined => row.querySelector(".prof-pip")?.getAttribute("data-status");
  const addButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".prof-foot button")!;

  const click = (element: Element | null | undefined): void => void act(() => (element as HTMLElement).click());

  const type = (input: HTMLInputElement, text: string): void =>
    void act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  // ───────────────────────── 外观 ─────────────────────────

  describe("外观", () => {
    it("没有角色：一句淡色的话和一个“添加角色”，没有表头也没有行（不预置任何角色）", () => {
      show([]);
      expect(host.querySelector(".prof-empty")?.textContent).toBe("还没有角色。添加一个，主 Agent 就能按名字选用它。");
      expect(rows()).toHaveLength(0);
      expect(host.querySelector(".prof-cols")).toBeNull();
      expect(addButton().textContent).toBe("添加角色");
      expect(addButton().disabled).toBe(false);
      expect(host.querySelector(".settings-intro")?.textContent).toContain("「执行端」");
    });

    it("设置文件读不了：说明角色暂时不可用，没有“添加”（这不是“没有角色”）", () => {
      act(() => {
        store.set({ profiles: { entries: [], unavailable: "unreadable_file" } });
        root.render(<ProfilesSection />);
      });
      expect(host.querySelector('[role="status"]')?.textContent).toBe("无法读取 settings.json，角色暂时不可用。恢复文件后重启 Ensemble。");
      expect(host.querySelector(".prof-foot")).toBeNull();
      expect(host.querySelector(".prof-empty")).toBeNull();
      expect(rows()).toHaveLength(0);
    });

    it("列表取自 store，按服务端给的顺序（创建顺序）；四个下拉框的当前值与选项都来自真实的执行端与模型", () => {
      show([verify, scout]);
      expect(rows().map((row) => nameInput(row).value)).toEqual(["verify", "scout"]);
      expect(host.querySelector(".prof-cols")?.textContent).toBe("名称执行端模型推理强度访问权限");

      const first = rowOf("verify");
      expect(values(first)).toEqual({ harness: "codex", model: "m-big", effort: "high", access: "read_only" });
      expect(labels(select(first, "harness"))).toEqual(["Codex", "Pi"]);
      expect(labels(select(first, "model"))).toEqual(["默认 · Fast", "Fast", "Big", "Plain"]);
      expect(labels(select(first, "effort"))).toEqual(["默认", "低", "中", "高"]);
      expect(labels(select(first, "access"))).toEqual(["默认", "只读", "完全访问"]);

      // 没固定的项显示“默认”。
      expect(values(rowOf("scout"))).toEqual({ harness: "pi", model: "", effort: "", access: "" });
    });

    it("每个下拉框都有完整的无障碍名字（“模型（verify）”），不靠位置猜；草稿叫“新角色”，写了名称就用名称", () => {
      show([verify]);
      const first = rowOf("verify");
      expect(nameInput(first).getAttribute("aria-label")).toBe("角色名称");
      expect(select(first, "harness").getAttribute("aria-label")).toBe("执行端（verify）");
      expect(select(first, "model").getAttribute("aria-label")).toBe("模型（verify）");
      expect(select(first, "effort").getAttribute("aria-label")).toBe("推理强度（verify）");
      expect(select(first, "access").getAttribute("aria-label")).toBe("访问权限（verify）");

      click(addButton());
      expect(select(draftRow(), "harness").getAttribute("aria-label")).toBe("执行端（新角色）");
      type(nameInput(draftRow()), "scout");
      expect(select(draftRow(), "harness").getAttribute("aria-label")).toBe("执行端（scout）");
    });

    it("能用的行：实心方块、没有说明；不能用的行：空心方块，原因写在这一行下面，角色本身不会被自动改动", async () => {
      show([verify, { name: "stale", harness: "pi", model: "m-big" }], [info("codex"), info("pi", { allowedModels: ["m-fast"] })]);
      expect(pip(rowOf("verify"))).toBe("ready");
      expect(message(rowOf("verify"))).toBeUndefined();
      expect(rowOf("verify").querySelector(".sr-only")?.textContent).toBe("可用");

      expect(pip(rowOf("stale"))).toBe("unavailable");
      expect(message(rowOf("stale"))).toBe("模型「m-big」在 Pi 上没有开放。");
      expect(rowOf("stale").querySelector(".sr-only")?.textContent).toBe("不可用");
      // 存着的模型已经不在开放名单里，下拉框仍显示它（才与存的值对得上）。
      expect(select(rowOf("stale"), "model").value).toBe("m-big");

      await flush();
      expect(put).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it("执行端还没就绪：下拉框里注明状态，这一行说明原因", () => {
      show([scout], [info("codex"), info("pi", { status: "needs_setup" })]);
      expect(labels(select(rowOf("scout"), "harness"))).toEqual(["Codex", "Pi · 需要设置"]);
      expect(message(rowOf("scout"))).toBe("Pi：需要设置。这个角色暂时不能用。");
      expect(pip(rowOf("scout"))).toBe("unavailable");
    });

    it("执行端落实不了存着的访问权限：这一项仍显示（注明不支持、不禁用），原因写在下面，不悄悄改成别的级别", () => {
      show([{ name: "locked", harness: "pi", access: "read_only" }], [info("codex"), info("pi", { access: { read_only: null, full: { level: "none", mechanism: "test" } } })]);
      const row = rowOf("locked");
      expect(labels(select(row, "access"))).toEqual(["默认", "只读 · 不支持", "完全访问"]);
      expect(select(row, "access").value).toBe("read_only");
      expect(options(select(row, "access"))[1]!.disabled).toBe(false);
      expect(message(row)).toBe("Pi 无法落实访问权限「只读」。改一下访问权限，或换一个执行端。");
    });

    it("这一版不认识的执行端（手改文件）：保留在下拉框里并标“未知”，其余三项不能选", () => {
      show([{ name: "future", harness: "quantum" }]);
      const row = rowOf("future");
      expect(select(row, "harness").value).toBe("quantum");
      expect(labels(select(row, "harness"))).toEqual(["Codex", "Pi", "quantum · 未知"]);
      expect(message(row)).toBe("这一版 Ensemble 不认识执行端「quantum」。换一个执行端，或删除这个角色。");
      expect(["model", "effort", "access"].map((field) => select(row, field as Field).disabled)).toEqual([true, true, true]);
    });

    it("名称不合规的旧角色（手改文件）：说明原因，下拉框先不开放（服务端会因为名称不合规拒绝任何别的改动）", () => {
      show([{ name: "Bad Name", invalid: "name", harness: "pi" }]);
      const row = rows()[0]!;
      expect(nameInput(row).value).toBe("Bad Name");
      expect(message(row)).toBe("settings.json 里这个角色的名称不合规，主 Agent 引用不到它。改个名称即可。");
      expect(pip(row)).toBe("unavailable");
      expect((["harness", "model", "effort", "access"] as const).map((field) => select(row, field).disabled)).toEqual([true, true, true, true]);
    });

    it("内容读不出来的旧角色：执行端那一栏回到“选择执行端”，别的栏先不能选", () => {
      show([{ name: "broken", invalid: "entry" }]);
      const row = rows()[0]!;
      expect(select(row, "harness").value).toBe("");
      expect(labels(select(row, "harness"))[0]).toBe("选择执行端");
      expect(options(select(row, "harness"))[0]!.disabled).toBe(true);
      expect(message(row)).toBe("settings.json 里这个角色的内容读不出来。重新选一个执行端，或删除这个角色。");
      expect((["model", "effort", "access"] as const).map((field) => select(row, field).disabled)).toEqual([true, true, true]);
      expect(select(row, "harness").disabled).toBe(false);
    });

    it("别的页面改了角色（服务端推来整张表）：列表跟着变", () => {
      show([verify]);
      act(() => applyProfiles({ entries: [verify, scout] }));
      expect(rows().map((row) => nameInput(row).value)).toEqual(["verify", "scout"]);
      act(() => applyProfiles({ entries: [scout] }));
      expect(rows().map((row) => nameInput(row).value)).toEqual(["scout"]);
      act(() => applyProfiles({ entries: [] }));
      expect(rows()).toHaveLength(0);
      expect(host.querySelector(".prof-empty")).not.toBeNull();
    });

    it("最多 20 个角色：数到上限“添加角色”不可点并说明；草稿也算一行", () => {
      const names = Array.from({ length: PROFILE_LIMIT - 1 }, (_, index) => ({ name: `r${index + 10}`, harness: "pi" }));
      show(names);
      expect(addButton().disabled).toBe(false);
      expect(host.querySelector(".prof-limit")).toBeNull();
      click(addButton());
      expect(rows()).toHaveLength(PROFILE_LIMIT);
      expect(addButton().disabled).toBe(true);
      expect(host.querySelector(".prof-limit")?.textContent).toBe(`最多 ${PROFILE_LIMIT} 个角色。`);
    });
  });

  describe("导航项下面的小字（profilesSummary）", () => {
    const state = (profiles: ProfilesView, harnesses: HarnessInfo[]): AppState => ({ ...store.get(), profiles, harnesses });
    const zh = bindT("zh");
    const stale: ProfileEntry = { name: "stale", harness: "pi", model: "m-big" };
    const harnesses = [info("codex"), info("pi", { allowedModels: ["m-fast"] })];

    it("有几个角色此刻能用", () => {
      expect(profilesSummary(state({ entries: [verify, scout, stale] }, harnesses), zh)).toBe("2/3 可用");
      expect(profilesSummary(state({ entries: [verify, scout, stale] }, harnesses), bindT("en"))).toBe("2/3 ready");
      // 找不到它的执行端：算不能用。
      expect(profilesSummary(state({ entries: [verify] }, []), zh)).toBe("0/1 可用");
    });

    it("没有角色、或读不出来时不写", () => {
      expect(profilesSummary(state({ entries: [] }, harnesses), zh)).toBeUndefined();
      expect(profilesSummary(state({ entries: [verify], unavailable: "unreadable_file" }, harnesses), zh)).toBeUndefined();
    });
  });
});
