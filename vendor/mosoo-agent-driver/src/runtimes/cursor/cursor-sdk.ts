// ENSEMBLE ADDED — 本文件由 Ensemble 新增（Cursor SDK 后端），不属于上游 mosoo-agent-driver。详见 VENDORING.md。
import type { Json } from "./cursor-values";
import { asRecord } from "./cursor-values";

/**
 * 后端实际用到的 `@cursor/sdk` 表面。用结构类型描述，而不是直接依赖 SDK 的类型：
 * SDK 带原生组件，所以只在运行时按需加载；测试里也可以换成假 SDK。
 *
 * 形状依据 @cursor/sdk 1.3.1 的类型定义与打包源码：
 * - `Run.stream()` 产出 system / user / assistant / thinking / tool_call / usage / status / summary / task / request 消息；
 * - `Run.wait()` 返回 `{ status: "finished" | "error" | "cancelled", result?, usage?, error? }`；
 * - `Run.steer()` 可选：控制器不支持时 SDK 自己回答 `revert_to_followup`，或抛 `UnsupportedRunOperationError`；
 * - `Agent.resume(id, options)` 重新接入已持久化的 Agent；`tools` 不随会话持久化，恢复时要重新传。
 */
export interface CursorSdkRun {
  readonly id: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<unknown>;
  cancel(): Promise<void>;
  steer?(text: string): Promise<string>;
}

export interface CursorSdkAgent {
  readonly agentId: string;
  send(message: string, options?: Json): Promise<CursorSdkRun>;
  close(): void | Promise<void>;
}

/** 后端只需要 Agent；宿主另外用 `Cursor.*` 做探测、模型目录与账号状态，那些不属于后端。 */
export interface CursorSdkAgentApi {
  Agent: {
    create(options: Json): Promise<CursorSdkAgent>;
    resume(agentId: string, options?: Json): Promise<CursorSdkAgent>;
  };
}

export type CursorSdkAgentLoader = () => Promise<CursorSdkAgentApi>;

export const CURSOR_SDK_PACKAGE = "@cursor/sdk";

/** SDK 的 `Agent`、`Cursor` 是带静态方法的类（函数），不是普通对象：两种都算“导出存在”。 */
export function isSdkExport(value: unknown): boolean {
  return typeof value === "function" || asRecord(value) !== undefined;
}

/** 打包成 CommonJS 的 SDK 经 ESM 导入时，命名导出可能挂在 default 上。 */
export function asCursorSdkAgentApi(moduleValue: unknown): CursorSdkAgentApi {
  const record = asRecord(moduleValue);
  const candidate = isSdkExport(record?.["Agent"]) ? record : asRecord(record?.["default"]);
  if (!isSdkExport(candidate?.["Agent"])) {
    throw new Error("The module does not export the Cursor SDK's Agent.");
  }
  return candidate as unknown as CursorSdkAgentApi;
}

/** 默认加载器：直接 import 随安装的 `@cursor/sdk`。宿主可以换成自己的（例如指定目录）。 */
export async function loadCursorSdkPackage(): Promise<CursorSdkAgentApi> {
  const specifier: string = CURSOR_SDK_PACKAGE;
  const moduleValue: unknown = await import(/* @vite-ignore */ specifier);
  return asCursorSdkAgentApi(moduleValue);
}
