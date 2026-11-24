import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { TEST_CAPABILITIES } from "@shared/testing";
import type { HarnessId, HarnessInfo, ModelInfo } from "@shared/types";
import { api } from "../../lib/api";
import { setLang, store } from "../../lib/app";
import { SettingsWindow } from "./SettingsWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const MODELS: ModelInfo[] = [
  { id: "m-a", label: "Alpha", isDefault: true },
  { id: "m-b", label: "Beta" },
  { id: "m-c", label: "Gamma", efforts: ["low", "high"] },
];

export const harness = (patch: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id: "codex",
  displayName: "Codex",
  runtime: "native",
  status: "ready",
  version: "0.151.0",
  models: MODELS,
  defaultModel: "m-a",
  capabilities: TEST_CAPABILITIES,
  access: { read_only: { level: "enforced", mechanism: "sandbox" }, full: { level: "none", mechanism: "no sandbox" } },
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

interface Pending {
  allowed: string[] | null;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * 执行端分区测试的公共装置，在 describe 里调用（钩子随之注册进那个 describe）。
 * 假服务只按请求保存：null 解除限制，数组始终是精确名单；档位按整份快照替换，省略表示不改动。
 * pending / calls / effortCalls / stats 是同一份对象，每个用例开始前清空，可以放心解构。
 */
export function installRig() {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const pending: Pending[] = [];
  const calls: (string[] | null)[] = [];
  const effortCalls: (Record<string, string[]> | undefined)[] = [];
  /** 每次保存带的默认模型：undefined＝没带（不改动），null＝清掉，字符串＝指定。 */
  const defaultCalls: (string | null | undefined)[] = [];
  const stats = { inFlight: 0, peak: 0 };
  let current: HarnessInfo;

  const serverView = (allowed: string[] | null, efforts?: Record<string, string[]>, chosen?: string | null): HarnessInfo => {
    const { allowedModels: _drop, allowedEfforts: _kept, userDefaultModel: _chosen, modelSettingsIssue: _issue, ...rest } = current;
    const saved = efforts ?? current.allowedEfforts;
    // 与真服务端同一条规则：省略＝不改动，null＝清掉；新名单把它排除在外时一并清掉。
    const wanted = chosen === undefined ? current.userDefaultModel : chosen ?? undefined;
    const user = wanted !== undefined && (allowed === null || allowed.includes(wanted)) ? wanted : undefined;
    return {
      ...rest,
      ...(allowed === null ? {} : { allowedModels: allowed }),
      ...(saved && Object.keys(saved).length > 0 ? { allowedEfforts: saved } : {}),
      ...(user === undefined ? {} : { userDefaultModel: user }),
    };
  };

  beforeEach(() => {
    setLang("zh");
    pending.length = 0;
    calls.length = 0;
    effortCalls.length = 0;
    defaultCalls.length = 0;
    stats.inFlight = 0;
    stats.peak = 0;
    vi.spyOn(api, "setAllowedModels").mockImplementation((_id: HarnessId, allowed, efforts, chosen) => {
      calls.push(allowed);
      effortCalls.push(efforts);
      defaultCalls.push(chosen);
      stats.inFlight += 1;
      stats.peak = Math.max(stats.peak, stats.inFlight);
      return new Promise((resolve, reject) => {
        pending.push({
          allowed,
          resolve: () => {
            stats.inFlight -= 1;
            current = serverView(allowed, efforts, chosen);
            resolve({ harness: current });
          },
          reject: (error) => {
            stats.inFlight -= 1;
            reject(error);
          },
        });
      });
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.set({ settings: { open: false, section: undefined }, harnesses: [], pendingModelSettings: {}, toasts: [] });
    vi.restoreAllMocks();
  });

  const show = (...infos: HarnessInfo[]): void => {
    current = infos[0]!;
    store.set({ harnesses: infos, settings: { open: true, section: "executors" }, toasts: [] });
    act(() => root.render(<SettingsWindow />));
  };

  const rows = (): HTMLLabelElement[] => [...document.body.querySelectorAll<HTMLLabelElement>(".mrow")];
  const rowOf = (label: string): HTMLLabelElement => {
    const found = rows().find((row) => row.querySelector(".mrow-name")?.textContent === label);
    if (!found) throw new Error(`no row ${label}`);
    return found;
  };
  const itemOf = (label: string): HTMLLIElement => rowOf(label).closest("li")!;
  const moreOf = (label: string): HTMLButtonElement | null => itemOf(label).querySelector<HTMLButtonElement>(".mrow-more");
  const regionOf = (label: string): HTMLElement | null => itemOf(label).querySelector<HTMLElement>(".mefforts");
  const levelsOf = (label: string): string[] =>
    [...(regionOf(label)?.querySelectorAll<HTMLLabelElement>(".echip") ?? [])].map((node) => `${node.textContent}:${node.querySelector("input")!.checked ? "on" : "off"}`);
  const levelInput = (label: string, level: string): HTMLInputElement => {
    const found = [...(regionOf(label)?.querySelectorAll<HTMLLabelElement>(".echip") ?? [])].find((node) => node.textContent === level);
    if (!found) throw new Error(`no level ${level} under ${label}`);
    return found.querySelector("input")!;
  };
  const expand = (label: string): void => {
    act(() => moreOf(label)!.click());
  };
  const marks = (): string[] =>
    rows().map((row) => `${row.querySelector(".mrow-name")?.textContent}:${row.querySelector<HTMLInputElement>("input")?.checked ? "on" : "off"}`);
  const tick = (label: string): void => {
    act(() => rowOf(label).querySelector<HTMLInputElement>("input")!.click());
  };
  const bulk = (label: string): HTMLButtonElement => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>(".mcfg-bulk button")].find((button) => button.textContent === label);
    if (!found) throw new Error(`no button ${label}`);
    return found;
  };
  const count = (): string | null | undefined => document.body.querySelector(".section-count")?.textContent;
  const settle = async (): Promise<void> => {
    for (let guard = 0; guard < 10 && pending.length > 0; guard += 1) {
      await act(async () => {
        pending.shift()!.resolve();
      });
    }
  };
  const type = (input: HTMLInputElement, value: string): void => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  /** 一行的默认模型单选（没开放的行没有）。 */
  const pickOf = (label: string): HTMLInputElement | null => itemOf(label).querySelector<HTMLInputElement>(".mpick-input");
  const picks = (): string[] => rows().filter((row) => pickOf(row.querySelector(".mrow-name")!.textContent!)?.checked).map((row) => row.querySelector(".mrow-name")!.textContent!);
  const chips = (): string[] => rows().flatMap((row) => [...row.querySelectorAll(".chip")].map((chip) => `${row.querySelector(".mrow-name")!.textContent}:${chip.textContent}`));

  return { pending, calls, effortCalls, defaultCalls, stats, show, rows, rowOf, itemOf, moreOf, regionOf, levelsOf, levelInput, expand, marks, tick, bulk, count, settle, type, pickOf, picks, chips };
}
