#!/usr/bin/env node
/**
 * Ensemble 会话看门狗（随插件分发：skills/ensemble-delegate/scripts/watch.mjs）。
 *
 * 主 Agent 派发会话之后在后台运行它：每隔一会儿向本机的 Ensemble 服务读一遍会话，只在有事发生时输出一行，
 * 让宿主把你叫回来，不必靠反复调用 `wait` / `status` 轮询。
 *
 *   [ALERT] 值得现在看一眼：一条有事件依据的事实，不是“卡住了”的判决
 *   [DONE]  被盯的会话结束了，该去 `read` 取结果
 *   [INFO]  知道就好，不必反应
 *   [TICK]  周期小结，不需要反应（配置通知时把它排除在外）
 *   [WAKE]  只在 --wake 下出现：退出前的最后一行，写明有几个结束、几个需要看一眼
 *
 * 叫醒主 Agent 的两种方式：
 *  - `--wake`（首选，整台机器只起一个）：宿主只在后台命令**退出**时才会叫醒空闲的主 Agent，所以出现第一条
 *    [DONE] 或 [ALERT] 之后，再等一个很短的合并窗口（--wake-batch）把同一时刻到的几条一并打出来，补一行 [WAKE]
 *    摘要，以退出码 10 退出；主 Agent 处理完，用同样的参数重新启动它。两次之间发生的事靠 `--state` 文件接上：
 *    重启后补报退出期间结束的会话，已经说过的不重复，每个会话的事件接着上次读到的位置读。
 *    `--origin` / `--origin-of` 只盯某个 Main Agent 名下的会话（一个服务可能被多个 Main Agent 共用）。
 *  - 不带 `--wake`：命令一直活着、有事打印一行，靠宿主“输出匹配”之类的机制通知；盯着的会话都结束后自己退出。
 *
 * 对服务只读：只发 GET 请求，从不取消、发消息或改动任何会话。它自己唯一会写的是 `--state` 点名的那个状态文件
 * （先写同目录下的临时文件再改名）。
 * 只依赖 Node 内置模块与服务的 HTTP 接口（地址与令牌取自 <ENSEMBLE_HOME>/run/service.json），不读服务的内部文件。
 * 它不是 `wait` 的替代：`wait` 是主 Agent 主动等，这个脚本是让宿主在后台把主 Agent 叫回来。
 *
 * 退出码：0 盯着的会话都结束了（或 --once）；2 参数不对，或点名的会话一个都不存在；3 服务连不上（超过 --gone-after 分钟）；
 * 10 唤醒（--wake）：有会话结束或有事要看，处理完再启动它。
 *
 * 判断来源：
 *  - “值得留意”那几类（静默、工具长时间没动静、运行很久、同一文件被别的会话写过、补充消息迟迟未确认）
 *    直接取服务端算好的 `summary.attention`，口径与 MCP 的 `attention:` 行一致，这里不再算第二遍；
 *  - 需要读事件流才看得出的几类：连续失败、同一调用反复出现、文件冲突类报错，以及排队过久；
 *  - 项目自己的规矩只在传了 `--rules` 时才检查（见 watch.rules.example.json）。
 * 每条输出都是从服务返回的数据里读出来的事实，没有推测；措辞不下判决，怎么处理由读到的人决定。
 */
import { closeSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ───────────────────────── 常量 ─────────────────────────

const TOKEN_HEADER = "x-ensemble-token";
/** 同一件事持续存在时，隔多久再提醒一次。 */
const REALERT_MS = 12 * 60_000;
/** 连续这么多个工具调用都失败了才提。 */
const FAIL_STREAK = 4;
/** 在最近这么多个已结束的工具调用里……同一个调用出现了至少 LOOP_MIN_REPEATS 次、其中至少 LOOP_MIN_FAILED 次失败。 */
const LOOP_WINDOW = 8;
const LOOP_MIN_REPEATS = 4;
const LOOP_MIN_FAILED = 2;
/** 排队多久、而服务报告还有空闲名额，才值得提。 */
const QUEUED_MS = 25 * 60_000;
/** 开始盯一个会话时往回读多少条事件；其中只有发生在最近 3 分钟内的才会触发规则与冲突提示（更早的事早该有人看过了）。 */
const BACKLOG_EVENTS = 600;
const BACKLOG_FRESH_MS = 3 * 60_000;
/** 待命（ready）的会话安静多久才算“没有东西在跑”：刚创建的那一瞬间也可能短暂处在这个阶段。 */
const READY_GRACE_MS = 2 * 60_000;
/** 一次输出最多这么长；输出会直接进主 Agent 的上下文。 */
const LINE_MAX = 420;
/** --wake：第一条需要反应的输出之后，再等这么久（秒），把同一时刻到的几条一并带上。 */
const WAKE_BATCH_DEFAULT = 3;
/** --wake 以这个退出码退出：有事要处理（宿主据此叫醒主 Agent）。 */
const WAKE_EXIT = 10;
/** 状态文件的格式版本；不认识的版本当作没有这个文件。 */
const STATE_VERSION = 1;
/** 判断“同一个调用反复出现”时，一个调用的指纹（命令或目标）最多取多长。 */
const FINGERPRINT_MAX = 200;
/** 多个 Agent 并行改同一批文件时常见的报错。 */
const CONFLICT_ERRORS = /(ftruncate|EBUSY|EPERM|being used by another process|another process|string to replace not found|old_string.*not found|file has been modified|was modified since|STATUS_SHARING)/i;

const USAGE = `Usage: node watch.mjs [session-id ...] [options]

Watches Ensemble sessions in the background and prints a line only when something needs you:
  [ALERT] worth a look now: a fact with its evidence, never a verdict
  [DONE]  a watched session finished; fetch its result with the \`read\` tool
  [INFO]  good to know
  [TICK]  periodic summary, nothing to do (leave it out of notifications)
  [WAKE]  only with --wake: the last line before it exits, how many finished and how many need a look

With no session ids it watches every session that is still unfinished, plus any created after it started,
plus any finished one that is resumed. It exits by itself once everything it watches has finished (--wake and
--forever never do that). It only reads from the service: it never cancels or messages a session. The one file it
may write is the --state file you name.

Options
  --sessions <id,id,...>  same as listing the ids
  --wake                  for ONE global watcher that wakes you: as soon as a session finishes ([DONE]) or something needs a
                          look ([ALERT]), print it, wait --wake-batch seconds for the ones that arrive together, print a
                          [WAKE] summary line and exit with code 10. A host wakes an idle main agent when a background
                          command exits, so: handle what was printed, then start this watcher again with the same
                          arguments. Having nothing to watch is not an error; it waits. Not with --forever or --once.
  --wake-batch <seconds>  with --wake: how long to collect lines that arrive together after the first one (default 3; 0 = at once)
  --state <file>          remember what was already reported and how far each session's events were read, in this JSON file
                          (replaced atomically; its folder must exist). A restarted watcher then reports sessions that
                          finished in between and does not repeat itself. Without it a restart starts from now and says
                          the same things again. Use one file per distinct set of arguments.
  --origin <key>          only watch sessions of this Main Agent (the origin key, matched exactly); repeatable; default all.
                          A session of another origin is never read, even when it follows one of yours.
  --origin-of <id>        same, taking the origin from a session id you delegated (so you need not know the key)
  --interval <seconds>    poll interval (default 30)
  --tick <minutes>        summary line every so often; 0 turns it off (default 5)
  --rules <file.json>     your project's rules to check (see watch.rules.example.json); none are checked without it
  --gone-after <minutes>  give up when the service has been unreachable this long (default 10)
  --forever               keep watching after everything has finished
  --once                  do one pass, then exit
  --help                  show this text

Environment: ENSEMBLE_HOME selects the state directory, the same as for the plugin.
Exit codes: 0 finished (or --once), 2 bad arguments or none of the named sessions exist, 3 service unreachable, 10 --wake: something needs handling.`;

// ───────────────────────── 小工具 ─────────────────────────

const isHighSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * 取开头最多 max 个 UTF-16 码元；截点落在代理对（emoji 等超出 BMP 的字符占两个码元）中间时少取一个，不留孤立的代理项。
 * 原文里本来就有的孤立代理项原样保留。与服务端 src/shared/safe-slice.ts 的 `sliceHead` 同一语义（脚本独立分发，抄了一份，测试对照）。
 */
export function sliceHead(text, max) {
  let end = Math.min(text.length, Math.max(0, Math.floor(max)));
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return text.slice(0, end);
}

/** 取结尾最多 max 个码元；起点落在代理对中间时少取一个。与服务端 src/shared/safe-slice.ts 的 `sliceTail` 同一语义。 */
export function sliceTail(text, max) {
  const size = Math.min(text.length, Math.max(0, Math.floor(max)));
  let start = text.length - size;
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start += 1;
  return text.slice(start);
}

/** 压成一行并截断：工具输出可能很长、带换行。截法与服务端的 `clip(collapseWhitespace(text), max)` 相同（含代理对安全）。 */
export function clip(text, max = 120) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${sliceHead(flat, Math.max(0, max - 1)).trimEnd()}…` : flat;
}

const basename = (path) => {
  const normalized = String(path).replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
};

/** 中间省略的路径缩写，始终保留文件名；与服务端的 `shortenPath` 逐字相同（含代理对安全；脚本独立分发，所以抄了一份，测试对照）。 */
export function shortenPath(path, max = 52) {
  if (path.length <= max) return path;
  const name = basename(path);
  // 名字本身放不下，或者连同省略号几乎占满 max（名字长度 ≥ max - 2）：不留头部，只留名字的结尾，至多 max - 1 个字符。
  // 名字只有 max - 2 个字符时，max - 1 比它还长，sliceTail 把越界的数夹成整段，所以整个名字都留下；
  // 别改回 name.slice(name.length - (max - 1))：这个边界上下标是 -1，slice 把它当成“倒数第一个”，名字就只剩最后一个字符。
  if (name.length >= max - 2) return `…${sliceTail(name, max - 1)}`;
  const room = max - name.length - 2;
  return `${sliceHead(path, Math.max(3, room))}…${sliceTail(path, name.length + 1)}`;
}

/** 执行端的显示名：与 MCP 输出里 `[Codex]` 那一栏同一种写法（模拟的执行端会注明）。 */
export function harnessLabel(summary) {
  const harness = String(summary.harness ?? "harness");
  const name = harness === "dsh" ? "DSH" : harness.charAt(0).toUpperCase() + harness.slice(1);
  return summary.runtime === "fixture" ? `${name} (simulated)` : name;
}

/** 与服务端 `formatDuration`（src/shared/format.ts）同一种写法，MCP 输出与这里的读数一致。 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const two = (value) => String(value).padStart(2, "0");
const clock = (ms) => {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};

const labelOf = (summary) => `"${clip(summary.title, 40)}" (${summary.id})`;

/** 状态目录：与 src/server/paths.ts 的 resolveHome 同一套规则（脚本独立分发，所以在这里抄一份，由测试对照）。 */
export function resolveHome(env = process.env, platform = process.platform) {
  const override = env.ENSEMBLE_HOME;
  if (override && override.trim().length > 0) return override;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Ensemble");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Ensemble");
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "ensemble");
}

/** 会话是否已经“结束到可以去取结果”：与 src/shared/session-end.ts 的 isSessionSettled 同一口径。 */
export function isSettled(summary) {
  switch (summary.phase) {
    case "done":
    case "failed":
    case "cancelled":
      return (summary.messages?.pending ?? 0) === 0;
    case "stopped":
    case "lost":
      return true;
    default:
      return false;
  }
}

// ───────────────────────── 参数 ─────────────────────────

const VALUE_OPTIONS = new Set(["sessions", "interval", "tick", "rules", "gone-after", "wake-batch", "state", "origin", "origin-of"]);
const SESSION_ID = /^[\w.:-]{1,100}$/;

export function parseArgs(argv) {
  const options = {
    ids: [],
    interval: 30,
    tick: 5,
    goneAfter: 10,
    forever: false,
    once: false,
    help: false,
    wake: false,
    wakeBatch: WAKE_BATCH_DEFAULT,
    origins: [],
    originOf: [],
  };
  const errors = [];
  let wakeBatchGiven = false;
  const number = (name, raw, min) => {
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || value < min) {
      errors.push(`--${name} needs a number of at least ${min}`);
      return undefined;
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options.ids.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value = equals === -1 ? undefined : token.slice(equals + 1);
    if (VALUE_OPTIONS.has(name) && value === undefined) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
    }
    switch (name) {
      case "sessions":
        if (value === undefined || value === "") errors.push("--sessions needs a comma-separated list of session ids");
        else options.ids.push(...value.split(",").filter(Boolean));
        break;
      case "interval": {
        const seconds = number(name, value, 0.1);
        if (seconds !== undefined) options.interval = seconds;
        break;
      }
      case "tick": {
        const minutes = number(name, value, 0);
        if (minutes !== undefined) options.tick = minutes;
        break;
      }
      case "gone-after": {
        const minutes = number(name, value, 0);
        if (minutes !== undefined) options.goneAfter = minutes;
        break;
      }
      case "rules":
        if (value === undefined || value === "") errors.push("--rules needs a file");
        else options.rules = value;
        break;
      case "state":
        if (value === undefined || value === "") errors.push("--state needs a file");
        else options.state = value;
        break;
      case "wake":
        options.wake = true;
        break;
      case "wake-batch": {
        wakeBatchGiven = true;
        const seconds = number(name, value, 0);
        if (seconds !== undefined) options.wakeBatch = seconds;
        break;
      }
      case "origin":
        if (value === undefined || value === "") errors.push("--origin needs an origin key (the Main Agent's `origin.key`; or use --origin-of <session id>)");
        else options.origins.push(value);
        break;
      case "origin-of":
        if (value === undefined || value === "") errors.push("--origin-of needs a session id");
        else options.originOf.push(value);
        break;
      case "forever":
        options.forever = true;
        break;
      case "once":
        options.once = true;
        break;
      case "help":
        options.help = true;
        break;
      default:
        errors.push(`unknown option --${name}`);
    }
  }
  for (const id of [...options.ids, ...options.originOf]) {
    if (!SESSION_ID.test(id)) errors.push(`"${clip(id, 40)}" is not a session id (they look like ses_…)`);
  }
  // --wake 靠“退出”叫醒主 Agent：与永不退出（--forever）或只看一遍（--once）矛盾，直接拒绝，不悄悄选一个。
  if (options.wake && options.forever) errors.push("--wake cannot be combined with --forever: --wake exits to wake you, --forever never exits");
  if (options.wake && options.once) errors.push("--wake cannot be combined with --once: --once looks once and exits, --wake waits for something to happen");
  if (wakeBatchGiven && !options.wake) errors.push("--wake-batch only applies together with --wake");
  // 点名了会话 id 就是盯这几个：来源过滤只用于“自己找该盯哪些”，两者同用会让点名的会话被悄悄忽略。
  if (options.ids.length > 0 && (options.origins.length > 0 || options.originOf.length > 0)) {
    errors.push("--origin / --origin-of choose which sessions to pick up on its own; they cannot be combined with explicit session ids");
  }
  options.ids = [...new Set(options.ids)];
  options.origins = [...new Set(options.origins)];
  options.originOf = [...new Set(options.originOf)];
  return { options, errors };
}

// ───────────────────────── 项目规矩（可选） ─────────────────────────

export const NO_RULES = Object.freeze({ commands: [], paths: [] });

/**
 * 规矩文件的形状：{ "commands": [{ "match": "<正则>", "flags": "i", "message": "…" }], "paths": [ … ] }。
 * `commands` 对 shell 命令的文本逐条检查（每个工具调用只查一次）；
 * `paths` 对执行端报告的文件变更逐个检查，路径相对会话的工作目录、用正斜杠写。`flags` 缺省为 i；不接受 g / y（会让正则带上状态）。
 */
export function compileRules(raw) {
  const compiled = { commands: [], paths: [] };
  for (const kind of ["commands", "paths"]) {
    const list = raw?.[kind] ?? [];
    if (!Array.isArray(list)) throw new Error(`"${kind}" must be an array`);
    list.forEach((rule, index) => {
      const where = `${kind}[${index}]`;
      if (typeof rule?.match !== "string" || typeof rule?.message !== "string" || rule.message === "") {
        throw new Error(`${where} needs a "match" pattern and a "message", both strings`);
      }
      const flags = typeof rule.flags === "string" ? rule.flags : "i";
      if (/[gy]/.test(flags)) throw new Error(`${where}.flags must not contain g or y`);
      try {
        compiled[kind].push({ regex: new RegExp(rule.match, flags), message: rule.message });
      } catch (error) {
        throw new Error(`${where}.match is not a valid regular expression: ${error.message}`);
      }
    });
  }
  return compiled;
}

export function loadRules(file) {
  const text = readFileSync(resolve(file), "utf8").replace(/^\uFEFF/, "");
  return compileRules(JSON.parse(text));
}

/** 文件路径写成相对会话工作目录的正斜杠形式；不在工作目录里的保持绝对路径（正斜杠）。 */
export function normalizePath(file, cwd) {
  const slashed = String(file ?? "").replace(/\\/g, "/");
  const base = String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (base) {
    const insensitive = process.platform === "win32" || process.platform === "darwin";
    const fold = (text) => (insensitive ? text.toLowerCase() : text);
    if (fold(slashed) === fold(base)) return "";
    if (fold(slashed).startsWith(`${fold(base)}/`)) return slashed.slice(base.length + 1);
  }
  return slashed.replace(/^\.\//, "");
}

// ───────────────────────── 一条“值得留意”的事实怎么说 ─────────────────────────

/** 与 src/shared/attention.ts 的 attentionKey 同一口径：同一件事持续期间标识不变。 */
export function attentionKey(item) {
  switch (item.kind) {
    case "quiet":
      return `quiet|${item.since}`;
    case "long_tool":
      return `long_tool|${item.tool?.callId}|${item.since}`;
    case "long_run":
      return `long_run|${item.runId ?? item.since}`;
    case "shared_file":
      return `shared_file|${item.path}`;
    case "undelivered":
      return `undelivered|${item.messageId}`;
    case "question":
      // 以提问为准：同一个提问持续期间标识不变，回答之后它的标识就不再出现。
      return `question|${item.questionId}`;
    default:
      // 服务端将来新增的类型：照样有标识，不会被悄悄丢掉。
      return `${item.kind}|${item.since}`;
  }
}

const STAGE_TEXT = { recorded: "recorded by Ensemble", queued: "queued", handed_off: "handed to the harness", applied: "applied", failed: "failed", cancelled: "cancelled" };

/** 措辞与 src/mcp/format.ts 的 describeAttention 逐字一致（测试对照）：只陈述事实，并明说这不是诊断。 */
export function describeAttention(item, summary, now) {
  const since = formatDuration(now - Date.parse(item.since));
  switch (item.kind) {
    case "quiet":
      return `no events from ${harnessLabel(summary)} for ${since} (last event #${item.seq}) and no tool call is in progress — read the transcript to see what it was last doing before deciding anything`;
    case "long_tool":
      return `no events for ${since} since ${item.tool?.category ?? "tool"} \`${clip(item.tool?.title, 80)}\` started ${formatDuration(now - Date.parse(item.tool?.startedAt))} ago — a long build or test is normal; read the transcript if that is not what you expect`;
    case "long_run":
      return `this run has been going for ${since}`;
    case "shared_file":
      return `${shortenPath(String(item.path ?? ""), 90)} was also written by ${(item.withSessionIds ?? []).join(", ")} (latest write ${since} ago) — concurrent edits to one file can overwrite each other`;
    case "undelivered": {
      const what = item.messageKind === "task" ? "the task" : `the ${item.messageKind === "steer" ? "correction" : "follow-up"}`;
      return `${what} message ${item.messageId} is still "${STAGE_TEXT[item.stage] ?? item.stage}" after ${since} — the harness has not confirmed it was applied`;
    }
    case "question": {
      // 与 src/mcp/format-questions.ts 的 questionSummary 一致：一行摘要，只含第一个问题；怎么回复见 `status` 的整块输出。
      const prompts = item.prompts ?? [];
      const more = prompts.length > 1 ? ` (+${prompts.length - 1} more)` : "";
      return `${harnessLabel(summary)} is waiting for an answer to a question (${item.questionId}): "${prompts[0] ? clip(prompts[0].text, 160) : ""}"${more}`;
    }
    default:
      // 服务端将来新增的类型：照实写出，不丢。
      return `${item.kind} since ${item.since}`;
  }
}

