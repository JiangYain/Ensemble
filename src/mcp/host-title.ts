import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clip, collapseWhitespace } from "@shared/format";
import type { Origin } from "@shared/types";
import { normalizeHostDirectory } from "./workspace";

/**
 * 宿主给这段对话起的标题——卡片上“Main Agent 在做什么”的那一行。
 *
 * 只读宿主自己写在本机、早已存在的标题；读不到就不写，Ensemble 不生成、不猜测。已核对过的来源：
 * - Codex：`<CODEX_HOME 或 ~/.codex>/session_index.jsonl`，每个线程一行 `{ id, thread_name, updated_at }`，同一线程改名会追加新行，以最后一行为准。
 * - Cursor：`state.vscdb`（SQLite，WAL 模式）里的 `composerHeaders` 表，按对话 ID 取 `name`。没起名的对话 `name` 为空。
 * - Claude Code（2026-11-14，2.1.325 与 Claude Desktop 的真实记录）：`<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<工作目录>/<会话 ID>.jsonl`
 *   里的 `{ type: "custom-title", customTitle, sessionId }` 行，值恒定、会被周期性重写，以最后一行为准。`claude --name` 起的名字同样写成这种行。
 *   会话 ID 来自环境变量 CLAUDE_CODE_SESSION_ID（见 origin.ts），所以是精确匹配。没核对到的：交互界面里 `/rename` 是否也写这种行。
 * - Pi（2026-11-14，1.5.2）：`<PI_CODING_AGENT_DIR 或 ~/.pi/agent>/sessions/--<工作目录>--/<时间>_<会话 ID>.jsonl` 里的
 *   `{ type: "session_info", name }` 行（`pi --name`、`/name` 写入），以最后一行为准。没起过名的会话没有这一行，和 Cursor 一样不显示。
 *   和前三个不同，Pi 没有把会话标识交给 MCP 进程（环境变量与 `_meta` 都没有），所以这里**不能精确匹配**，
 *   只能按工作目录找该目录下最近写过的会话文件，并且在下面这几种情况下宁可不显示：
 *   最近 5 分钟内没有写过、有另一个会话在 2 分钟内也写过、文件头里的 cwd 与工作目录不一致（目录名会撞：`a\b-c` 与 `a-b\c`）。
 *   仍然可能认错的情形：同一目录下另一个 Pi 会话恰好在“本会话最后一次落盘”之后、“桥读文件”之前写了盘，
 *   而本会话在此之前已安静超过 2 分钟（例如一个很长的 codemode 脚本跑完才委派）。只认默认的会话目录布局，自定义 sessionDir 时读不到。
 * 其他宿主（VS Code 等）没有核对过，不读。
 *
 * Agent 自报的会话标识（`sessionRef.source === "declared"`，见 origin.ts）：宿主没有交出标识时，Agent 通过工具参数 `conversationId` 报上来的，
 * Ensemble 没法核对。只有 Cursor 照常读，其余宿主一律不读：Codex 与 Claude Code 本来就会把标识交给 MCP 进程，自报的用不上，
 * 也没有核对过自报的标识对它们是否成立；Pi 不看标识。Cursor 只把它当作 SQL 的绑定参数，只读地查一行 `name`。
 * 2026-11-17 在这台机器上只读地核对过：拿用户给出的一个 Cursor 对话 UUID 去查 `composerHeaders.composerId`，命中一行，`name` 有值
 * （只核对了这一个对话，样本很小；“Agent 上下文里看到的对话 UUID 就是 composerId”这个对应关系也只有这一个例子。
 * Cursor 日后改变存法、或 Agent 报的不是这个 UUID 时，查不到就不显示标题）。
 * 自报错了（例如报成了另一个对话的 UUID）时，显示的就是那个对话的标题——这和“标识由 Agent 自报”一样，页面上有如实的标注。
 *
 * 为什么不读“最近一条 Prompt”：Cursor 要等一轮结束才把对话记录写盘，委派发生在一轮中途时，
 * 文件里最新的那条是上一轮的，显示出来会误导。
 *
 * 工作区（2026-11-21，`readHostRecord`）：Cursor 的 IDE 把所有对话共用的桥进程从用户主目录拉起，roots/list 又读不出来、
 * 宿主不交出对话标识，来源卡的工作区只能靠 Agent 每次传 `cwd`。但 `composerHeaders` 同一行里还记着这段对话所在的工作区：
 * `workspaceIdentifier`，单目录工作区时形如 `{ id, uri: { scheme: "file", fsPath: "c:\\…", external: "file:///c%3A/…" } }`。
 * 在这台机器上只读地核对过（只取这一个字段的形状，没有看对话内容）：全表 1205 行都有这个字段；776 行带 `uri`
 * （770 个 `file`、6 个 `vscode-remote`——后者的 `fsPath` 是远端机器上的路径，不能当本机目录），429 行只有 `id`（没有目录可取：
 * 空窗口一类；`.code-workspace` 的多根工作区多半也是这种形状，没有核对到）；`fsPath` 的盘符一律是小写。
 * 取目录的规则：必须是 `file` 方案、能还原成本机的绝对路径（`fsPath` 不行再试 `external` 的 file URL），其余一律当作没有；盘符大小写统一成与 `cwd` 一致（见 workspace.ts）。
 * 只在已经有对话标识时才查（宿主交出的，或 Agent 自报的）：没有标识就不猜，更不按“最近更新的对话”去猜——
 * 所以 Agent 没传 `conversationId` 时这一条不起作用，来源卡的工作区仍取这次显式传入的 `cwd`。
 * 自报的标识可能抄成别的对话的（见上面的说明），那样读到的就是那个对话的工作区；页面上标识旁有“由 Agent 自报”的注。
 * 取到的目录只作来源（Main Agent）的工作区，用来在卡片上说“这段对话在哪个项目里”，不拿来决定被委派的会话在哪个目录干活——
 * 那一步只认显式的 `cwd`（或宿主 roots），因为自报的标识没法核对，而被委派的会话是 Full Access。
 * 这是 Cursor 自己的内部存法，不是公开接口：样本只来自这一台机器、这一版 Cursor；格式变了就读不到，读不到就不写。
 * 一次只读打开里顺带取，不为目录单开一次库，也不记整行内容。
 *
 * 任何失败（文件不存在、格式变了、库被占用）都返回空结果，不影响委派本身。
 */

