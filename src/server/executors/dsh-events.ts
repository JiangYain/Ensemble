import { clip } from "@shared/format";
import type { ToolUpdate } from "@shared/events";
import type { AccessLevel, ErrorInfo, FileChange, ModelInfo, PlanEntry, Preview, ToolCategory, ToolStatus, Usage } from "@shared/types";
import { arr, asRecord, categorizeTool, countLines, displayPath, errorInfoFromText, inputPreview, num, oneLine, outputPreview, str, type Json } from "./common";
import type { DshRpcError } from "./dsh-rpc";

/**
 * dsh（ACP）的 `session/update` 与模型目录 → Ensemble 的统一事件字段。纯函数，不碰进程与状态。
 * 形状取自 dsh 0.2.2-rc.1 的真实运行记录（2026-11-16），不是文档推断：
 * - 助手文字、推理都是整块提交的（没有逐字流）；
 * - tool_call 的 `title` 就是工具名，`kind` 恒为 other；参数在 `rawInput`；
 * - 工具结果是 `content: [{ type: "content", content: { type: "text", text } }]`；
 * - 命令的退出码只写在输出末尾的 `[exit code: N]`，非零时 dsh 仍报 completed，所以要自己判；
 * - 没有 plan / diff / terminal 类更新，计划来自 todo_write 的参数，文件变更来自 write / edit 的参数与结果。
 */

// ───────────────────────── 工具 ─────────────────────────

/** dsh 的 23 个内置工具里 categorizeTool 认不出的那些（read / write / edit / grep / glob / web_fetch / todo_write / subagent 它认得）。 */
const CATEGORY: Record<string, ToolCategory> = {
  pwsh: "shell",
  job_list: "shell",
  job_output: "shell",
  job_kill: "shell",
  read_image: "read",
  create_goal: "plan",
  get_goal: "plan",
  update_goal: "plan",
  subagent_fork: "task",
  send_message: "task",
  interrupt_agent: "task",
  list_agents: "task",
  workflow: "task",
  skill: "task",
};

export function dshToolCategory(name: string): ToolCategory {
  return CATEGORY[name.toLowerCase()] ?? categorizeTool(name);
}

/** 一次工具调用开始时记下的信息：结束时判断类别、文件变更与计划都要用它。 */
export interface ToolTrack {
  callId: string;
  name: string;
  category: ToolCategory;
  input: Json | undefined;
  startedAt: string;
}

/** 语言无关的简短摘要：路径、命令、查询词。 */
export function toolTitle(name: string, input: Json | undefined, cwd: string): string {
  const path = str(input?.["file_path"]) ?? str(input?.["path"]);
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "read_image":
      return path ? displayPath(cwd, path) : name;
    case "pwsh":
      return oneLine(str(input?.["command"]) ?? str(input?.["description"]) ?? name, 140);
    case "grep":
    case "glob": {
      const pattern = str(input?.["pattern"]);
      return oneLine([pattern, path ? `in ${displayPath(cwd, path)}` : undefined].filter(Boolean).join(" ") || name, 120);
    }
    case "web_fetch":
      return oneLine(str(input?.["url"]) ?? name, 140);
    case "subagent":
    case "subagent_fork":
      return oneLine(str(input?.["description"]) ?? name, 120);
    default: {
      const first = Object.values(input ?? {}).find((value): value is string => typeof value === "string" && value.length > 0);
      return first ? oneLine(first, 120) : name;
    }
  }
}

interface LineDiff {
  /** `-旧行` / `+新行`，去掉了首尾相同的行。 */
  text: string;
  added: number;
  removed: number;
}