// ───────────────────────── 逐会话的判断（纯函数，时间由参数传入） ─────────────────────────

/** 一个被盯着的会话的记忆：读到哪一条事件、各工具调用的最新样子、已经提醒过什么。 */
export function createTracker(summary) {
  return {
    id: summary.id,
    cwd: summary.cwd ?? "",
    afterSeq: 0,
    backfilling: true,
    tools: new Map(),
    finished: [],
    emitted: new Map(),
    readySince: undefined,
    // 最近一次说过的“结束”的标识（settle 给每次结束的 key）：状态文件靠它认出“这一次结束已经说过了”。
    lastEnd: undefined,
  };
}

const TOOL_FIELDS = ["name", "category", "title", "status", "error", "exitCode", "startedAt", "endedAt"];
const isShell = (tool) => tool.category === "shell" || tool.name === "shell";

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // 预览被截断时不是完整的 JSON：调用方退回用标题。
    return undefined;
  }
}

/** shell 类调用的完整命令文本：直接是命令的取原文，是 JSON 参数的取 command；都取不到才用标题。 */
function commandOf(tool) {
  const text = tool.input?.text;
  if (typeof text === "string" && text !== "") {
    if (tool.input?.format !== "json") return text;
    const parsed = parseJson(text);
    const command = parsed?.command ?? parsed?.cmd;
    if (typeof command === "string" && command !== "") return command;
  }
  return String(tool.title ?? "");
}

