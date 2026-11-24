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
 * 设置 · 角色之二：新增——点“添加角色”出现草稿、名称与执行端齐了才落成角色、草稿的各种校验与失败、放弃草稿。
 * 与别的两份一样不挂完整的设置窗口，只渲染这个分区本身，假服务端把每个请求挂起，由用例决定什么时候回、回什么（含“推送比回执先到”）。
 * 外观与导航小字在 ProfilesSection.test.tsx，修改、改名与删除在 ProfilesSection.edit.test.tsx；共用的样本与假服务端的请求记录在 ProfilesSection.fixtures.ts。
 */

describe("设置 · 角色（ProfilesSection）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let put: MockInstance<typeof api.putProfile>;
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
    vi.spyOn(api, "renameProfile").mockImplementation((name, to) =>
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

  // ───────────────────────── 新增 ─────────────────────────

  describe("新增", () => {
    it("点“添加角色”：排在最后多一行草稿，名称框自动获得焦点；执行端待选，别的栏不能选；什么也不发", async () => {
      show([scout]);
      click(addButton());
      expect(rows()).toHaveLength(2);
      const draft = draftRow();
      expect(rows()[1]).toBe(draft);
      expect(document.activeElement).toBe(nameInput(draft));
      expect(nameInput(draft).placeholder).toBe("例如 verify");
      expect(message(draft)).toBe("填好名称并选好执行端后自动保存。");
      expect(pip(draft)).toBe("needs_setup");
      expect(draft.querySelector(".sr-only")).toBeNull();
      expect(select(draft, "harness").value).toBe("");
      expect(labels(select(draft, "harness"))).toEqual(["选择执行端", "Codex", "Pi"]);
      expect(options(select(draft, "harness"))[0]!.disabled).toBe(true);
      expect((["model", "effort", "access"] as const).map((field) => select(draft, field).disabled)).toEqual([true, true, true]);

      await flush();
      expect(put).not.toHaveBeenCalled();
    });

    it("先写名称再选执行端：选定的那一刻存下来（新增，名称被占用就拒绝）；落成角色后还是原来那一行，输入框不丢焦点", async () => {
      show([]);
      click(addButton());
      const input = nameInput(draftRow());
      type(input, " Verify ");
      await flush();
      expect(put).not.toHaveBeenCalled();

      act(() => input.focus());
      await choose(select(draftRow(), "harness"), "codex");
      expect(put).toHaveBeenCalledTimes(1);
      // 名称规范化（去空白、转小写）之后才发。
      expect(put).toHaveBeenCalledWith("verify", { harness: "codex", create: true });

      // 服务端先推送新表、再发回执。
      await respond(0, { pushFirst: true });
      expect(rows()).toHaveLength(1);
      const row = rows()[0]!;
      expect(row.hasAttribute("data-draft")).toBe(false);
      expect(nameInput(row)).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("verify");
      expect(pip(row)).toBe("ready");
      expect(message(row)).toBeUndefined();
      expect(store.get().profiles.entries).toEqual([{ name: "verify", harness: "codex" }]);
    });

    it("没有推送、只有回执时也一样：落成角色之后只有一行，仍是原来的输入框", async () => {
      show([]);
      click(addButton());
      const input = nameInput(draftRow());
      type(input, "verify");
      await choose(select(draftRow(), "harness"), "codex");
      await respond(0);
      expect(rows()).toHaveLength(1);
      expect(nameInput(rows()[0]!)).toBe(input);
      expect(rows()[0]!.hasAttribute("data-draft")).toBe(false);
    });

    it("先选执行端再写名称：选的时候名称还空着，才摆出“名称不能为空”；写好后回车存下来，紧接着的失焦不会再发一次", async () => {
      show([]);
      click(addButton());
      const draft = draftRow();
      const input = nameInput(draft);
      await choose(select(draft, "harness"), "pi");
      expect(put).not.toHaveBeenCalled();
      expect(message(draft)).toBe("名称不能为空。");
      expect(input.getAttribute("aria-invalid")).toBe("true");

      type(input, "scout");
      expect(message(draft)).toBe("填好名称并选好执行端后自动保存。");
      expect(input.hasAttribute("aria-invalid")).toBe(false);
      expect(put).not.toHaveBeenCalled();

      press(input, "Enter");
      await leave(input);
      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith("scout", { harness: "pi", create: true });
      await respond(0);
      expect(rows().map((row) => nameInput(row).value)).toEqual(["scout"]);
    });

    it("名称敲了一半就离开、执行端还没选：不发请求，也不挨骂（没敲完的名称不报错）", async () => {
      show([]);
      click(addButton());
      const draft = draftRow();
      type(nameInput(draft), "ab");
      await leave(nameInput(draft));
      expect(put).not.toHaveBeenCalled();
      expect(message(draft)).toBe("填好名称并选好执行端后自动保存。");
      expect(nameInput(draft).hasAttribute("aria-invalid")).toBe(false);
    });

    it("名称不合规：不发请求，写明哪里不合规；改好之后才存", async () => {
      show([]);
      click(addButton());
      const draft = draftRow();
      const input = nameInput(draft);
      type(input, "Bad Name");
      await choose(select(draft, "harness"), "pi");
      expect(put).not.toHaveBeenCalled();
      expect(message(draft)).toBe("名称只能用小写字母、数字、- 和 _，并以字母或数字开头。");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBe(draft.querySelector(".prof-msg")?.id);

      type(input, "bad-name");
      press(input, "Enter");
      await flush();
      expect(put).toHaveBeenCalledWith("bad-name", { harness: "pi", create: true });
    });

    it("与已有的角色重名（不分大小写）：不发请求，说明重名", async () => {
      show([verify]);
      click(addButton());
      const draft = draftRow();
      type(nameInput(draft), "VERIFY");
      await choose(select(draft, "harness"), "pi");
      expect(put).not.toHaveBeenCalled();
      expect(message(draft)).toBe("已经有一个叫「verify」的角色。");
    });

    it("服务端拒绝（例如另一个页面刚用了同一个名称）：这一行仍是草稿、内容还在，提示失败，之后可以再试", async () => {
      show([]);
      click(addButton());
      const draft = draftRow();
      type(nameInput(draft), "scout");
      await choose(select(draft, "harness"), "pi");
      expect(put).toHaveBeenCalledTimes(1);

      await refuse(0, new ApiError("invalid_request", "A role named scout already exists.", 400));
      expect(store.get().toasts.at(-1)?.text).toContain("没能保存角色");
      expect(rows()).toHaveLength(1);
      expect(draftRow()).toBe(draft);
      expect(nameInput(draft).value).toBe("scout");
      expect(values(draft).harness).toBe("pi");

      press(nameInput(draft), "Enter");
      await flush();
      expect(put).toHaveBeenCalledTimes(2);
    });

    it("放弃一个草稿：不用确认，也不发请求；焦点回到“添加角色”", async () => {
      show([scout]);
      click(addButton());
      const draft = draftRow();
      expect(deleteButton(draft).getAttribute("aria-label")).toBe("放弃这个新角色");
      click(deleteButton(draft));
      expect(rows()).toHaveLength(1);
      expect(store.get().confirm).toBeUndefined();
      expect(document.activeElement).toBe(addButton());
      await flush();
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });
  });
});