/** edit 的“旧文本→新文本”只看真正变了的行：首尾相同的行不算增删。 */
function lineDiff(oldText: string, newText: string): LineDiff {
  const before = oldText.split("\n");
  const after = newText.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tailLength = 0;
  while (
    tailLength < before.length - head &&
    tailLength < after.length - head &&
    before[before.length - 1 - tailLength] === after[after.length - 1 - tailLength]
  ) {
    tailLength += 1;
  }
  const removed = before.slice(head, before.length - tailLength);
  const added = after.slice(head, after.length - tailLength);
  return { text: [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n"), added: added.length, removed: removed.length };
}

function editDiff(input: Json | undefined): LineDiff | undefined {
  const oldText = str(input?.["old_string"]);
  const newText = str(input?.["new_string"]);
  return oldText !== undefined && newText !== undefined ? lineDiff(oldText, newText) : undefined;
}

export function toolInputPreview(name: string, input: Json): Preview {
  const command = str(input["command"]);
  if (name === "pwsh" && command !== undefined) return inputPreview(command, "text");
  const content = str(input["content"]);
  if (name === "write" && content !== undefined) return inputPreview(content, "text");
  if (name === "edit") {
    const diff = editDiff(input);
    if (diff) return inputPreview(diff.text, "diff");
  }
  return inputPreview(input);
}

/** 工具开始：返回要记住的跟踪信息和要发出的更新。没有调用标识的更新没法与结束事件对上，直接忽略。 */
export function startTool(raw: Json, cwd: string, at: string): { track: ToolTrack; update: ToolUpdate } | undefined {
  const callId = str(raw["toolCallId"]);
  if (!callId) return undefined;
  const name = str(raw["title"]) ?? "tool";
  const input = asRecord(raw["rawInput"]);
  const category = dshToolCategory(name);
  const track: ToolTrack = { callId, name, category, input, startedAt: at };
  const update: ToolUpdate = {
    callId,
    name,
    category,
    title: toolTitle(name, input, cwd),
    status: "running",
    startedAt: at,
    ...(input ? { input: toolInputPreview(name, input) } : {}),
  };
  return { track, update };
}

/** 工具结果文本：把 content 里每段文字拼起来。 */
export function resultText(content: unknown): string {
  const parts: string[] = [];
  for (const entry of arr(content) ?? []) {
    const record = asRecord(entry);
    const text = str(asRecord(record?.["content"])?.["text"]) ?? str(record?.["text"]);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

const EXIT_CODE = /\[exit code: (-?\d+)\]\s*$/;

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** 成功的 write / edit 对应的文件变更；用别的方式（例如 pwsh 里重定向）写的文件看不到。 */
function fileChangesOf(track: ToolTrack, text: string, cwd: string): FileChange[] {
  const path = str(track.input?.["file_path"]);
  if (!path) return [];
  const display = displayPath(cwd, path);
  if (track.name === "write") {
    const content = str(track.input?.["content"]);
    // 结果里写明 Created file / Updated file；覆盖已有文件时拿不到旧内容，所以不报行数。
    const created = /\bCreated file\b/.test(text);
    return [{ path: display, change: created ? "created" : "modified", ...(created && content !== undefined ? { addedLines: countLines(content) } : {}) }];
  }
  if (track.name === "edit") {
    const diff = editDiff(track.input);
    // replace_all 会改多处，只凭参数算不出总行数。
    if (!diff || track.input?.["replace_all"] === true) return [{ path: display, change: "modified" }];
    return [
      {
        path: display,
        change: "modified",
        addedLines: diff.added,
        removedLines: diff.removed,
        diff: { ...inputPreview(diff.text, "diff"), format: "diff" },
      },
    ];
  }
  return [];
}

const PLAN_STATUS: Record<string, PlanEntry["status"]> = { pending: "pending", in_progress: "in_progress", completed: "completed" };

/** todo_write 的参数就是完整的待办清单（替换之前的）。 */
export function planOf(input: Json | undefined): PlanEntry[] | undefined {
  const todos = arr(input?.["todos"]);
  if (!todos) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of todos) {
    const record = asRecord(todo);
    const text = str(record?.["content"]);
    if (!text) continue;
    entries.push({ text, status: PLAN_STATUS[str(record?.["status"]) ?? ""] ?? "pending" });
  }
  return entries;
}

export interface ToolEnd {
  update: ToolUpdate;
  files: FileChange[];
  /** 仅成功的 todo_write 有。 */
  plan: PlanEntry[] | undefined;
}

/** dsh 在取消时给被打断的工具补发的失败文本。 */
const ABORTED = /tool call aborted/i;

/** 工具结束（status 为 completed / failed）。 */
export function endTool(track: ToolTrack, raw: Json, options: { cwd: string; at: string; cancelRequested: boolean }): ToolEnd {
  const text = resultText(raw["content"]);
  let status: ToolStatus = str(raw["status"]) === "failed" ? "failed" : "completed";
  let error: string | undefined;
  let exitCode: number | undefined;

  if (track.name === "pwsh") {
    const match = EXIT_CODE.exec(text);
    if (match?.[1] !== undefined) exitCode = Number(match[1]);
    // 非零退出码 dsh 仍报 completed；与其它适配器一致，记为失败。
    if (exitCode !== undefined && exitCode !== 0 && status === "completed") {
      status = "failed";
      error = `Exit code ${exitCode}`;
    }
  }
  if (status === "failed" && error === undefined) {
    if (options.cancelRequested && ABORTED.test(text)) status = "cancelled";
    else error = clip(firstLine(text).replace(/^Error:\s*/i, ""), 300) || "Tool failed";
  }

  const update: ToolUpdate = {
    callId: track.callId,
    status,
    endedAt: options.at,
    ...(text.length > 0 ? { output: outputPreview(text) } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
  const succeeded = status === "completed";
  return {
    update,
    files: succeeded ? fileChangesOf(track, text, options.cwd) : [],
    plan: succeeded && track.name === "todo_write" ? planOf(track.input) : undefined,
  };
}

/** 工具仍在进行但带了新的输出（dsh 目前不发，协议允许）。 */
export function progressTool(track: ToolTrack, raw: Json): ToolUpdate | undefined {
  const text = resultText(raw["content"]);
  return text.length > 0 ? { callId: track.callId, status: "running", output: outputPreview(text) } : undefined;
}

// ───────────────────────── 用量 / 错误 / 授权 ─────────────────────────

/** dsh 只报上下文占用（used / size），没有输入输出的 token 统计，所以不编造其它字段。 */
export function usageOf(update: Json): Usage | undefined {
  const used = num(update["used"]);
  const size = num(update["size"]);
  if (used === undefined && size === undefined) return undefined;
  return { ...(used !== undefined ? { contextTokens: used } : {}), ...(size !== undefined ? { contextWindow: size } : {}) };
}

/** dsh 把一轮失败写成 `Internal error: turn failed: <正文>`，去掉这两层包装只留正文。 */
export function turnErrorText(reason: string): string {
  return reason.replace(/^Internal error:\s*/i, "").replace(/^turn failed:\s*/i, "").trim();
}

export function turnErrorInfo(error: DshRpcError): ErrorInfo {
  const text = turnErrorText(error.reason);
  return errorInfoFromText(text || error.reason, error.reason);
}

export interface PermissionDecision {
  allow: boolean;
  /** 回给 dsh 的 `session/request_permission` 响应体。 */
  response: Json;
}

/**
 * 授权请求的兜底回复。被委派的会话一律以 DSH_PERMISSION_MODE 启动：Full Access 下 dsh 不会发出这类请求（已实测），
 * 只读下请求出现在“沙箱拒绝后模型申请提权”时。这里不弹窗、不等人：Full Access 放行一次，只读拒绝。
 * 只选“一次性”的选项：*_always 可能被 dsh 记进用户的配置，那不是 Ensemble 该替用户做的决定。
 */
export function permissionDecision(access: AccessLevel, params: Json): PermissionDecision {
  const options = (arr(params["options"]) ?? []).map(asRecord);
  const wanted = access === "full" ? "allow_once" : "reject_once";
  const chosen = options.find((option) => str(option?.["kind"]) === wanted);
  const optionId = str(chosen?.["optionId"]);
  if (optionId === undefined) return { allow: false, response: { outcome: { outcome: "cancelled" } } };
  return { allow: access === "full", response: { outcome: { outcome: "selected", optionId } } };
}

// ───────────────────────── 模型目录 ─────────────────────────

export interface DshModel {
  /** Ensemble 里使用的 id：`provider/model`（没有 provider 信息时只有 model）。 */
  id: string;
  /** dsh 的原始取值（一个 JSON 元组字符串），`session/set_config_option` 要原样回传。 */
  value: string;
  label: string;
  provider: string | undefined;
}

export interface DshCatalog {
  models: DshModel[];
  /** 当前模型的原始取值。 */
  current: string | undefined;
  /** 当前模型可选的推理档位；不支持推理档位的模型没有这个选项，为空数组。 */
  efforts: string[];
  /** 当前推理档位。 */
  effort: string | undefined;
}

function option(configOptions: unknown, id: string): Json | undefined {
  return (arr(configOptions) ?? []).map(asRecord).find((candidate) => str(candidate?.["id"]) === id);
}

/** 模型取值是 `["provider","model"]` 这样的 JSON 元组字符串。 */
function parseTuple(value: string): { provider: string; model: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    const items = arr(parsed);
    const provider = str(items?.[0]);
    const model = str(items?.[1]);
    return provider !== undefined && model !== undefined ? { provider, model } : undefined;
  } catch {
    return undefined;
  }
}

function modelOf(entry: Json, group: string | undefined): DshModel | undefined {
  const value = str(entry["value"]);
  if (value === undefined) return undefined;
  const tuple = parseTuple(value);
  const label = str(entry["name"]) ?? tuple?.model ?? value;
  const provider = tuple?.provider ?? group;
  // id 用 dsh 自己的标识（元组里的模型名；不是元组就用原始取值），不用展示名：展示名会变，还可能带空格。
  const name = tuple?.model ?? value;
  return { id: provider ? `${provider}/${name}` : name, value, label, provider };
}

/** `session/new`、`session/set_config_option` 响应里的 configOptions → 模型目录与推理档位。 */
export function parseCatalog(configOptions: unknown): DshCatalog {
  const model = option(configOptions, "model");
  const models: DshModel[] = [];
  for (const item of arr(model?.["options"]) ?? []) {
    const record = asRecord(item);
    if (!record) continue;
    const nested = arr(record["options"]);
    if (nested) {
      // 分组写法：{ group, name, options: [...] }。
      for (const inner of nested) {
        const parsed = modelOf(asRecord(inner) ?? {}, str(record["group"]));
        if (parsed) models.push(parsed);
      }
    } else {
      const parsed = modelOf(record, undefined);
      if (parsed) models.push(parsed);
    }
  }
  const effortOption = option(configOptions, "reasoning_effort");
  const efforts = (arr(effortOption?.["options"]) ?? [])
    .map((item) => str(asRecord(item)?.["value"]))
    // 空值表示“用提供方的默认”，不是一个可选的档位。
    .filter((value): value is string => value !== undefined && value.length > 0);
  const effort = str(effortOption?.["currentValue"]);
  return {
    models,
    current: str(model?.["currentValue"]),
    efforts,
    effort: effort && effort.length > 0 ? effort : undefined,
  };
}

/** 在目录里找请求的模型：完整 id 或原始取值精确匹配；否则只在名字唯一时按“模型名”匹配（不区分大小写）。 */
export function findModel(models: readonly DshModel[], requested: string): DshModel | undefined {
  const exact = models.find((candidate) => candidate.id === requested || candidate.value === requested);
  if (exact) return exact;
  const lower = requested.toLowerCase();
  const named = models.filter((candidate) => candidate.id.toLowerCase() === lower || candidate.label.toLowerCase() === lower);
  return named.length === 1 ? named[0] : undefined;
}

export function toModelInfo(model: DshModel, detail: { efforts: string[]; effort: string | undefined }, isDefault: boolean): ModelInfo {
  return {
    id: model.id,
    label: model.label,
    ...(model.provider ? { provider: model.provider } : {}),
    ...(detail.efforts.length > 0 ? { efforts: detail.efforts } : {}),
    ...(detail.effort && detail.efforts.includes(detail.effort) ? { defaultEffort: detail.effort } : {}),
    ...(isDefault ? { isDefault: true } : {}),
  };
}