/** 非 shell 类调用的目标：参数里的路径 / 模式 / 查询 / 地址（有几个取几个），没有就用标题。 */
const TARGET_KEYS = ["file_path", "filePath", "path", "notebook_path", "pattern", "query", "url"];
function targetOf(tool) {
  const parsed = tool.input?.format === "json" && typeof tool.input.text === "string" ? parseJson(tool.input.text) : undefined;
  if (parsed !== null && typeof parsed === "object") {
    const picked = TARGET_KEYS.map((key) => parsed[key]).filter((value) => typeof value === "string" && value !== "");
    if (picked.length > 0) return picked.join(" ");
  }
  return String(tool.title ?? "");
}

/**
 * 判断“同一个调用反复出现”用的指纹：shell 类取规范化后的完整命令（折叠空白、至多 FINGERPRINT_MAX 个字符），
 * 所以 `git log -n 1` 与 `git log -n 2` 是两个调用；其它工具取“工具名 + 目标路径 / 关键参数”。
 */
export function callFingerprint(tool) {
  return `${tool.name}: ${clip(isShell(tool) ? commandOf(tool) : targetOf(tool), FINGERPRINT_MAX)}`;
}

/** 失败的调用给出的原因：输出与错误常常是同一段话，只写一遍。 */
function failureText(tool, max) {
  const output = clip(tool.output?.text, max);
  const error = clip(tool.error, max);
  return error && !output.includes(error) ? clip(`${output} ${error}`, max) : output || error;
}

/**
 * 把新读到的事件并进会话的记忆，返回由事件本身触发的发现（规矩被触碰、文件冲突类报错）。
 * 工具调用的更新是一块一块来的（先有名字与输入，后有状态与输出），所以按 callId 合并。
 */
export function ingest(tracker, events, { rules = NO_RULES, now }) {
  const findings = [];
  for (const event of events) {
    if (typeof event.seq === "number" && event.seq > tracker.afterSeq) tracker.afterSeq = event.seq;
    // 补读历史时，只有最近发生的才触发；这之后读到的一律算新的。
    const fresh = !tracker.backfilling || !(now - Date.parse(event.at) > BACKLOG_FRESH_MS);
    const data = event.data ?? {};

    if (event.kind === "tool.updated" && data.callId) {
      const tool = tracker.tools.get(data.callId) ?? { callId: data.callId, name: "tool", category: "other", title: "", status: "running" };
      for (const field of TOOL_FIELDS) if (data[field] !== undefined) tool[field] = data[field];
      if (data.input !== undefined) tool.input = data.input;
      if (data.output !== undefined) tool.output = data.output;
      tracker.tools.set(tool.callId, tool);

      if (!tool.finished && (tool.status === "completed" || tool.status === "failed" || tool.status === "cancelled")) {
        tool.finished = true;
        tracker.finished.push(tool.callId);
        if (tracker.finished.length > 60) tracker.tools.delete(tracker.finished.shift());
        if (tool.status === "failed" && fresh && CONFLICT_ERRORS.test(`${tool.output?.text ?? ""} ${tool.error ?? ""}`)) {
          findings.push({ tag: "INFO", key: `conflict|${tool.callId}`, text: `a tool call failed with a file-conflict style error — \`${clip(tool.title, 60)}\` → ${failureText(tool, 140)}` });
        }
      }

      if (rules.commands.length > 0 && isShell(tool)) {
        // 命令文本可能先以标题出现、完整输入随后才到：两者各查一次；同一条规则对同一个调用只会提醒一次（key 相同）。
        tool.checked ??= new Set();
        for (const text of [tool.input?.text, tool.title]) {
          if (!text || tool.checked.has(text)) continue;
          tool.checked.add(text);
          if (!fresh) continue;
          for (const rule of rules.commands) {
            if (rule.regex.test(text)) findings.push({ tag: "ALERT", key: `rule|${tool.callId}|${rule.message}`, text: `${rule.message}: ${clip(text, 160)}` });
          }
        }
      }
    } else if (event.kind === "file.changed" && fresh && rules.paths.length > 0) {
      for (const file of data.files ?? []) {
        const path = normalizePath(file.path, tracker.cwd);
        for (const rule of rules.paths) {
          if (rule.regex.test(path)) findings.push({ tag: "ALERT", key: `path|${path}|${rule.message}`, text: `${rule.message}: ${clip(path, 160)}` });
        }
      }
    }
  }
  tracker.backfilling = false;
  return findings;
}

/**
 * 对会话此刻的样子做判断，返回仍然成立的发现。是否真的输出（新出现 / 隔了多久再提醒）由调用方按 key 决定。
 * `capacity` 是服务的并发名额（可能没有读到）。
 */
