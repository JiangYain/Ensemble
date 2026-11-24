import { sliceHead } from "@shared/safe-slice";
import type { Origin, OriginHost, SessionRef, WorkspaceSource } from "@shared/types";

/**
 * 发起端识别：会话标识只使用宿主在 MCP 协议里真实给出的线索（clientInfo、请求的 _meta、进程环境变量），
 * 或者 Agent 通过工具参数 `conversationId` 明确自报的标识（来源标为 declared，见下），找不到就不写，绝不编造。
 * 识别依据会随来源一起保存；会话标识的来源（宿主给的 / Agent 自报的）如实展示在页面上。
 */

export interface OriginInput {
  clientInfo?: { name: string; version?: string | undefined } | undefined;
  /** tools/call 请求里的 _meta（宿主若提供）。 */
  meta?: Record<string, unknown> | undefined;
  env: NodeJS.ProcessEnv;
  /**
   * 来源的工作目录与它的来源：只给有出处的——宿主对这段对话的记录、宿主报告的 roots、或这次委派显式传入的 cwd，
   * 不要拿桥进程的启动目录凑数。没有就不给，页面上显示“未知”。
   */
  workspace?: string | undefined;
  workspaceSource?: WorkspaceSource | undefined;
  /** 桥进程自己的随机标识：宿主没有给出会话标识时，用它保证“一个桥进程 = 一个发起端”。 */
  bridgeId: string;
  /** 之前的调用里已经识别到的线索；宿主可能只在部分请求里带 _meta。 */
  sticky?: StickyClues | undefined;
  /**
   * Agent 在这次工具调用里通过参数 `conversationId` 自报的对话标识（Cursor IDE 的所有对话共用一个桥进程，
   * 宿主不告诉桥当前是哪一个对话，只有 Agent 自己知道）。
   * 只在宿主没有给出任何标识（`_meta`、环境变量都没有）时才采用：宿主给的永远优先。
   * 每次调用各自决定，既不读 sticky，也不写 sticky——桥是共用的，上一次见到的标识不能代表这一次的对话。
   */
  declaredConversationId?: string | undefined;
}

/** 只含宿主真实给出的线索：自报的标识不进来，否则一个桥上的第二个对话会被误当成“同一个会话换了标识”。 */
export interface StickyClues {
  host?: OriginHost;
  sessionRef?: SessionRef;
}

export interface DetectedOrigin {
  origin: Origin;
  /** 本次识别到的线索，调用方可保存下来供后续请求复用。 */
  clues: StickyClues;
}

const HOSTS: { pattern: RegExp; host: OriginHost; label: string }[] = [
  { pattern: /codex/i, host: "codex", label: "Codex" },
  { pattern: /cursor/i, host: "cursor", label: "Cursor" },
  { pattern: /claude/i, host: "claude", label: "Claude" },
  { pattern: /(^|[^a-z])pi([^a-z]|$)|pi-coding|pi-mono/i, host: "pi", label: "Pi" },
  { pattern: /vscode|visual studio code|copilot/i, host: "vscode", label: "VS Code" },
];

const HOST_LABELS: Record<OriginHost, string> = {
  codex: "Codex",
  cursor: "Cursor",
  claude: "Claude",
  pi: "Pi",
  vscode: "VS Code",
  console: "Ensemble",
  unknown: "MCP client",
};

/**
 * 已知宿主可能设置的环境变量；是否真的存在以运行时为准（见 describeClues 的排查日志）。
 *
 * CLAUDE_CODE_SESSION_ID 于 2026-11-14 在 Claude Code 2.1.325 上实测：交给 MCP 进程的环境里有它，
 * 值等于 claude 自己报告的 session_id，也等于 ~/.claude/projects 下记录文件的文件名。
 * 同一次实测里 Pi 1.5.2 交给 MCP 进程的环境没有任何会话标识（PI_SESSION_ID 只给它的 shell 工具），
 * 所以 Pi 没有对应的一行。
 */
const ENV_HINTS: { name: string; host: OriginHost; kind: SessionRef["kind"] }[] = [
  { name: "CODEX_THREAD_ID", host: "codex", kind: "thread" },
  { name: "CODEX_SESSION_ID", host: "codex", kind: "session" },
  { name: "CURSOR_CONVERSATION_ID", host: "cursor", kind: "conversation" },
  { name: "CURSOR_SESSION_ID", host: "cursor", kind: "session" },
  { name: "CLAUDE_CODE_SESSION_ID", host: "claude", kind: "session" },
];

