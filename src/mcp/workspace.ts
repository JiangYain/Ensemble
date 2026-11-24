import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { OriginHost } from "@shared/types";

/** 来源工作目录的长度上限；与 HTTP 校验里 `origin.workspace` 的上限一致（超过就整条委派被拒）。 */
const MAX_WORKSPACE_CHARS = 2_000;

/** 插件清单可能出现的位置（Agent Plugins 以及 Cursor / Claude 的两种兼容目录）。 */
const MANIFESTS = ["plugin.json", join(".cursor-plugin", "plugin.json"), join(".claude-plugin", "plugin.json")];

/**
 * 这个目录是不是宿主安装插件的地方（Codex 的 `plugins/cache/…`、Cursor 的 `plugins/local/…` 等），而不是用户的项目。
 *
 * 宿主没有告知工作区、调用方也没传 `cwd` 时，桥只能退回自己的进程目录；
 * 按 Agent Plugins 约定，插件的 MCP 服务默认就在插件根目录里启动。
 * 把一个可写的子会话放进插件安装目录，既不是用户的意思，也可能改坏已安装的插件，所以这种情况要求显式给出 `cwd`。
 *
 * 判断需要同时满足：路径里有名为 `plugins` 的一段，并且目录里有插件清单。
 * 正在开发插件的项目（路径里没有 `plugins` 段）不会被误伤。
 */
export function isPluginInstallDirectory(dir: string): boolean {
  const absolute = resolve(dir);
  const segments = absolute.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  if (!segments.includes("plugins")) return false;
  return MANIFESTS.some((manifest) => existsSync(join(absolute, manifest)));
}

/**
 * 把目录归成可比较的键：统一分隔符与末尾斜杠，Windows 与 macOS 上不区分大小写。只做字符串处理，不访问磁盘。
 * 用来判断一个来源名下的会话是不是在同一个目录里干活。
 */
export function directoryKey(dir: string): string {
  const absolute = resolve(dir);
  return process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
}

/**
 * 这个目录是不是“用户主目录或磁盘根目录”：它不可能是一个具体的项目，只可能是某个宿主启动插件时的默认位置
 * （Cursor 起 stdio MCP 服务时的工作目录默认就是用户主目录，除非服务配置里写了 cwd；Ensemble 的插件配置没有写）。
 * 宿主没有报告工作区、调用方也没传 `cwd` 时，桥只能退回自己的进程目录；把一个 Full Access 的会话悄悄放进这里，
 * 既不是用户的意思，也等于让它在整个主目录里动手，所以和插件安装目录一样，要求显式给出 `cwd`。
 * 真的在主目录里干活的人显式传 `cwd` 即可。`home` 只为测试可注入，默认是当前用户的主目录。
 */
export function isHomeOrRootDirectory(dir: string, home: string = homedir()): boolean {
  const key = directoryKey(dir);
  return key === directoryKey(home) || key === directoryKey(parse(resolve(dir)).root);
}

/**
 * 宿主通过 MCP roots 报告的目录，能不能当作“调用者这段对话的工作区”。
 *
 * Cursor 不能：它把 MCP 服务放在一个按用户配置（profile）共享的独立进程里，所有窗口、所有对话共用同一个桥；
 * 它对 `roots/list` 的应答是“所有活动 MCP 服务所属项目目录的并集”（2026-11-21 核对 Cursor 打包源码里 McpProcess 的 `getWorkspaceFolders`；
 * 日志里每次首次委派的条目数是 3、2、1……，随当时开着的窗口变），哪一项是调用者的，桥没有办法知道。
 * 目前 Cursor 应答里的 `uri` 是普通路径而不是 `file://`，被 MCP SDK 的校验挡掉，所以实际上从来读不到；
 * 这里把“即使将来读得到也不信”写死，免得有一天它悄悄变成把别的窗口的项目认成来源工作区的来源。
 * 其余宿主（Codex、Claude Code、Pi 等每个会话各起一个桥进程）的 roots 照旧采信，行为不变。
 */
export function hostRootsIdentifyConversation(host: OriginHost): boolean {
  return host !== "cursor";
}

/**
 * 宿主自己交出的目录（例如 Cursor 记在对话上的工作区）能不能当作来源的工作区：必须是本机的绝对路径，写法与 `cwd` 一致。
 * 只做字符串处理，不访问磁盘；不合格返回 undefined。
 * - Windows：只认带盘符或 UNC 的写法，分隔符统一成反斜杠；盘符统一成大写——VS Code 系的 `fsPath` 习惯小写盘符（`c:\…`），
 *   而 Agent 传的 `cwd` 与系统各处显示的是 `C:\…`，来源卡上两处不该因为一个字母大小写看起来是两个目录。
 * - 去掉末尾的分隔符与 `.` / `..` 段（`resolve` 的结果）。
 * - 超过 HTTP 校验上限、含空字符的不要：不能让一条宿主给的路径把整条委派拖垮。
 */
export function normalizeHostDirectory(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_WORKSPACE_CHARS || raw.includes("\0")) return undefined;
  if (!isAbsolute(raw)) return undefined;
  if (process.platform === "win32" && !/^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(raw)) return undefined;
  const resolved = resolve(raw);
  const normalized = process.platform === "win32" ? resolved.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : resolved;
  return normalized.length <= MAX_WORKSPACE_CHARS ? normalized : undefined;
}

/**
 * `roots/list` 的应答没通过 MCP SDK 校验时，从校验错误里只取排查需要的两个数：有几项没通过、其中几项的 `uri` 不是 `file://` 开头。
 * 不记任何路径内容。SDK 校验失败时不交出原始应答，所以“像不像普通路径”只能说到“不是 file://”这一步；
 * 条数只数没通过校验的那些（Cursor 的应答是整份都没通过，此时就是总数）。认不出错误的形状就返回空对象。
 */
export function describeRootsFailure(error: unknown): { invalidEntries?: number; notFileUri?: number } {
  const issues = typeof error === "object" && error !== null ? (error as { issues?: unknown }).issues : undefined;
  if (!Array.isArray(issues)) return {};
  const entries = new Set<number>();
  let notFileUri = 0;
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;
    const { path, code, format, prefix } = issue as { path?: unknown; code?: unknown; format?: unknown; prefix?: unknown };
    if (Array.isArray(path) && path[0] === "roots" && typeof path[1] === "number") entries.add(path[1]);
    if (code === "invalid_format" && format === "starts_with" && prefix === "file://") notFileUri += 1;
  }
  return { ...(entries.size > 0 ? { invalidEntries: entries.size } : {}), ...(notFileUri > 0 ? { notFileUri } : {}) };
}