export function inspect(tracker, summary, { now, capacity }) {
  const findings = [];

  if (summary.phase === "starting" || summary.phase === "running") {
    let streak = 0;
    for (let index = tracker.finished.length - 1; index >= 0; index -= 1) {
      if (tracker.tools.get(tracker.finished[index])?.status !== "failed") break;
      streak += 1;
    }
    if (streak >= FAIL_STREAK) {
      const last = tracker.tools.get(tracker.finished.at(-1));
      findings.push({
        tag: "ALERT",
        key: "failstreak",
        repeat: true,
        text: `${streak} tool calls in a row have failed; latest: \`${clip(last?.title, 80)}\` → ${last ? failureText(last, 120) : ""}`,
      });
    }

    const recent = tracker.finished.slice(-LOOP_WINDOW).map((id) => tracker.tools.get(id)).filter((tool) => tool && tool.title !== "");
    const counts = new Map();
    for (const tool of recent) {
      const key = callFingerprint(tool);
      const entry = counts.get(key) ?? { repeats: 0, failed: 0 };
      entry.repeats += 1;
      if (tool.status === "failed") entry.failed += 1;
      counts.set(key, entry);
    }
    for (const [key, { repeats, failed }] of counts) {
      if (repeats >= LOOP_MIN_REPEATS && failed >= LOOP_MIN_FAILED) {
        findings.push({ tag: "ALERT", key: `repeat|${key}`, repeat: true, text: `the same tool call ran ${repeats} times among the last ${recent.length} finished calls, ${failed} of them failed: ${clip(key, 140)}` });
      }
    }
  }

  if (summary.phase === "queued" && capacity) {
    const since = Date.parse(summary.activity?.since ?? summary.updatedAt);
    const free = capacity.max === 0 || capacity.occupied < capacity.max;
    if (free && now - since >= QUEUED_MS) {
      findings.push({
        tag: "ALERT",
        key: "queued",
        repeat: true,
        text: `waiting for a concurrency slot for ${formatDuration(now - since)}, although the service reports free capacity (${capacity.occupied} of ${capacity.max === 0 ? "unlimited" : capacity.max} in use)`,
      });
    }
  }

  // 服务端已经算好的“值得留意”：与 `wait` 提前返回、MCP 的 `attention:` 行是同一份，这里原样转述、不再算第二遍。
  for (const item of summary.attention ?? []) {
    findings.push({ tag: "ALERT", key: `attention|${attentionKey(item)}`, repeat: true, text: describeAttention(item, summary, now) });
  }
  return findings;
}

/** 会话结束时说一次（每次运行各说一次：结束后又被补发消息、再结束，会再说）。 */
export function settle(tracker, summary, now) {
  const { phase } = summary;
  if (phase === "ready") {
    tracker.readySince ??= now;
    if (now - tracker.readySince < READY_GRACE_MS) return [];
    return [{ tag: "INFO", key: `ready|${summary.lastRun?.id ?? ""}`, text: "is idle (ready): nothing is running in it" }];
  }
  tracker.readySince = undefined;
  if (!isSettled(summary)) return [];
  const key = `end|${summary.lastRun?.id ?? ""}|${phase}`;
  if (phase === "done") {
    const { tools = 0, failedTools = 0, files = 0 } = summary.counters ?? {};
    const facts = [`${tools} tool call${tools === 1 ? "" : "s"}`, ...(failedTools ? [`${failedTools} failed`] : []), ...(files ? [`${files} file${files === 1 ? "" : "s"} changed`] : [])];
    return [{ tag: "DONE", key, text: `finished (${facts.join(", ")}) — use the \`read\` tool for its result` }];
  }
  // 失败与丢失需要去看；被取消或主动关闭是有人做的决定（用户在面板上做的会随下一次工具调用的结果告诉主 Agent）。
  const error = summary.lastError;
  return [{ tag: phase === "failed" || phase === "lost" ? "ALERT" : "INFO", key, text: `ended as ${phase}${error ? ` — [${error.code}] ${clip(error.message, 200)}` : ""}` }];
}

// ───────────────────────── 连接服务 ─────────────────────────

/** 服务的地址与令牌（service.json 由服务写下；不存在或损坏都当作没有服务）。 */
export function readService(home) {
  try {
    const file = JSON.parse(readFileSync(join(home, "run", "service.json"), "utf8"));
    if (typeof file.port === "number" && typeof file.token === "string") return { port: file.port, token: file.token };
  } catch {
    // 没有服务在运行，或文件正被改写。
  }
  return undefined;
}

