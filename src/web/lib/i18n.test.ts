import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "./dict-en";
import { zh } from "./dict-zh";
import { detectLang, translate, type Dict, type Entry } from "./i18n";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !/^dict-/.test(name)) files.push(full);
  }
  return files;
}

const sources = sourceFiles(webRoot).map((file) => ({ file, text: readFileSync(file, "utf8") }));
const namespaces = new Set(Object.keys(zh).map((key) => key.split(".")[0]));

/** 源码里所有形如 "namespace.key" 的字符串字面量，且 namespace 是词典里存在的命名空间。 */
function referencedKeys(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/(["'])([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)\1/g)) {
      const key = match[2] as string;
      if (namespaces.has(key.split(".")[0] as string)) found.push({ key, file: file.slice(webRoot.length + 1) });
    }
  }
  return found;
}

interface Family {
  prefix: string;
  suffix?: string;
  values: readonly string[];
}

const ENFORCEMENT = ["enforced", "advisory", "none"];
const VERIFICATION = ["live", "declared", "none"];

/** 运行时按类型拼出的键族；这里逐一列出，保证每个取值两种语言都有文案。 */
const FAMILIES: Family[] = [
  { prefix: "access.", values: ["read_only", "full"] },
  {
    prefix: "activity.",
    values: ["starting", "queued", "ready", "working", "thinking", "writing", "tool", "idle", "done", "failed", "cancelled", "stopped", "lost"],
  },
  { prefix: "capMode.", values: ["immediate", "turn_boundary", "immediate_or_follow_up", "none", "queued_by_harness", "after_run"] },
  { prefix: "conn.", values: ["connecting", "live", "reconnecting", "offline"] },
  { prefix: "delivery.", values: ["recorded", "queued_ensemble", "queued_harness", "handed_off", "applied", "failed", "cancelled"] },
  { prefix: "delivery.step.", values: ["recorded", "handed_off", "applied"] },
  { prefix: "enforce.", values: ENFORCEMENT },
  { prefix: "enforce.tip.", values: ENFORCEMENT },
  { prefix: "file.", values: ["created", "modified", "deleted", "renamed"] },
  { prefix: "focus.tab.", values: ["timeline", "task", "summary", "info"] },
  { prefix: "git.part.", values: ["staged", "unstaged", "untracked", "conflicted"] },
  { prefix: "harness.", values: ["cursor", "codex", "pi", "claude", "opencode", "dsh", "fixture"] },
  { prefix: "harness.status.", values: ["ready", "needs_setup", "unavailable", "checking"] },
  { prefix: "msg.kind.", values: ["task", "steer", "follow_up"] },
  { prefix: "native.", values: ["cursor-agent", "codex-thread", "pi-session", "claude-session", "opencode-session", "dsh-session"] },
  { prefix: "origin.refLabel.", values: ["session", "thread", "conversation"] },
  { prefix: "origin.workspaceFrom.", values: ["host-record", "mcp-roots", "delegate-cwd"] },
  { prefix: "phase.", values: ["ready", "starting", "queued", "running", "done", "failed", "cancelled", "stopped", "lost"] },
  { prefix: "question.state.", values: ["open", "answered", "declined", "expired"] },
  { prefix: "question.expiry.", values: ["timeout", "withdrawn", "run_ended", "cancelled", "session_closed", "restarted", "not_waiting"] },
  { prefix: "queue.", values: ["run_in_progress", "turn_boundary", "session_starting", "capacity"] },
  { prefix: "run.marker.", values: ["queued", "started", "completed", "failed", "cancelled"] },
  { prefix: "tool.status.", values: ["running", "completed", "failed", "cancelled", "unfinished"] },
  { prefix: "verify.", values: VERIFICATION },
  { prefix: "verify.tip.", values: VERIFICATION },
];

