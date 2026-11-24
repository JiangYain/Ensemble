// ENSEMBLE ADDED — 本文件由 Ensemble 新增（Cursor SDK 后端），不属于上游 mosoo-agent-driver。详见 VENDORING.md。
import type { DriverExecutionInput } from "../../protocol/execution";
import { CursorStartError } from "./cursor-errors";
import { CURSOR_READ_ONLY_TOOLS } from "./cursor-tool-format";
import { asRecord, clip, isString, str } from "./cursor-values";

/** 与 `Agent.create` 的 `settingSources` 对应；默认只加载项目层（规则、AGENTS.md），不加载用户层与团队层。 */
export const CURSOR_SETTING_SOURCES: ReadonlySet<string> = new Set(["project", "user", "team", "mdm", "plugins", "all"]);
export const CURSOR_DEFAULT_SETTING_SOURCES: readonly string[] = ["project"];

export const CURSOR_API_KEY_VARIABLE = "CURSOR_API_KEY";

export interface CursorModelParam {
  readonly id: string;
  readonly value: string;
}

/**
 * 后端从 `DriverStartInput.execution` 读到的配置。
 *
 * - `execution.model`：已经由宿主按 Cursor 的模型目录解析好的正式模型 id；
 * - `execution.environment.variables.CURSOR_API_KEY`：显式凭据（没有时由 SDK 自己找登录状态）；
 * - `execution.providerOptions`：见下，全是可选项，写错类型会明说而不是悄悄忽略。
 */
export interface CursorBackendConfiguration {
  readonly agentName: string | undefined;
  readonly apiKey: string | undefined;
  /** 失败信息里附带的“该账号可用的模型”提示（宿主有模型目录，后端没有）。 */
  readonly modelHint: string | undefined;
  readonly modelId: string;
  readonly modelParams: readonly CursorModelParam[] | undefined;
  /** 只读会话：把工具限制为读类，并拦截任何仍然出现的变更类工具。 */
  readonly readOnly: boolean;
  readonly settingSources: readonly string[];
}

function invalid(message: string): never {
  throw new CursorStartError("invalid_request", `Invalid Cursor provider option: ${message}`);
}

function readModelParams(value: unknown): CursorModelParam[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid("modelParams must be an array of { id, value }.");
  return value.map((entry: unknown, index) => {
    const record = asRecord(entry);
    const id = str(record?.["id"]);
    const paramValue = str(record?.["value"]);
    if (!id || paramValue === undefined) invalid(`modelParams[${index}] must have a string id and value.`);
    return { id, value: paramValue };
  });
}

function readSettingSources(value: unknown): string[] {
  if (value === undefined) return [...CURSOR_DEFAULT_SETTING_SOURCES];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid("settingSources must be an array of strings.");
  }
  const sources = (value as string[]).map((entry) => entry.trim().toLowerCase());
  const unknown = sources.find((entry) => !CURSOR_SETTING_SOURCES.has(entry));
  if (unknown !== undefined) invalid(`settingSources contains "${clip(unknown, 40)}", which the SDK does not know.`);
  return sources;
}

export function readCursorConfiguration(execution: DriverExecutionInput): CursorBackendConfiguration {
  const modelId = execution.model.trim();
  if (!modelId) throw new CursorStartError("model_not_found", "No Cursor model was given to the driver.");
  const options = execution.providerOptions;
  const apiKey = execution.environment.variables[CURSOR_API_KEY_VARIABLE]?.trim();
  const agentName = str(options["agentName"]);
  const modelHint = str(options["modelHint"]);
  const readOnly = options["readOnly"];
  if (readOnly !== undefined && typeof readOnly !== "boolean") invalid("readOnly must be a boolean.");
  return {
    agentName: agentName && isString(agentName) ? clip(agentName, 80) : undefined,
    apiKey: apiKey ? apiKey : undefined,
    modelHint,
    modelId,
    modelParams: readModelParams(options["modelParams"]),
    readOnly: readOnly === true,
    settingSources: readSettingSources(options["settingSources"]),
  };
}

/** `Agent.create / resume` 的 options。tools 不随会话持久化，恢复时也要重新传。 */
export function buildAgentOptions(
  configuration: CursorBackendConfiguration,
  cwd: string,
  resuming: boolean,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    model: {
      id: configuration.modelId,
      ...(configuration.modelParams ? { params: configuration.modelParams.map((param) => ({ ...param })) } : {}),
    },
    local: { cwd, settingSources: [...configuration.settingSources] },
  };
  if (configuration.apiKey) options["apiKey"] = configuration.apiKey;
  if (configuration.readOnly) options["tools"] = [...CURSOR_READ_ONLY_TOOLS];
  if (!resuming && configuration.agentName) options["name"] = configuration.agentName;
  return options;
}