async function fetchJson(service, path) {
  const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`, {
    headers: { [TOKEN_HEADER]: service.token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return response.json();
}

const reasonOf = (error) => clip(error?.cause?.code ?? error?.message ?? error, 100);

// ───────────────────────── 状态文件（可选，--state） ─────────────────────────

/**
 * 状态文件让重启接得上（--wake 每次叫醒后都要重启）。JSON，version 1：
 *   savedAt   写文件的时刻（毫秒时间戳）
 *   lastPoll  最近一轮读到会话列表的开始时刻：重启时，结束于它之后、还没说过的会话按“上次退出之后结束的”补报
 *   sessions  { <会话 id>: { cursor, ended, alerts } }，只记仍被盯着的会话，各字段缺省即“没有”
 *     cursor  已读到的事件序号：重启后从这里接着读，不重读旧事件去触发规则
 *     ended   最近一次说过的“这一次结束”的标识
 *     alerts  { <提醒的指纹>: <说的时刻> }：只记还没到“可以再提醒”的那些，重启后同一件事不会立刻再说一遍
 * “这一次结束”的标识就是 settle() 给每次结束的 key：`end|<最近一轮的运行 id>|<阶段>`。运行 id 在运行结束后不再变，
 * 所以同一次结束在重启前后是同一个标识（不重复说）；被 send 续跑会有新的运行，再结束时标识不同（会再说一次）。
 */

/** 解析状态文件的文本：成功得到 `{ state }`，不认识或不完整得到 `{ problem }`（调用方当作没有这个文件）。 */
export function parseState(text) {
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    return { problem: "it is not valid JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { problem: "it is not a JSON object" };
  if (raw.version !== STATE_VERSION) {
    return { problem: `${raw.version === undefined ? "it has no version" : `it is version ${clip(JSON.stringify(raw.version), 20)}`}, this script reads version ${STATE_VERSION}` };
  }
  if (!Number.isFinite(raw.lastPoll) || !Number.isFinite(raw.savedAt)) return { problem: "it has no usable lastPoll / savedAt" };
  const sessions = new Map();
  const given = raw.sessions !== null && typeof raw.sessions === "object" && !Array.isArray(raw.sessions) ? Object.entries(raw.sessions) : [];
  for (const [id, entry] of given) {
    if (entry === null || typeof entry !== "object") continue;
    const alerts = new Map();
    const mentioned = entry.alerts !== null && typeof entry.alerts === "object" && !Array.isArray(entry.alerts) ? Object.entries(entry.alerts) : [];
    for (const [key, at] of mentioned) if (Number.isFinite(at)) alerts.set(key, at);
    sessions.set(id, {
      cursor: Number.isInteger(entry.cursor) && entry.cursor > 0 ? entry.cursor : undefined,
      ended: typeof entry.ended === "string" && entry.ended !== "" ? entry.ended : undefined,
      alerts,
    });
  }
  return { state: { savedAt: raw.savedAt, lastPoll: raw.lastPoll, sessions } };
}

/** 读状态文件：`{ state }`、`{ missing: true }`（还没有，第一次运行），或 `{ problem }`。 */
export function readStateFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { problem: `it cannot be read (${reasonOf(error)})` };
  }
  return parseState(text);
}

/** 先写同目录下的临时文件再改名：读的一方（包括下一个看门狗）永远只会读到完整的旧文件或完整的新文件。 */
function writeStateFile(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  const bytes = Buffer.from(text, "utf8");
  const handle = openSync(temporary, "w");
  try {
    for (let written = 0; written < bytes.length; ) written += writeSync(handle, bytes, written, bytes.length - written);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, file);
}

/** 把此刻要记住的东西整理成状态（见上）。提醒的指纹只留还没到“可以再提醒”的：再老的，不记与记着等效。 */
export function buildState(watcher, now) {
  const sessions = new Map();
  for (const [id, tracker] of watcher.trackers) {
    const alerts = {};
    for (const [key, at] of tracker.emitted) if (!key.startsWith("end|") && now - at < REALERT_MS) alerts[key] = at;
    const record = {
      ...(tracker.afterSeq > 0 ? { cursor: tracker.afterSeq } : {}),
      ...(tracker.lastEnd ? { ended: tracker.lastEnd } : {}),
      ...(Object.keys(alerts).length > 0 ? { alerts } : {}),
    };
    if (Object.keys(record).length > 0) sessions.set(id, record);
  }
  return { version: STATE_VERSION, savedAt: now, lastPoll: watcher.lastPoll ?? now, sessions: Object.fromEntries(sessions) };
}

/** 每一轮之后写一次（没有 --state 就什么也不做）。写失败只说一次、下一轮再试：看门狗本身比记忆重要。 */
function saveState(watcher) {
  const file = watcher.options.state;
  if (!file) return;
  try {
    writeStateFile(resolve(file), `${JSON.stringify(buildState(watcher, watcher.now()), null, 2)}\n`);
    watcher.saveFailed = false;
  } catch (error) {
    if (!watcher.saveFailed) watcher.say("INFO", `could not save the --state file ${file} (${reasonOf(error)}) — will try again on the next pass; until it works a restart forgets what was reported`);
    watcher.saveFailed = true;
  }
}

/** 启动时读一次状态文件，并说明是接着上次、从现在开始，还是忽略了一个坏文件。 */
function loadMemory(watcher, now) {
  const file = watcher.options.state;
  if (!file) return;
  const result = readStateFile(resolve(file));
  if (result.state) {
    watcher.memory = result.state;
    watcher.lastPoll = result.state.lastPoll;
    watcher.say("INFO", `resuming from the --state file ${file} (it was last saved ${formatDuration(now - result.state.savedAt)} ago)`);
  } else if (result.missing) {
    watcher.say("INFO", `the --state file ${file} does not exist yet — starting from now; it is created after the first pass`);
  } else {
    watcher.say("INFO", `ignoring the --state file ${file}: ${result.problem} — starting from now; it is replaced after the first pass`);
  }
}

/** 启动时核对状态文件的位置：目录不存在或路径本身是个目录，写了也白写，直接说清楚比悄悄丢状态好。返回问题描述，没问题返回 undefined。 */
function checkStatePath(file) {
  const path = resolve(file);
  try {
    if (statSync(path).isDirectory()) return "that path is a folder, not a file";
  } catch {
    // 文件还不存在是正常的（第一次运行）。
  }
  try {
    if (!statSync(dirname(path)).isDirectory()) return `${dirname(path)} is not a folder`;
  } catch {
    return `the folder ${dirname(path)} does not exist (create it first; the script does not make folders)`;
  }
  return undefined;
}

/** 会话最近一次运行的结束时刻（毫秒）；服务没有记录就返回 undefined——宁可不报，也不拿别的时间去猜。 */
export function endedAtOf(summary) {
  const stamp = Date.parse(summary.endedAt ?? summary.lastRun?.endedAt ?? "");
  return Number.isFinite(stamp) ? stamp : undefined;
}

// ───────────────────────── 来源过滤（可选，--origin） ─────────────────────────

/**
 * 要盯哪些来源（`summary.origin.key` 字符串全等）：--origin 给的，加上 --origin-of 那些会话所属的来源。
 * 没有过滤返回 `{ keys: undefined }`；点名的会话不存在或没有来源返回 `{ problem }`。
 */
function resolveOrigins(watcher, byId) {
  const { origins, originOf } = watcher.options;
  if (origins.length === 0 && originOf.length === 0) return { keys: undefined };
  const keys = new Set(origins);
  for (const id of originOf) {
    const summary = byId.get(id);
    if (!summary) return { problem: `--origin-of ${id}: the service has no such session (archived sessions are not listed)` };
    const key = summary.origin?.key;
    if (typeof key !== "string" || key === "") return { problem: `--origin-of ${id}: that session has no origin key recorded` };
    keys.add(key);
  }
  return { keys };
}

/** 会话是否在要盯的来源里。跨来源的会话（比如 follows 了你的会话）按它自己的来源判断，不跟上级走。 */
const inScope = (watcher, summary) => watcher.originKeys === undefined || watcher.originKeys.has(summary.origin?.key);

// ───────────────────────── 巡检 ─────────────────────────

/** `deps` 都可以替换（测试用）：now / say / sleep / readService / fetchJson / rules / home / env。 */
export function createWatcher(options, deps = {}) {
  const now = deps.now ?? Date.now;
  return {
    options: { ids: [], origins: [], originOf: [], wake: false, wakeBatch: WAKE_BATCH_DEFAULT, ...options },
    home: deps.home ?? resolveHome(deps.env ?? process.env),
    rules: deps.rules ?? NO_RULES,
    now,
    say: deps.say ?? ((tag, text) => process.stdout.write(`${clock(now())} [${tag}] ${clip(text, LINE_MAX)}\n`)),
    sleep: deps.sleep ?? sleep,
    readService: deps.readService ?? readService,
    fetchJson: deps.fetchJson ?? fetchJson,
    trackers: new Map(),
    known: undefined,
    lastTick: now(),
    failures: 0,
    goneSince: undefined,
    goneAnnounced: false,
    // --origin 解析出来的来源 key；没有过滤时是 undefined。
    originKeys: undefined,
    // --state：启动时读到的记忆、最近一轮读到会话列表的开始时刻、最近一次写文件是否失败（只说一次）。
    memory: undefined,
    lastPoll: undefined,
    saveFailed: false,
    // --wake：这一次叫醒要带上的输出（只记标签：DONE / ALERT）。
    waking: [],
  };
}

function unreachable(watcher, error, now) {
  const { options } = watcher;
  watcher.goneSince ??= now;
  watcher.failures += 1;
  const down = now - watcher.goneSince;
  const reason = reasonOf(error);
  if (options.once) {
    watcher.say("ALERT", `cannot reach the Ensemble service (${reason})`);
    return { exit: 3 };
  }
  if (down >= options.goneAfter * 60_000) {
    watcher.say("ALERT", `the Ensemble service has been unreachable for ${formatDuration(down)} (${reason}); giving up. Sessions that were running in it are interrupted if it has stopped.`);
    return { exit: 3 };
  }
  // 一次读取失败可能只是服务正忙或正在重启；连着两次才说。
  if (watcher.failures === 2) {
    watcher.goneAnnounced = true;
    watcher.say("ALERT", `the Ensemble service is unreachable (${reason}) — sessions running in it are interrupted if it has stopped. Still retrying.`);
  }
  return {};
}

function emit(watcher, tracker, summary, findings) {
  const now = watcher.now();
  for (const finding of findings) {
    const last = tracker.emitted.get(finding.key);
    if (last !== undefined && !(finding.repeat && now - last >= REALERT_MS)) continue;
    tracker.emitted.set(finding.key, now);
    // 状态文件要记住“这一次结束已经说过了”：key 就是 settle() 给每次结束的标识。
    if (finding.key.startsWith("end|")) tracker.lastEnd = finding.key;
    // --wake：只有 [DONE] 与 [ALERT] 值得叫醒主 Agent；[INFO] 与 [TICK] 不算。
    if (watcher.options.wake && (finding.tag === "DONE" || finding.tag === "ALERT")) watcher.waking.push(finding.tag);
    watcher.say(finding.tag, `${labelOf(summary)}: ${finding.text}`);
  }
}

/** 开始盯一个会话；状态文件里记着它的话，接着上次的位置读、说过的不再说。 */
function adopt(watcher, summary) {
  const tracker = createTracker(summary);
  const remembered = watcher.memory?.sessions.get(summary.id);
  if (remembered) {
    // 游标之前的事件上次已经处理过：不再读，也就不会拿旧事件去触发规则；游标之后的一律算新的。
    if (remembered.cursor !== undefined) {
      tracker.afterSeq = remembered.cursor;
      tracker.backfilling = false;
    }
    if (remembered.ended !== undefined) {
      tracker.emitted.set(remembered.ended, watcher.memory.lastPoll);
      tracker.lastEnd = remembered.ended;
    }
    for (const [key, at] of remembered.alerts) tracker.emitted.set(key, at);
  }
  watcher.trackers.set(summary.id, tracker);
  return tracker;
}

/**
 * 看门狗没在运行（或两轮之间）结束、还没人说过的会话：为它们建好记录，由后面的循环照常说出 [DONE] / [ALERT] / [INFO]。
 * 它们的事件不读（属于“之前”）。只在启动那一轮、有状态文件时做；点名了会话 id 时只盯那几个，不做这件事。
 * 返回补报的会话。
 */
function adoptEndedSince(watcher, sessions) {
  const since = watcher.lastPoll;
  const adopted = [];
  if (since === undefined) return adopted;
  for (const summary of sessions) {
    if (watcher.trackers.has(summary.id) || !inScope(watcher, summary) || !isSettled(summary)) continue;
    const endedAt = endedAtOf(summary);
    if (endedAt === undefined || endedAt <= since) continue;
    const tracker = adopt(watcher, summary);
    tracker.afterSeq = Number(summary.seq) || 0;
    tracker.backfilling = false;
    adopted.push(summary);
  }
  return adopted;
}

const settledForExit = (tracker, summary, now) => isSettled(summary) || (summary.phase === "ready" && tracker.readySince !== undefined && now - tracker.readySince >= READY_GRACE_MS);

/** 读一遍服务并处理。返回 `{ exit }` 表示该结束了（退出码），否则 `{}`。 */
async function scan(watcher) {
  const { options } = watcher;
  const now = watcher.now();
  // --wake 与 --forever 一样不会因为“盯着的会话都结束了”而退出：前者靠叫醒退出，后者常驻。
  const keepAlive = options.forever || options.wake;

  let sessions;
  let capacity;
  try {
    const service = watcher.readService(watcher.home);
    if (!service) throw new Error(`no service.json under ${join(watcher.home, "run")}`);
    const body = await watcher.fetchJson(service, "/sessions");
    if (!Array.isArray(body?.sessions)) throw new Error("the service answered /api/sessions with something unexpected");
    sessions = body.sessions;
    capacity = await watcher.fetchJson(service, "/health").then((body) => body.capacity, () => undefined);
    watcher.service = service;
  } catch (error) {
    return unreachable(watcher, error, now);
  }
  if (watcher.goneSince !== undefined) {
    if (watcher.goneAnnounced) watcher.say("INFO", `the Ensemble service is reachable again after ${formatDuration(now - watcher.goneSince)}`);
    watcher.goneSince = undefined;
    watcher.goneAnnounced = false;
  }
  watcher.failures = 0;

  // 读到了会话列表的这一轮才算“看过”：记下它的开始时刻并存状态（下面提前返回的出口也走这里）。
  const done = (result) => {
    watcher.lastPoll = now;
    saveState(watcher);
    return result;
  };

  const byId = new Map(sessions.map((summary) => [summary.id, summary]));
  const explicit = options.ids.length > 0;

  if (watcher.known === undefined) {
    const resolved = resolveOrigins(watcher, byId);
    if (resolved.problem) {
      watcher.say("ALERT", resolved.problem);
      return { exit: 2 };
    }
    watcher.originKeys = resolved.keys;
    loadMemory(watcher, now);

    watcher.known = new Set(byId.keys());
    const adopted = [];
    if (explicit) {
      for (const id of options.ids) {
        const summary = byId.get(id);
        if (summary) adopted.push(summary);
        else watcher.say("ALERT", `unknown session ${id} — not watching it`);
      }
    } else {
      // 待命（ready）的会话此刻什么也没在做，不算“没结束”：只盯真正在进行的；之后新建的会话不论什么阶段都盯。
      adopted.push(...sessions.filter((summary) => inScope(watcher, summary) && !isSettled(summary) && summary.phase !== "ready"));
    }
    for (const summary of adopted) adopt(watcher, summary);
    // 有状态文件时：上次看过之后才结束、还没说过的会话，这一轮补报。
    const ended = explicit ? [] : adoptEndedSince(watcher, sessions);
    if (adopted.length === 0 && ended.length === 0) {
      if (explicit) return { exit: 2 };
      if (options.wake) {
        watcher.say("INFO", "no unfinished sessions to watch yet — waiting for one to start (--wake keeps waiting)");
      } else {
        watcher.say("INFO", "no unfinished sessions to watch");
        if (!options.forever) return done({ exit: 0 });
      }
    }
    if (adopted.length > 0) {
      const shown = adopted.slice(0, 5).map(labelOf).join(", ");
      const more = adopted.length > 5 ? ` and ${adopted.length - 5} more` : "";
      const rules = watcher.rules.commands.length + watcher.rules.paths.length;
      const origins = watcher.originKeys ? `; only origin ${[...watcher.originKeys].join(", ")}` : "";
      const ending = options.wake ? "; exits when one finishes or needs attention" : options.forever ? "" : "; exits once they have finished";
      watcher.say(
        "INFO",
        `watching ${adopted.length} session${adopted.length === 1 ? "" : "s"}: ${shown}${more}; checking every ${options.interval}s${rules ? `, ${rules} project rule${rules === 1 ? "" : "s"} loaded` : ""}${origins}${ending}`,
      );
    }
    if (ended.length > 0) {
      const shown = ended.slice(0, 5).map(labelOf).join(", ");
      const more = ended.length > 5 ? ` and ${ended.length - 5} more` : "";
      watcher.say("INFO", `${ended.length} session${ended.length === 1 ? "" : "s"} finished since this watcher last looked (${formatDuration(now - watcher.lastPoll)} ago): ${shown}${more}`);
    }
  } else if (!explicit) {
    for (const summary of sessions) {
      if (watcher.trackers.has(summary.id) || !inScope(watcher, summary)) continue;
      if (!watcher.known.has(summary.id)) {
        watcher.known.add(summary.id);
        adopt(watcher, summary);
        watcher.say("INFO", `now also watching ${labelOf(summary)}`);
      } else if (!isSettled(summary) && summary.phase !== "ready") {
        // 之前没盯（待命或已结束），现在又在进行了：它被 send 续跑了。状态文件里记着读到的位置就接着读；没有记录就按新会话
        // 补读一遍历史（其中只有最近 3 分钟内的事才会触发规则与冲突提示）。这一轮盯过又结束的会话不走这里：它的记录一直留着。
        adopt(watcher, summary);
        watcher.say("INFO", `watching ${labelOf(summary)} again: it is back in progress`);
      }
    }
  }

  const live = [];
  for (const [id, tracker] of [...watcher.trackers]) {
    const summary = byId.get(id);
    if (!summary) {
      watcher.trackers.delete(id);
      watcher.say("INFO", `session ${id} no longer exists — not watching it any more`);
      continue;
    }
    if (summary.seq < tracker.afterSeq) Object.assign(tracker, { afterSeq: 0, backfilling: true, tools: new Map(), finished: [] });

    const findings = [];
    // 已经结束的会话不必再读事件；结束后又被补发消息而重新活跃时，从上次读到的位置接着读。
    if (summary.seq > tracker.afterSeq && (!isSettled(summary) || tracker.backfilling)) {
      try {
        const query = tracker.afterSeq === 0 ? `?after=0&limit=${BACKLOG_EVENTS}` : `?after=${tracker.afterSeq}`;
        const { events } = await watcher.fetchJson(watcher.service, `/sessions/${encodeURIComponent(id)}/events${query}`);
        findings.push(...ingest(tracker, events ?? [], { rules: watcher.rules, now }));
      } catch {
        // 这一轮读不到就下一轮再读；会话真的没有了，上面的列表检查会说。
      }
    }
    findings.push(...inspect(tracker, summary, { now, capacity }), ...settle(tracker, summary, now));
    emit(watcher, tracker, summary, findings);
    live.push([tracker, summary]);
  }

  if (options.tick > 0 && now - watcher.lastTick >= options.tick * 60_000) {
    watcher.lastTick = now;
    const count = (...phases) => live.filter(([, summary]) => phases.includes(summary.phase)).length;
    const other = live.length - count("starting", "running", "queued", "done");
    watcher.say("TICK", `watching ${live.length} · running ${count("starting", "running")} · queued ${count("queued")} · finished ${count("done")} · other ${other} · service ok`);
  }

  if (options.once) return done({ exit: 0 });
  if (!keepAlive && live.length === 0) {
    // 盯着的会话都被删掉了。
    watcher.say("INFO", "nothing left to watch; the watcher is exiting");
    return done({ exit: 0 });
  }
  if (!keepAlive && live.every(([tracker, summary]) => settledForExit(tracker, summary, now))) {
    watcher.say("INFO", `all ${live.length} watched session${live.length === 1 ? "" : "s"} ${live.length === 1 ? "has" : "have"} finished; the watcher is exiting`);
    return done({ exit: 0 });
  }
  return done({});
}

/**
 * 一次巡检。返回 `{ exit }` 表示该结束了（退出码），否则 `{}`。
 * --wake 时：这一遍之后若有 [DONE] / [ALERT]，再等 --wake-batch 秒把同一时刻到的几条一并带上，补一行 [WAKE] 摘要，以退出码 10 退出。
 */
export async function pass(watcher) {
  const first = await scan(watcher);
  const { options } = watcher;
  if (!options.wake || first.exit !== undefined || watcher.waking.length === 0) return first;

  let last = {};
  if (options.wakeBatch > 0) {
    await watcher.sleep(options.wakeBatch * 1000);
    last = await scan(watcher);
  }
  const finished = watcher.waking.filter((tag) => tag === "DONE").length;
  const attention = watcher.waking.length - finished;
  watcher.waking = [];
  const counts = [...(finished > 0 ? [`${finished} finished`] : []), ...(attention > 0 ? [`${attention} attention`] : [])].join(", ");
  const advice = `handle ${finished + attention === 1 ? "it" : "them"}, then start this watcher again with the same arguments`;
  const hint = options.state ? "" : "; pass --state <file> next time so a restart does not repeat what it already told you";
  watcher.say("WAKE", `${counts} — ${advice}${hint}.`);
  return { exit: last.exit ?? WAKE_EXIT };
}

// ───────────────────────── 入口 ─────────────────────────

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** `deps` 与 createWatcher 的相同（测试用，比如换掉 sleep 与 now，就不必等真实的时间）。 */
export async function main(argv, env = process.env, deps = {}) {
  const { options, errors } = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n\n${USAGE}\n`);
    return 2;
  }
  let rules = NO_RULES;
  if (options.rules) {
    try {
      rules = loadRules(options.rules);
    } catch (error) {
      process.stderr.write(`Cannot use --rules ${options.rules}: ${error.message}\n`);
      return 2;
    }
  }
  if (options.state) {
    const problem = checkStatePath(options.state);
    if (problem) {
      process.stderr.write(`Cannot use --state ${options.state}: ${problem}\n`);
      return 2;
    }
  }
  const watcher = createWatcher(options, { env, rules, ...deps });
  for (;;) {
    let result;
    try {
      result = await pass(watcher);
    } catch (error) {
      watcher.say("INFO", `a pass failed and was skipped: ${clip(error?.message ?? error, 160)}`);
      result = {};
    }
    if (result.exit !== undefined) return result.exit;
    await watcher.sleep(options.interval * 1000);
  }
}

function runAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  // 读输出的一方走了（管道关闭）就不必再盯了。
  process.stdout.on("error", () => process.exit(0));
  main(process.argv.slice(2)).then(
    async (code) => {
      // 等输出写完再退出；keep-alive 的连接会让进程多挂几秒，所以显式退出。
      await new Promise((done) => process.stdout.write("", done));
      process.exit(code);
    },
    (error) => {
      process.stderr.write(`watch.mjs: ${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