/** 服务端会发出的、界面有本地化标题的状态码。 */
const KNOWN_CODES = [
  "cancel_failed",
  "cancel_unconfirmed",
  "process_exited",
  "run_ended",
  "service_restarted",
  "service_stopped",
  "model_not_found",
  "auth_failed",
  "rate_limited",
  "context_overflow",
  "provider_unavailable",
  "model_error",
  "sandbox_error",
  "policy_blocked",
  "fixture_failure",
  "fixture_error",
  "codex.sandbox_mismatch",
  "codex.default_model_unavailable",
  "codex.warning",
  "codex.config_warning",
  "codex.deprecation",
  "codex.guardian_warning",
  "codex.compacted",
  "codex.model_rerouted",
  "codex.world_writable",
  "codex.mcp_failed",
  "codex.unrequested_turn",
  "codex.retrying",
  "codex.question_unanswered",
  "codex.question_secret",
  "codex.elicitation_cancelled",
  "codex.unsupported_request",
  "pi.auto_retry",
  "pi.compaction",
  "pi.compaction_failed",
  "pi.extension_error",
  "pi.extension_dialog",
  "pi.extension_notify",
  "opencode.retry",
  "opencode.compaction",
  "opencode.compaction_failed",
  "opencode.permission_allowed",
  "opencode.permission_rejected",
  "opencode.question_unanswered",
  "opencode.interrupted",
  "invalid_request",
  "session_not_resumable",
  "steer_reverted",
  "steer_failed",
  "cursor.tools",
  "cursor.access_violation",
  "cursor.no_stream",
  "cursor.expired",
  "cursor.summary",
  "cursor.summary_failed",
  "cursor.task",
  "cursor.request",
];

const API_ERRORS = [
  "invalid_request",
  "not_found",
  "forbidden",
  "conflict",
  "harness_unavailable",
  "harness_needs_setup",
  "access_unsupported",
  "model_settings_unavailable",
  "model_not_allowed",
  "depth_exceeded",
  "session_closed",
  "session_not_resumable",
  "question_unsupported",
  "internal",
  "network",
];

const SETUP_CODES = [
  "codex_not_found",
  "codex_login_required",
  "codex_no_models",
  "codex_probe_failed",
  "pi_not_found",
  "pi_no_models",
  "pi_probe_failed",
  "claude_not_found",
  "claude_login_required",
  "claude_probe_failed",
  "claude_unsupported",
  "claude_persistence_disabled",
  "opencode_not_found",
  "opencode_unsupported",
  "opencode_no_models",
  "opencode_probe_failed",
  "dsh_not_found",
  "dsh_unsupported",
  "dsh_no_models",
  "dsh_probe_failed",
  "cursor_sdk_missing",
  "cursor_login_required",
  "cursor_auth_rejected",
  "cursor_no_models",
  "cursor_probe_failed",
  "probe_failed",
];

function usedVars(entry: Entry): Set<string> {
  if (typeof entry === "string") return new Set([...entry.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string));
  const seen = new Set<string>();
  const probe = new Proxy({} as Record<string, string | number>, {
    get(_target, property) {
      if (typeof property === "string") seen.add(property);
      return 1;
    },
  });
  entry(probe);
  return seen;
}