const ID_KEY = /^(?:x-)?(?:(codex|cursor|claude)[-_.]?)?(session|thread|conversation)[-_.]?id$/i;
/** 宿主把一整段元数据放在一个键里（例如 Codex 的 x-codex-turn-metadata），值可能是对象或 JSON 字符串。 */
const CONTAINER_KEY = /metadata$/i;

function classifyClient(name: string | undefined): { host: OriginHost; label: string } | undefined {
  if (!name) return undefined;
  for (const entry of HOSTS) if (entry.pattern.test(name)) return { host: entry.host, label: entry.label };
  return undefined;
}

function kindOf(word: string): SessionRef["kind"] {
  const lower = word.toLowerCase();
  return lower === "thread" ? "thread" : lower === "conversation" ? "conversation" : "session";
}

/** 对象本身，或者能解析成对象的 JSON 字符串（宿主有时把 _meta 序列化成字符串传来）。 */
function objectOrJson(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 会话标识的长度上限；与 HTTP 校验里 sessionRef.id 的上限一致。 */
export const SESSION_ID_MAX_CHARS = 200;

/** 会话标识：非空、不超长、不含空白。宿主给的、环境变量里的、Agent 自报的都用同一个标准。 */
export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SESSION_ID_MAX_CHARS && !/\s/.test(value);
}

interface MetaClue {
  ref: SessionRef;
  host?: OriginHost;
  via: string;
}

const HOST_WORD = /(codex|cursor|claude)/i;

function scan(record: Record<string, unknown>, path: string, depth: number, out: MetaClue[], hostHint?: OriginHost): void {
  for (const [key, value] of Object.entries(record)) {
    const match = ID_KEY.exec(key);
    if (match && validId(value)) {
      const host = (match[1]?.toLowerCase() as OriginHost | undefined) ?? hostHint;
      out.push({
        ref: { id: value, kind: kindOf(match[2] ?? "session"), source: "mcp-meta" },
        ...(host ? { host } : {}),
        via: `${path}${key}`,
      });
      continue;
    }
    if (depth > 0 && (CONTAINER_KEY.test(key) || (value && typeof value === "object"))) {
      const nested = objectOrJson(value);
      // 容器键名里带宿主名（x-codex-turn-metadata），里面的标识就属于那个宿主。
      const nestedHost = (HOST_WORD.exec(key)?.[1]?.toLowerCase() as OriginHost | undefined) ?? hostHint;
      if (nested) scan(nested, `${path}${key}.`, depth - 1, out, nestedHost);
    }
  }
}

function fromMeta(meta: Record<string, unknown> | undefined): MetaClue | undefined {
  if (!meta) return undefined;
  const found: MetaClue[] = [];
  scan(meta, "_meta.", 2, found);
  // 优先 session，其次 thread / conversation：不同宿主对“会话”的称呼不同，但同一请求里通常只有一个。
  const rank = (clue: MetaClue): number => (clue.ref.kind === "session" ? 0 : clue.ref.kind === "thread" ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b))[0];
}