const MAX_TITLE_CHARS = 120;

/** 小于这个大小就整份读（真实的 Pi 会话到过 20 MB）；更大的只读开头与结尾两段。 */
const FULL_READ_LIMIT = 64 * 1024 * 1024;
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 8 * 1024 * 1024;

/** Pi：最新的会话文件必须是这么久之内写过的，否则没法说它就是正在调用的这个会话。 */
const PI_MAX_AGE_MS = 5 * 60_000;
/** Pi：次新的会话文件与最新的相差不到这么久，就认为分不清是哪一个。 */
const PI_AMBIGUOUS_MS = 2 * 60_000;

export interface HostTitleOptions {
  env: NodeJS.ProcessEnv;
  /** 宿主的工作目录。Pi 没有交出会话标识，只能靠它定位会话；缺省取 origin.workspace（调用方交给这里的来源通常还没有它）。 */
  workspace?: string;
  /** 测试用：覆盖 Cursor 的 state.vscdb 路径。 */
  cursorDb?: string;
  /** 测试用：覆盖 Codex 的数据目录。 */
  codexHome?: string;
  /** 测试用：覆盖 Claude Code 的数据目录（其下有 projects）。 */
  claudeHome?: string;
  /** 测试用：覆盖 Pi 的数据目录（其下有 sessions）。 */
  piHome?: string;
}

/** 宿主为这段对话留在本机的记录里，Ensemble 读得到的部分。读不到的项不出现，绝不由 Ensemble 生成或猜测。 */
export interface HostRecord {
  /** 宿主给这段对话起的标题。 */
  title?: string;
  /** 宿主记录的这段对话所在的工作区：本机的绝对目录，写法与 `cwd` 一致。目前只有 Cursor 读得到（见文件头的说明）。 */
  workspace?: string;
}

