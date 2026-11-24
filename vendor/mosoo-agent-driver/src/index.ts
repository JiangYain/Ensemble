// ENSEMBLE MODIFIED — 本文件已被 Ensemble 修改（Apache-2.0 §4(b)）。
// 相对上游的改动：删除对 projections / surfaces / stores（Managed-Agents 形态的实验性 HTTP 适配）的导出，
// 因为这几个目录没有被拷进来；新增 Cursor SDK 后端相关导出。其余导出与上游一致。详见 VENDORING.md。
export type {
  AgentDriverKernel,
  AgentDriverKernelStartInput,
  AgentDriverRuntimeEvent,
} from "./core/agent-driver-kernel";
export { AgentDriverKernelCore } from "./core/agent-driver-kernel";
export type { AgentDriverKernelOptions } from "./core/agent-driver-kernel";
export { createDriverDiagnosticEvent, pushDriverDiagnosticEvent } from "./core/driver-diagnostics";
export type {
  DriverDiagnosticCode,
  DriverDiagnosticInput,
  DriverDiagnosticSeverity,
} from "./core/driver-diagnostics";
export type {
  AgentDriverHostPorts,
  AgentDriverCommandSource,
  AgentDriverEventSink,
  AgentDriverPermissionPort,
  DriverPermissionRequest,
  AgentDriverMaterializedSkill,
  AgentDriverMcpPort,
  AgentDriverSkillPort,
  AgentDriverFilePort,
} from "./host-ports";
export type {
  AgentDriverBackend,
  AgentDriverBackendFactory,
  AgentDriverContext,
  AgentDriverContextInput,
  AgentDriverContextPortOverrides,
} from "./core/agent-driver-backend";
export { createAgentDriverContext } from "./core/agent-driver-backend";
export * from "./protocol/runtime";
export { parseDriverEventEnvelope } from "./protocol/events";
export type { DriverEvent, DriverEventEnvelope, DriverEventInput } from "./protocol/events";
export type {
  DriverExecutionInput,
  DriverExecutionRunInput,
  DriverExecutionSessionInput,
} from "./protocol/execution";
export type { DriverStartInput } from "./protocol/start";
export {
  createDriverId,
  isDriverId,
  normalizeDriverId,
  parseDriverId,
  DRIVER_ID_INPUT_PATTERN,
  DRIVER_ID_PATTERN,
} from "./protocol/id";
export type {
  DriverInstanceId,
  DriverId,
  EventId,
  SemanticDriverId,
  SessionId,
  MessageId,
  RunId,
} from "./protocol/id";
export {
  createMcpUnknownEffectRunError,
  createMcpUnsettledEffectRunError,
  parseRuntimeCommand,
} from "./runtime-command";
export type {
  DriverCapability,
  DriverCapabilityId,
  DriverCommandUpdate,
  InputStartCommand,
  InputStartCommandResult,
  McpExecuteCommand,
  McpExecuteCommandResult,
  PermissionResolveCommand,
  RunError,
  RuntimeCommand,
  RuntimeCommandInput,
  RuntimeCommandResult,
  RuntimeCommandStatus,
  SessionStopCommand,
  TurnCancelCommand,
} from "./runtime-command";
export {
  AGENT_DRIVER_PROVIDER_REGISTRY,
  createAgentDriverProviderCapabilities,
} from "./runtimes/provider-registry";
export type { AgentDriverProviderDescriptor } from "./runtimes/provider-registry";
// ENSEMBLE ADDED：Cursor SDK 后端。
export * from "./runtimes/cursor";