export function detectOrigin(input: OriginInput): DetectedOrigin {
  const evidence: string[] = [];
  let host: OriginHost | undefined;
  let label: string | undefined;

  const client = classifyClient(input.clientInfo?.name);
  if (client) {
    host = client.host;
    label = client.label;
    evidence.push(`clientInfo:${input.clientInfo?.name}`);
  } else if (input.clientInfo?.name) {
    evidence.push(`clientInfo:${input.clientInfo.name}`);
  }

  let sessionRef: SessionRef | undefined;
  const metaClue = fromMeta(input.meta);
  if (metaClue) {
    sessionRef = metaClue.ref;
    evidence.push(metaClue.via);
    if (!host && metaClue.host) host = metaClue.host;
  }

  if (!sessionRef) {
    for (const hint of ENV_HINTS) {
      // 已经知道宿主是谁时，只认这个宿主自己的变量：在 Cursor 终端里启动的 Claude Code 同样继承着
      // CURSOR_CONVERSATION_ID，那不是 Claude 的会话（2026-11-14 实测探针的环境里两者并存）。
      if (host && hint.host !== host) continue;
      const value = input.env[hint.name];
      if (validId(value)) {
        sessionRef = { id: value, kind: hint.kind, source: "env" };
        evidence.push(`env:${hint.name}`);
        if (!host) host = hint.host;
        break;
      }
    }
  }

  // 宿主什么标识都没给时，Agent 自报的对话标识补上这一层，排在桥内 sticky 之前：
  // sticky 是“这个桥上一次见到的宿主标识”，桥被多个对话共用时它属于别人；自报的则是这次调用自己带来的。
  let declared = false;
  if (!sessionRef && validId(input.declaredConversationId)) {
    sessionRef = { id: input.declaredConversationId, kind: "conversation", source: "declared" };
    evidence.push("declared:conversationId");
    declared = true;
  }

  if (!sessionRef && input.sticky?.sessionRef) {
    sessionRef = input.sticky.sessionRef;
    evidence.push("earlier-call");
  }
  host ??= input.sticky?.host;

  const resolvedHost: OriginHost = host ?? "unknown";
  const hostLabel = label ?? (resolvedHost === "unknown" ? (input.clientInfo?.name ?? HOST_LABELS.unknown) : HOST_LABELS[resolvedHost]);

  const origin: Origin = {
    key: `${resolvedHost}:${sessionRef ? sessionRef.id : `bridge-${input.bridgeId}`}`,
    kind: "agent",
    host: resolvedHost,
    hostLabel: sliceHead(hostLabel, 80),
    ...(sessionRef ? { sessionRef } : {}),
    ...(input.clientInfo ? { clientInfo: { name: sliceHead(input.clientInfo.name, 200), ...(input.clientInfo.version ? { version: sliceHead(input.clientInfo.version, 100) } : {}) } } : {}),
    ...(input.workspace ? { workspace: input.workspace, ...(input.workspaceSource ? { workspaceSource: input.workspaceSource } : {}) } : {}),
    evidence: evidence.slice(0, 20),
  };

  return { origin, clues: { ...(host ? { host } : {}), ...(sessionRef && !declared ? { sessionRef } : {}) } };
}

const SECRET_KEY = /token|secret|key|password|authorization|cookie|credential/i;

function redact(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return depth > 3 ? "[…]" : value.slice(0, 10).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 3) return "[…]";
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.length > 120 ? `${sliceHead(value, 117)}…` : value;
  return value;
}

/**
 * Cursor 起 MCP 服务时往它的环境里注入 `WORKSPACE_FOLDER_PATHS`（逗号拼接的目录，是“所有活动 MCP 服务所属项目目录的并集”在启动那一刻的快照，
 * 不是调用者这个窗口的目录；2026-11-21 核对 Cursor 打包源码）。名字不匹配上面 envNames 的过滤，所以单独记：只记有没有、几项，不记路径。
 */
function folderPathsClue(value: string | undefined): { entries: number } | null {
  if (!value) return null;
  return { entries: value.split(",").filter((item) => item.trim().length > 0).length };
}

/**
 * 供排查的线索快照：宿主到底给了什么。环境变量只记名称不记值，_meta 里疑似凭据的字段会被抹掉。
 * 写入 origin-debug.jsonl，帮助发现各宿主真实的会话标识位置。
 */
export function describeClues(input: Pick<OriginInput, "clientInfo" | "meta" | "env" | "declaredConversationId">): Record<string, unknown> {
  const envNames = Object.keys(input.env)
    .filter((name) => /codex|cursor|claude|session|thread|conversation|agent|mcp|vscode/i.test(name))
    .sort();
  return {
    clientInfo: input.clientInfo ?? null,
    meta: input.meta ? redact(input.meta) : null,
    envNames,
    // 只用来排查：桥的环境里有没有它、有几项。它是跨窗口的并集，从不当作来源工作区的依据。
    workspaceFolderPaths: folderPathsClue(input.env["WORKSPACE_FOLDER_PATHS"]),
    // Agent 自报的对话标识（不是宿主线索）；只记有没有、是什么，方便核对它有没有在每次调用里被带上。
    declaredConversationId: validId(input.declaredConversationId) ? input.declaredConversationId : null,
  };
}