export async function readHostRecord(origin: Origin, options: HostTitleOptions): Promise<HostRecord> {
  const id = origin.sessionRef?.id;
  // 自报的标识只用于 Cursor（见上面的说明）。
  const hostGiven = origin.sessionRef?.source !== "declared";
  try {
    let raw: string | undefined;
    let workspace: string | undefined;
    switch (origin.host) {
      case "codex":
        raw = id && hostGiven ? await codexTitle(id, options) : undefined;
        break;
      case "cursor": {
        // 标题与工作区在同一行里，一次只读打开一起取。
        const record = id ? await cursorRecord(id, options) : undefined;
        raw = record?.name;
        workspace = record?.workspace;
        break;
      }
      case "claude":
        raw = id && hostGiven ? await claudeTitle(id, options) : undefined;
        break;
      case "pi":
        // Pi 不交出会话标识，所以这里不看 id，靠工作目录定位。
        raw = await piTitle(options.workspace ?? origin.workspace, options);
        break;
      default:
        raw = undefined;
    }
    const title = tidy(raw);
    return { ...(title ? { title } : {}), ...(workspace ? { workspace } : {}) };
  } catch {
    return {};
  }
}

export async function readHostTitle(origin: Origin, options: HostTitleOptions): Promise<string | undefined> {
  return (await readHostRecord(origin, options)).title;
}

function tidy(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = collapseWhitespace(raw);
  return text.length > 0 ? clip(text, MAX_TITLE_CHARS) : undefined;
}

async function codexTitle(threadId: string, options: HostTitleOptions): Promise<string | undefined> {
  const home = options.codexHome ?? options.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const text = await readFile(join(home, "session_index.jsonl"), "utf8");
  if (!text.includes(threadId)) return undefined;
  let title: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes(threadId)) continue;
    try {
      const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (entry.id === threadId && typeof entry.thread_name === "string") title = entry.thread_name;
    } catch {
      // 半行或损坏的行跳过。
    }
  }
  return title;
}

/**
 * 读一份会话记录。普通大小整份读；超大的只读开头与结尾两段——被截断的行解析不了，会被调用方当作损坏行跳过，
 * 取舍只是可能漏掉夹在中间、更早的标题改动。文件不存在时返回 undefined。
 */
async function readSessionFile(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    if (size <= FULL_READ_LIMIT) return await handle.readFile("utf8");
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    const headRead = await handle.read(head, 0, HEAD_BYTES, 0);
    const tailRead = await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return `${head.subarray(0, headRead.bytesRead).toString("utf8")}\n${tail.subarray(0, tailRead.bytesRead).toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function claudeTitle(sessionId: string, options: HostTitleOptions): Promise<string | undefined> {
  // 会话 ID 要拼进文件名：只认 UUID（Claude Code 的会话 ID 就是 UUID），不让环境变量里的内容带路径出去。
  if (!UUID.test(sessionId)) return undefined;
  const projects = join(options.claudeHome ?? options.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const text = await readSessionFile(join(projects, entry.name, `${sessionId}.jsonl`));
    if (text === undefined) continue;
    let title: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.includes('"custom-title"')) continue;
      try {
        const row = JSON.parse(line) as { type?: unknown; customTitle?: unknown; sessionId?: unknown };
        if (row.type === "custom-title" && row.sessionId === sessionId && typeof row.customTitle === "string") title = row.customTitle;
      } catch {
        // 半行或损坏的行跳过。
      }
    }
    return title;
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function piTitle(workspace: string | undefined, options: HostTitleOptions): Promise<string | undefined> {
  if (!workspace) return undefined;
  const cwd = resolve(workspace);
  // 目录名的编码规则取自 Pi 源码（session-manager.js 的 getDefaultSessionDirPath），并已在本机 35 个真实会话上逐个核对。
  const dir = join(
    options.piHome ?? options.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent"),
    "sessions",
    `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  const files = await Promise.all(
    (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => ({ path: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs })),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  const [newest, runnerUp] = files;
  if (!newest || Date.now() - newest.mtime > PI_MAX_AGE_MS) return undefined;
  if (runnerUp && newest.mtime - runnerUp.mtime < PI_AMBIGUOUS_MS) return undefined;

  const text = await readSessionFile(newest.path);
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  // 文件头里记着真实的 cwd：目录名的编码会撞，不一致就不是这个工作目录的会话。
  const header = JSON.parse(lines[0] ?? "") as { type?: unknown; cwd?: unknown };
  if (header.type !== "session" || typeof header.cwd !== "string" || !samePath(resolve(header.cwd), cwd)) return undefined;
  let name: string | undefined;
  for (const line of lines) {
    if (!line.includes('"session_info"')) continue;
    try {
      const row = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (row.type === "session_info" && typeof row.name === "string") name = row.name;
    } catch {
      // 半行或损坏的行跳过。
    }
  }
  return name;
}

function cursorDbPath(env: NodeJS.ProcessEnv): string {
  const tail = ["Cursor", "User", "globalStorage", "state.vscdb"];
  if (process.platform === "win32") return join(env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), ...tail);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", ...tail);
  return join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), ...tail);
}

interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean; timeout: number }) => {
    prepare(sql: string): { get(...params: string[]): Record<string, unknown> | undefined };
    close(): void;
  };
}

/**
 * node:sqlite 在 Node 22 里还标着“实验性”，第一次加载会向 stderr 打一条警告；桥进程的 stderr 会进宿主的 MCP 日志，
 * 只在加载这一刻把这一条已知警告拦下，其余警告原样放行。
 */
async function loadSqlite(): Promise<SqliteModule> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/sqlite/i.test(text)) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return (await import(/* @vite-ignore */ "node:sqlite")) as unknown as SqliteModule;
  } finally {
    process.emitWarning = emit;
  }
}

interface CursorRecord {
  name: string | undefined;
  workspace: string | undefined;
}

/**
 * 把 Cursor 记在对话上的工作区还原成本机的绝对目录。要求 `file` 方案（远程工作区 `vscode-remote` 等的 `fsPath` 是远端机器上的路径）；
 * 方案缺失时只在 `external` 本身是 file URL 时才认。`fsPath` 不合格再试 `external`；都不行就是没有（只有 `id` 的空窗口、多根工作区等）。
 */
function cursorFolder(scheme: unknown, fsPath: unknown, external: unknown): string | undefined {
  const fileUrl = typeof external === "string" && external.startsWith("file:") ? external : undefined;
  if (scheme !== "file" && !(scheme == null && fileUrl)) return undefined;
  const direct = normalizeHostDirectory(fsPath);
  if (direct) return direct;
  if (!fileUrl) return undefined;
  try {
    return normalizeHostDirectory(fileURLToPath(fileUrl));
  } catch {
    return undefined;
  }
}

async function cursorRecord(conversationId: string, options: HostTitleOptions): Promise<CursorRecord> {
  const { DatabaseSync } = await loadSqlite();
  // 只读打开，且只按主键取几个标量字段（标题，以及对话所在工作区的方案与目录）：不碰对话正文，也不会阻塞 Cursor 自己的写入。
  const db = new DatabaseSync(options.cursorDb ?? cursorDbPath(options.env), { readOnly: true, timeout: 1500 });
  try {
    const row = db
      .prepare(
        "SELECT json_extract(h, '$.name') AS name, " +
          "json_extract(h, '$.workspaceIdentifier.uri.scheme') AS scheme, " +
          "json_extract(h, '$.workspaceIdentifier.uri.fsPath') AS fsPath, " +
          "json_extract(h, '$.workspaceIdentifier.uri.external') AS external " +
          "FROM (SELECT CAST(value AS TEXT) AS h FROM composerHeaders WHERE composerId = ?)",
      )
      .get(conversationId);
    return {
      name: typeof row?.["name"] === "string" ? row["name"] : undefined,
      workspace: cursorFolder(row?.["scheme"], row?.["fsPath"], row?.["external"]),
    };
  } finally {
    db.close();
  }
}
