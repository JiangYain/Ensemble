import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ProfileEntry, ProfilesView } from "@shared/profiles";
import type { ProfilesResponse } from "@shared/protocol";
import type { HarnessInfo } from "@shared/types";
import { ApiError, api } from "../../lib/api";
import { applyProfiles, store } from "../../lib/app";
import { ProfilesSection } from "./ProfilesSection";
import { info, scout, tick, upsert, verify, type Field, type Held } from "./ProfilesSection.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 设置 · 角色之三：修改已有的角色（即时生效、乐观显示与回退）、改名（行的身份不变、键盘、输入法组字）、删除（先确认）。
 * 与别的两份一样不挂完整的设置窗口，只渲染这个分区本身，假服务端把每个请求挂起，由用例决定什么时候回、回什么（含“推送比回执先到”）。
 * 外观与导航小字在 ProfilesSection.test.tsx，新增在 ProfilesSection.create.test.tsx；共用的样本与假服务端的请求记录在 ProfilesSection.fixtures.ts。
 */

describe("设置 · 角色（ProfilesSection）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let put: MockInstance<typeof api.putProfile>;
  let rename: MockInstance<typeof api.renameProfile>;
  let remove: MockInstance<typeof api.removeProfile>;
  let held: Held[];
  let server: ProfileEntry[];
  const previous = store.get();

  // ───────────────────────── 假服务端 ─────────────────────────

  const hold = (run: Held["run"]): Promise<ProfilesResponse> =>
    new Promise<ProfilesResponse>((resolve, reject) => {
      held.push({ settled: false, run, resolve, reject });
    });

  /**
   * 第 index 个请求回来了，角色表按它的内容变化。`pushFirst`：服务端先把新表推给页面（SSE 的 `profiles`），再把回执发回来——
   * 真实服务端就是这个顺序，行的身份要在这种情况下也不变。
   */
  const respond = (index: number, options: { pushFirst?: boolean } = {}): Promise<void> =>
    act(async () => {
      const request = held[index]!;
      request.settled = true;
      server = request.run(server);
      const view: ProfilesView = { entries: server };
      if (options.pushFirst) applyProfiles(view);
      request.resolve({ profiles: view });
      await tick();
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
    server = [];
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
    server = entries;
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
  const select = (row: Element, field: Field): HTMLSelectElement => row.querySelector<HTMLSelectElement>(`[data-field="${field}"] select`)!;
  const values = (row: Element): Record<Field, string> => ({
    harness: select(row, "harness").value,
    model: select(row, "model").value,
    effort: select(row, "effort").value,
    access: select(row, "access").value,
  });
  const message = (row: Element): string | undefined => row.querySelector(".prof-msg")?.textContent ?? undefined;
  const pip = (row: Element): string | null | undefined => row.querySelector(".prof-pip")?.getAttribute("data-status");
  const addButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".prof-foot button")!;
  const deleteButton = (row: Element): HTMLButtonElement => row.querySelector<HTMLButtonElement>(".prof-del")!;

  const click = (element: Element | null | undefined): void => void act(() => (element as HTMLElement).click());

  /** 在下拉框里选一项：一次选择写一次，写入在下一个微任务才发出，所以带上 flush。 */
  const choose = (element: HTMLSelectElement, value: string): Promise<void> =>
    act(async () => {
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
    });

  const type = (input: HTMLInputElement, text: string): void =>
    void act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const press = (target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    // 有的环境不认 KeyboardEventInit 里的 isComposing：补上，免得“组字期间”的用例空转。
    if (init.isComposing !== undefined && event.isComposing !== init.isComposing) Object.defineProperty(event, "isComposing", { value: init.isComposing });
    act(() => void target.dispatchEvent(event));
    return event;
  };

  /** 名称框失焦（React 的 onBlur 听的是 focusout）。 */
  const leave = (input: HTMLInputElement): Promise<void> =>
    act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await tick();
    });

  // ───────────────────────── 修改：即时生效 ─────────────────────────

  describe("修改已有的角色", () => {
    it("换执行端：模型与推理强度回到默认（它们属于原来的执行端），访问权限带着；界面立刻是新值，回执回来前不会弹回", async () => {
      show([verify]);
      const row = rowOf("verify");
      await choose(select(row, "harness"), "pi");
      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "pi", access: "read_only" });
      // 请求还在路上：界面已经是新值。
      expect(values(row)).toEqual({ harness: "pi", model: "", effort: "", access: "read_only" });

      await respond(0, { pushFirst: true });
      expect(values(row)).toEqual({ harness: "pi", model: "", effort: "", access: "read_only" });
      expect(rows()[0]).toBe(row);
      expect(store.get().profiles.entries).toEqual([{ name: "verify", harness: "pi", access: "read_only" }]);
    });

    it("换模型：新模型也有这一档推理强度就保留，没有就回到默认（并且这一栏不再能选）；选“默认”就去掉模型", async () => {
      show([verify]);
      await choose(select(rowOf("verify"), "model"), "m-fast");
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", model: "m-fast", effort: "high", access: "read_only" });
      await respond(0);

      await choose(select(rowOf("verify"), "model"), "m-plain");
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", model: "m-plain", access: "read_only" });
      await respond(1);
      expect(select(rowOf("verify"), "effort").disabled).toBe(true);

      await choose(select(rowOf("verify"), "model"), "");
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", access: "read_only" });
    });

    it("推理强度与访问权限：选“默认”就是去掉这一项", async () => {
      show([verify]);
      await choose(select(rowOf("verify"), "effort"), "low");
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", model: "m-big", effort: "low", access: "read_only" });
      await respond(0);

      await choose(select(rowOf("verify"), "effort"), "");
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", model: "m-big", access: "read_only" });
      await respond(1);

      await choose(select(rowOf("verify"), "access"), "");
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", model: "m-big" });
      await respond(2);

      await choose(select(rowOf("verify"), "access"), "full");
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", model: "m-big", access: "full" });
    });

    it("选了同一个值：什么也不发", async () => {
      show([verify]);
      await choose(select(rowOf("verify"), "harness"), "codex");
      await choose(select(rowOf("verify"), "model"), "m-big");
      await choose(select(rowOf("verify"), "access"), "read_only");
      expect(put).not.toHaveBeenCalled();
    });

    it("保存失败：下拉框回到服务端那一份，并提示（不留一个看起来存上了的假象）", async () => {
      show([verify]);
      await choose(select(rowOf("verify"), "access"), "full");
      expect(select(rowOf("verify"), "access").value).toBe("full");

      await refuse(0, new ApiError("model_settings_unavailable", "", 503));
      expect(select(rowOf("verify"), "access").value).toBe("read_only");
      expect(store.get().toasts.at(-1)?.text).toContain("没能保存角色");
    });

    it("连着改几次：请求按点击的顺序一个接一个发，界面始终停在最后一次点选的值上，不闪回", async () => {
      show([verify]);
      await choose(select(rowOf("verify"), "access"), "full");
      await choose(select(rowOf("verify"), "effort"), "low");
      // 第二个请求要等第一个的回执。
      expect(put).toHaveBeenCalledTimes(1);
      expect(values(rowOf("verify"))).toMatchObject({ access: "full", effort: "low" });

      await respond(0, { pushFirst: true });
      expect(put).toHaveBeenCalledTimes(2);
      expect(put).toHaveBeenLastCalledWith("verify", { harness: "codex", model: "m-big", effort: "low", access: "full" });
      // 第一个的回执回来了，但最后一次点选还没有确认：不回跳。
      expect(values(rowOf("verify"))).toMatchObject({ access: "full", effort: "low" });

      await respond(1);
      expect(values(rowOf("verify"))).toEqual({ harness: "codex", model: "m-big", effort: "low", access: "full" });
    });

    it("内容读不出来的旧角色：重新选一个执行端就修好了（整条改写，用它原来的名称）", async () => {
      show([{ name: "broken", invalid: "entry" }]);
      await choose(select(rows()[0]!, "harness"), "pi");
      expect(put).toHaveBeenCalledWith("broken", { harness: "pi" });

      await respond(0);
      const row = rows()[0]!;
      expect(pip(row)).toBe("ready");
      expect(message(row)).toBeUndefined();
      expect(select(row, "model").disabled).toBe(false);
    });
  });

  // ───────────────────────── 改名 ─────────────────────────

  describe("改名", () => {
    it("回车提交：名称规范化之后存；这一行不重新挂载，输入框不丢焦点（推送比回执先到也一样）", async () => {
      show([verify, scout]);
      const row = rowOf("verify");
      const input = nameInput(row);
      act(() => input.focus());
      type(input, " Check ");
      press(input, "Enter");
      await flush();
      expect(rename).toHaveBeenCalledTimes(1);
      expect(rename).toHaveBeenCalledWith("verify", "check");

      await respond(0, { pushFirst: true });
      expect(rows().map((item) => nameInput(item).value)).toEqual(["check", "scout"]);
      expect(rows()[0]).toBe(row);
      expect(nameInput(rows()[0]!)).toBe(input);
      expect(input.value).toBe("check");
      expect(document.activeElement).toBe(input);
    });

    it("离开输入框也提交", async () => {
      show([verify]);
      const input = nameInput(rowOf("verify"));
      type(input, "check");
      await leave(input);
      expect(rename).toHaveBeenCalledWith("verify", "check");
    });

    // 下面几条在输入框里改了字之后，按名称就找不到这一行了：先把行拿在手里。
    it("改成别的角色已有的名称：不发请求，说明重名", async () => {
      show([verify, scout]);
      const row = rowOf("verify");
      const input = nameInput(row);
      type(input, "scout");
      press(input, "Enter");
      await flush();
      expect(rename).not.toHaveBeenCalled();
      expect(message(row)).toBe("已经有一个叫「scout」的角色。");
      expect(input.getAttribute("aria-invalid")).toBe("true");
    });

    it("改成不合规的名称：不发请求，说明哪里不合规；改回来就没有提示", async () => {
      show([verify]);
      const row = rowOf("verify");
      const input = nameInput(row);
      type(input, "007");
      press(input, "Enter");
      await flush();
      expect(rename).not.toHaveBeenCalled();
      expect(message(row)).toBe("名称不能全是数字：至少要有一个字母、- 或 _。");

      type(input, "verify");
      expect(message(row)).toBeUndefined();
      expect(input.hasAttribute("aria-invalid")).toBe(false);
    });

    it("把名称清空再离开：当作没改，回到原来的名称（不存一个空名字）", async () => {
      show([verify]);
      const row = rowOf("verify");
      const input = nameInput(row);
      type(input, "");
      await leave(input);
      expect(input.value).toBe("verify");
      expect(rename).not.toHaveBeenCalled();
      expect(message(row)).toBeUndefined();
    });

    it("没改名称就离开：什么也不发", async () => {
      show([verify]);
      await leave(nameInput(rowOf("verify")));
      expect(rename).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    });

    it("Esc：有没提交的改动时先撤销它（并拦下这次 Esc，设置窗口不跟着关）；没有改动就放行让窗口关闭", () => {
      show([verify]);
      const input = nameInput(rowOf("verify"));
      type(input, "changed");
      const first = press(input, "Escape");
      expect(first.defaultPrevented).toBe(true);
      expect(input.value).toBe("verify");

      const second = press(input, "Escape");
      expect(second.defaultPrevented).toBe(false);
    });

    it("输入法组字期间的回车不提交", async () => {
      show([verify]);
      const input = nameInput(rowOf("verify"));
      type(input, "check");
      press(input, "Enter", { isComposing: true });
      await flush();
      expect(rename).not.toHaveBeenCalled();
    });

    it("改名被拒绝：名称框回到原来的名称，并提示", async () => {
      show([verify]);
      const input = nameInput(rowOf("verify"));
      type(input, "check");
      press(input, "Enter");
      await flush();
      await refuse(0, new ApiError("invalid_request", "A role named check already exists.", 400));
      expect(input.value).toBe("verify");
      expect(store.get().toasts.at(-1)?.text).toContain("没能保存角色");
      expect(rows().map((row) => nameInput(row).value)).toEqual(["verify"]);
    });

    it("名称不合规的旧角色：改一个合规的名称就能修好（用原来的名称去改）", async () => {
      show([{ name: "Bad Name", invalid: "name", harness: "pi" }]);
      const input = nameInput(rows()[0]!);
      type(input, "good-name");
      press(input, "Enter");
      await flush();
      expect(rename).toHaveBeenCalledWith("Bad Name", "good-name");

      await respond(0);
      const row = rows()[0]!;
      expect(nameInput(row).value).toBe("good-name");
      expect(pip(row)).toBe("ready");
      expect(select(row, "model").disabled).toBe(false);
    });
  });

  // ───────────────────────── 删除 ─────────────────────────

  describe("删除", () => {
    it("先确认（写明后果），确认之后才发；删完焦点交给“添加角色”", async () => {
      show([verify, scout]);
      expect(deleteButton(rowOf("verify")).getAttribute("aria-label")).toBe("删除角色 verify");
      click(deleteButton(rowOf("verify")));

      const confirm = store.get().confirm;
      expect(confirm).toMatchObject({ title: "删除角色「verify」？", confirmLabel: "删除", tone: "danger" });
      expect(confirm?.body).toContain("之后主 Agent 再用这个名称委派会被拒绝");
      await flush();
      expect(remove).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(2);

      act(() => void confirm!.onConfirm());
      await flush();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("verify");

      await respond(0);
      expect(rows().map((row) => nameInput(row).value)).toEqual(["scout"]);
      expect(document.activeElement).toBe(addButton());
    });

    it("删除失败：这一行还在，提示失败", async () => {
      show([verify]);
      click(deleteButton(rowOf("verify")));
      act(() => void store.get().confirm!.onConfirm());
      await flush();
      await refuse(0, new ApiError("internal", "", 500));
      expect(rows().map((row) => nameInput(row).value)).toEqual(["verify"]);
      expect(store.get().toasts.at(-1)?.text).toContain("没能删除角色");
    });

    it("无效的旧角色也能删（用它原来的名称，原样放进请求）", async () => {
      show([{ name: "Bad Name", invalid: "name", harness: "pi" }]);
      expect(deleteButton(rows()[0]!).getAttribute("aria-label")).toBe("删除角色 Bad Name");
      click(deleteButton(rows()[0]!));
      act(() => void store.get().confirm!.onConfirm());
      await flush();
      expect(remove).toHaveBeenCalledWith("Bad Name");
    });
  });
});
