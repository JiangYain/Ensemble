// ENSEMBLE MODIFIED — 本文件已被 Ensemble 修改（Apache-2.0 §4(b)）。
// 相对上游的改动：
//   1. 不再引入 acp / claude / openai / pi 四个后端（它们依赖 Bun 与 Linux 才有的能力，本机 Windows 上没有验证过）；
//      其中 openai、pi 的源码仍保留在 src/runtimes 下备查，但没有登记也不参与编译。
//   2. 登记 Ensemble 新增的 Cursor SDK 后端（transport "cursor-sdk" / runtime "cursor"）。
//   3. Cursor 没有交互式授权通道、也没有 Driver 托管的 MCP 执行，所以能力声明里
//      permission_request / mcp_execute 如实写成 unsupported。
// 其余校验逻辑（transport 与 runtime 必须对应、内置工具限制只有 Claude 支持、额外目录限制）与上游一致。详见 VENDORING.md。
import type { AgentDriverBackend } from "../core/agent-driver-backend";
import type { DriverRuntime, DriverRuntimeTransport } from "../protocol/runtime";
import type { DriverStartInput } from "../protocol/start";
import type { DriverCapability } from "../runtime-command";
import { CursorDriverBackend } from "./cursor/cursor-driver-backend";

export interface AgentDriverProviderDescriptor {
  readonly capabilities: readonly DriverCapability[];
  createBackend(input: DriverStartInput): AgentDriverBackend;
  readonly id: DriverRuntimeTransport;
  readonly runtime: DriverRuntime;
}

/** ENSEMBLE ADDED：Cursor 本地 Agent 的能力声明。 */
const CURSOR_CAPABILITIES = [
  { id: "custom_tool_execute", status: "unsupported", version: 1 },
  { id: "file_change", status: "supported", version: 1 },
  { id: "input_start", status: "supported", version: 1 },
  // Cursor 本地 Agent 自己执行工具（含它自己的 MCP）；Driver 不参与托管。
  { id: "mcp_execute", status: "unsupported", version: 1 },
  // 本地运行没有交互式授权通道，所有工具直接执行（全权限）。
  { id: "permission_request", status: "unsupported", version: 1 },
  { id: "session_stop", status: "supported", version: 1 },
  { id: "text_stream", status: "supported", version: 1 },
  { id: "tool_stream", status: "supported", version: 1 },
  { id: "turn_cancel", status: "supported", version: 1 },
  { id: "usage", status: "supported", version: 1 },
  { id: "visible_activity", status: "supported", version: 1 },
  { id: "native_resume", status: "supported", version: 1 },
  { id: "thinking_stream", status: "supported", version: 1 },
] as const satisfies readonly DriverCapability[];

const PROVIDERS = [
  {
    capabilities: CURSOR_CAPABILITIES,
    createBackend: (payload) => new CursorDriverBackend(payload),
    id: "cursor-sdk",
    runtime: "cursor",
  },
] as const satisfies readonly AgentDriverProviderDescriptor[];

export const AGENT_DRIVER_PROVIDER_REGISTRY = {
  createBackend(input: DriverStartInput): AgentDriverBackend {
    return resolveProviderForStartInput(input).createBackend(input);
  },
  getByStartInput: resolveProviderForStartInput,
  list: () => PROVIDERS,
};

export function createAgentDriverProviderCapabilities(input: {
  permissionRequestStatus: DriverCapability["status"];
  provider: AgentDriverProviderDescriptor;
}): readonly DriverCapability[] {
  return input.provider.capabilities.map((capability) =>
    capability.id === "permission_request"
      ? { ...capability, status: input.permissionRequestStatus }
      : capability,
  );
}

function resolveProviderForStartInput(input: DriverStartInput): AgentDriverProviderDescriptor {
  const provider = PROVIDERS.find((candidate) => candidate.id === input.runtimeTransport);

  if (!provider) {
    throw new Error(`Unsupported runtime transport: ${input.runtimeTransport}.`);
  }

  if (input.runtime !== provider.runtime) {
    throw new Error(`Runtime ${input.runtime} does not match transport ${input.runtimeTransport}.`);
  }

  if (input.execution.builtInTools.some((tool) => !tool.enabled)) {
    throw new Error(`Runtime ${provider.runtime} does not support built-in tool restrictions.`);
  }

  // ENSEMBLE ADDED：Cursor SDK 的本地 Agent 只有一个工作目录（local.cwd）。
  if (input.execution.session.additionalDirectories.length > 0) {
    throw new Error(`Runtime ${provider.runtime} does not support additional directories.`);
  }

  return provider;
}
