/**
 * 设置 · 角色的测试夹具（只被 ProfilesSection 的三份测试引用，不进页面的打包）：执行端与模型的样本、两个现成的角色、假服务端的请求记录与它对 PUT 的处理。
 * vi 的桩与 beforeEach / afterEach 是按文件生效的，所以假服务端的挂起与回复（hold / respond / refuse）与那组操作小工具由各份测试各写一份。
 * 外观与导航小字：ProfilesSection.test.tsx；新增：ProfilesSection.create.test.tsx；修改、改名、删除：ProfilesSection.edit.test.tsx。
 */
import type { ProfileEntry } from "@shared/profiles";
import type { ProfilesResponse, PutProfileRequest } from "@shared/protocol";
import { TEST_CAPABILITIES } from "@shared/testing";
import type { HarnessId, HarnessInfo, ModelInfo } from "@shared/types";

const MODELS: ModelInfo[] = [
  { id: "m-fast", label: "Fast", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
  { id: "m-big", label: "Big", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "m-plain", label: "Plain" },
];

export const info = (id: HarnessId, patch: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  displayName: id,
  runtime: "native",
  status: "ready",
  models: MODELS,
  capabilities: TEST_CAPABILITIES,
  access: { read_only: { level: "enforced", mechanism: "test" }, full: { level: "enforced", mechanism: "test" } },
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

export const verify: ProfileEntry = { name: "verify", harness: "codex", model: "m-big", effort: "high", access: "read_only" };
export const scout: ProfileEntry = { name: "scout", harness: "pi" };

export type Field = "harness" | "model" | "effort" | "access";

/** 让已经就绪的 Promise 链都跑完。 */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 一次挂起的请求：`run` 说明服务端收到它之后，角色表会变成什么样。 */
export interface Held {
  settled: boolean;
  run(entries: ProfileEntry[]): ProfileEntry[];
  resolve(response: ProfilesResponse): void;
  reject(error: Error): void;
}

/** 服务端对 PUT 的处理：已有的就地改写，没有的排到最后；名称存的是小写。 */
export function upsert(entries: ProfileEntry[], name: string, body: PutProfileRequest): ProfileEntry[] {
  const { create: _create, ...spec } = body;
  const key = name.trim().toLowerCase();
  const next: ProfileEntry = { name: key, ...spec };
  const same = (entry: ProfileEntry): boolean => entry.name === key || entry.name === name;
  return entries.some(same) ? entries.map((entry) => (same(entry) ? next : entry)) : [...entries, next];
}