function render(dict: Dict, key: string, vars: Record<string, string | number>): string {
  const entry = dict[key];
  if (entry === undefined) throw new Error(`missing ${key}`);
  return typeof entry === "function" ? entry(vars) : entry.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

describe("词典", () => {
  it("中文与英文拥有完全相同的键", () => {
    const zhKeys = new Set(Object.keys(zh));
    const enKeys = new Set(Object.keys(en));
    expect([...zhKeys].filter((key) => !enKeys.has(key))).toEqual([]);
    expect([...enKeys].filter((key) => !zhKeys.has(key))).toEqual([]);
  });

  it("每条文案两种语言使用的占位符一致", () => {
    const mismatched: string[] = [];
    for (const key of Object.keys(zh)) {
      const a = [...usedVars(zh[key] as Entry)].sort().join(",");
      const b = [...usedVars(en[key] as Entry)].sort().join(",");
      if (a !== b) mismatched.push(`${key}: zh{${a}} en{${b}}`);
    }
    expect(mismatched).toEqual([]);
  });

  it("没有空文案，函数型文案在 0/1/多 个时都能返回文字", () => {
    const problems: string[] = [];
    for (const [name, dict] of [["zh", zh], ["en", en]] as const) {
      for (const key of Object.keys(dict)) {
        for (const n of [0, 1, 2, 11]) {
          const text = render(dict, key, { n, running: 1, max: 4, time: "x", host: "Codex", name: "Pi", id: "abc", code: 1, ready: 1, total: 3, model: "m", effort: "e", requested: "a", resolved: "b", headline: "h", reason: "r", who: "w", title: "t", current: 1, done: 1 });
          if (typeof text !== "string" || text.trim() === "") problems.push(`${name}:${key}@${n}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("英文文案里没有中文（有意保留的双语开关除外）", () => {
    // 设置里语言项的标签是有意保留的双语：看不懂当前界面语言的人也要找得到它。
    const allowed = new Set(["settings.language"]);
    const offenders = Object.entries(en)
      .filter(([key]) => !allowed.has(key))
      .filter(([, entry]) => /[\u3400-\u9fff]/.test(typeof entry === "function" ? entry({ n: 2, running: 1 }) : entry))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("源码里引用的每个键两种语言都有", () => {
    const missing = referencedKeys().filter(({ key }) => !(key in zh) || !(key in en));
    expect(missing).toEqual([]);
  });

  it("运行时拼出的键族覆盖所有取值", () => {
    const missing: string[] = [];
    for (const family of FAMILIES) {
      for (const value of family.values) {
        const key = `${family.prefix}${value}${family.suffix ?? ""}`;
        if (!(key in zh) || !(key in en)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("状态码、服务错误与引导提示都有本地化标题", () => {
    const missing = [
      ...KNOWN_CODES.map((code) => `code.${code}`),
      ...API_ERRORS.map((code) => `apiError.${code}`),
      ...SETUP_CODES.map((code) => `setup.${code}`),
    ].filter((key) => !(key in zh) || !(key in en));
    expect(missing).toEqual([]);
  });

  it("词典里没有再被引用的死键（动态键族与键表除外）", () => {
    const referenced = new Set(referencedKeys().map(({ key }) => key));
    const covered = new Set<string>();
    for (const family of FAMILIES) for (const value of family.values) covered.add(`${family.prefix}${value}${family.suffix ?? ""}`);
    for (const code of KNOWN_CODES) covered.add(`code.${code}`);
    for (const code of API_ERRORS) covered.add(`apiError.${code}`);
    for (const code of SETUP_CODES) covered.add(`setup.${code}`);
    // 键 `effort.*` 的取值由执行端给出，界面对未知取值回退到原文；`act.*` 在 text.ts 的键表里引用。
    const dynamicPrefixes = ["effort."];
    const dead = Object.keys(zh).filter((key) => !referenced.has(key) && !covered.has(key) && !dynamicPrefixes.some((prefix) => key.startsWith(prefix)));
    expect(dead).toEqual([]);
  });
});

describe("translate", () => {
  it("缺失的键原样返回键名，英文缺失时回退到中文", () => {
    expect(translate("zh", "no.such.key")).toBe("no.such.key");
    expect(translate("en", "no.such.key")).toBe("no.such.key");
  });

  it("替换占位符，缺少变量时保留占位符", () => {
    expect(translate("en", "time.minutes", { n: 3 })).toBe("3m ago");
    expect(translate("en", "time.minutes")).toBe("{n}m ago");
    expect(translate("zh", "time.minutes", { n: 3 })).toBe("3 分钟前");
  });

  it("英文按单复数选择词形", () => {
    expect(translate("en", "timeline.count", { n: 1 })).toBe("1 entry");
    expect(translate("en", "timeline.count", { n: 5 })).toBe("5 entries");
    expect(translate("zh", "timeline.count", { n: 3 })).toBe("3 条记录");
  });
});

describe("detectLang", () => {
  function setHint(content: string): void {
    const meta = document.createElement("meta");
    meta.name = "ensemble-lang";
    meta.content = content;
    document.head.append(meta);
  }

  afterEach(() => {
    localStorage.clear();
    document.head.querySelectorAll('meta[name="ensemble-lang"]').forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  it("用户明确切换过的语言优先于一切信号", () => {
    vi.stubGlobal("navigator", { language: "zh-CN", languages: ["zh-CN"] });
    setHint("zh");
    localStorage.setItem("ensemble.lang", "en");
    expect(detectLang()).toBe("en");
  });

  it("浏览器偏好或服务端提示任何一个指向中文就用中文", () => {
    vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US", "zh-CN"] });
    expect(detectLang()).toBe("zh");

    vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
    expect(detectLang()).toBe("en");
    setHint("zh");
    expect(detectLang()).toBe("zh");
  });

  it("没有任何中文信号时用英文", () => {
    vi.stubGlobal("navigator", { language: "fr-FR", languages: ["fr-FR"] });
    setHint("en");
    expect(detectLang()).toBe("en");
  });
});
