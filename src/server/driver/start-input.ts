import { CURSOR_API_KEY_VARIABLE, createDriverId } from "@mosoo/agent-driver";
import type { CursorModelParam, DriverInstanceId, DriverStartInput, RunId, SessionId } from "@mosoo/agent-driver";
import type { AccountId, SandboxId, SandboxSessionId } from "@mosoo/agent-driver/protocol/boot/host-ids";

export interface CursorStartInputOptions {
  /** Cursor 里这个 Agent 显示的名字（只在新建时使用）。 */
  agentName?: string | undefined;
  /** 显式凭据；没有时由 SDK 自己找登录状态。 */
  apiKey?: string | undefined;
  cwd: string;
  /** 失败信息里附带的“该账号可用的模型”提示。 */
  modelHint?: string | undefined;
  modelId: string;
  modelParams?: readonly CursorModelParam[] | undefined;
  readOnly: boolean;
  /** 重新接入时给出已有的 Cursor Agent id。 */
  resumeAgentId?: string | undefined;
  settingSources: readonly string[];
}

/**
 * Ensemble 在进程内驱动 Driver Kernel 时使用的启动输入。
 *
 * Driver 的启动输入带着 mosoo 平台的字段（沙箱、账号、模型代理……）。Ensemble 没有这些概念，
 * 它们只用来满足类型：Cursor 后端不读取它们，也不会访问 modelConnection 里的地址。
 */
export function buildCursorStartInput(options: CursorStartInputOptions): DriverStartInput {
  const account = createDriverId() as AccountId;
  const sandboxId = createDriverId() as SandboxId;
  const resume = options.resumeAgentId
    ? ({ kind: "cursor_agent_id", runtimeId: "cursor", value: options.resumeAgentId } as const)
    : null;

  return {
    driverInstanceId: createDriverId() as DriverInstanceId,
    runtime: "cursor",
    runtimeTransport: "cursor-sdk",
    sandboxId,
    execution: {
      // 不禁用任何内置工具：访问级别靠 providerOptions.readOnly 表达，Cursor 的工具白名单由后端设置。
      builtInTools: [],
      environment: { variables: options.apiKey ? { [CURSOR_API_KEY_VARIABLE]: options.apiKey } : {} },
      model: options.modelId,
      modelConnection: { protocol: "openai-responses", proxyUrl: "http://127.0.0.1:1", proxyGrant: "unused" },
      // 被委派的 Agent 是 Full Access：没有需要人批准的闸门，也就没有权限请求。
      permissionPolicy: "full_access",
      provider: "cursor-sdk",
      providerOptions: {
        readOnly: options.readOnly,
        settingSources: [...options.settingSources],
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.modelHint ? { modelHint: options.modelHint } : {}),
        ...(options.modelParams ? { modelParams: options.modelParams.map((param) => ({ id: param.id, value: param.value })) } : {}),
      },
      // 内核在 session.stop 时需要一个“确切的运行 id”来收束实例：从没跑过任何运行的会话也得有，
      // 所以给一个永远不会被启动的占位运行（真正的运行用各自的 id，由 input.start 带进来）。
      run: { runId: createDriverId() as RunId, sessionId: createDriverId() as SessionId },
      session: {
        additionalDirectories: [],
        context: {
          homePath: options.cwd,
          origin: { callerUserId: account, entrypoint: "chat", executionOwnerUserId: account, type: "agent" },
          sandboxId,
          sandboxSessionId: createDriverId() as SandboxSessionId,
          sandboxSubjectId: createDriverId(),
          sandboxSubjectKind: "ensemble-session",
          sessionOrganizationPath: options.cwd,
        },
        cwd: options.cwd,
        homePath: options.cwd,
        mcpServers: [],
        // 内核只在启动时读它：重新接入以 Agent id 为准，没有可用的“上一次运行”，用一个新的 id 占位。
        nativeCheckpoint: resume ? { formatVersion: 1, nativeRef: resume, runId: createDriverId() as RunId } : null,
        nativeResumeRef: resume,
        recoveryMessages: [],
        sharedRootPath: options.cwd,
      },
      skillCatalog: [],
      skills: [],
      systemPrompt: "",
    },
  };
}
