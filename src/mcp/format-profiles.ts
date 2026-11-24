import { describeIssue, type FieldSource, type ProfileEcho, type ProfileField, type ProfileReportEntry, type ProfilesReport, type SkippedField } from "@shared/profiles";

/**
 * 委派角色在 MCP 输出里的文字：`delegate` 回执里的那一行，和 `harnesses` 里的角色清单。
 * 与 format.ts 一样：写给主模型看的英文、简短、一行一件事、只陈述事实；纯函数。
 * 单独成文件：format.ts 是各个工具共用的大文件，别的改动也在动它。
 */

const FIELDS: readonly ProfileField[] = ["harness", "model", "effort", "access"];
const SOURCES: readonly FieldSource[] = ["profile", "explicit", "default"];
const SOURCE_TEXT: Record<FieldSource, string> = { profile: "from the role", explicit: "from your call", default: "by default" };

function skippedText(item: SkippedField): string {
  const shown = `${item.field} "${item.value}"`;
  switch (item.why) {
    case "overridden":
      return `${shown} (you passed ${item.field === "access" ? "another access level" : `another ${item.field}`})`;
    case "other_harness":
      return `${shown} (it belongs to the role's harness, not the one you passed)`;
    case "other_model":
      return `${shown} (it belongs to the role's model, not the one you passed)`;
  }
}

/** `delegate` 回执里“这次用了哪个角色”：每个字段取自哪里，以及角色里写了但没有用上的取值（没有就一行）。 */
export function renderRoleEcho(echo: ProfileEcho): string[] {
  const groups = SOURCES.map((source) => ({ source, fields: FIELDS.filter((field) => echo.sources[field] === source) }))
    .filter((group) => group.fields.length > 0)
    .map((group) => `${group.fields.join(", ")} ${SOURCE_TEXT[group.source]}`);
  const lines = [`    role "${echo.name}": ${groups.join("; ")}.`];
  if (echo.skipped && echo.skipped.length > 0) lines.push(`    not applied from the role: ${echo.skipped.map(skippedText).join("; ")}.`);
  return lines;
}

const HEADER =
  "Roles — named configurations the user defined in Ensemble's settings. Pass a name as `profile` to `delegate`; anything you pass explicitly overrides the role, and a role that is not usable now is refused rather than replaced by defaults.";

function roleLine(entry: ProfileReportEntry): string {
  const { check } = entry;
  const effective = check.usable ? check.effective : undefined;
  const parts: string[] = [];
  if (entry.harness !== undefined) {
    parts.push(entry.harness);
    parts.push(
      entry.model !== undefined ? `model ${entry.model}` : effective?.model !== undefined ? `model ${effective.model} (default)` : "model not fixed",
    );
    if (entry.effort !== undefined) parts.push(`effort ${entry.effort}`);
    else if (effective?.effort !== undefined) parts.push(`effort ${effective.effort} (default)`);
    const level = entry.access ?? "full";
    const caveat = level === "read_only" && effective?.enforcement === "advisory" ? " (prompt-only)" : level === "read_only" && effective?.enforcement === "none" ? " (not enforced)" : "";
    parts.push(`access ${level}${entry.access === undefined ? " (default)" : ""}${caveat}`);
  }
  const verdict = check.usable ? "usable now" : `NOT usable now: ${describeIssue(check.issue)}`;
  return `• ${entry.name} — ${parts.length > 0 ? `${parts.join(" · ")} — ` : ""}${verdict}`;
}

/**
 * `harnesses` 里附在执行端清单后面的角色块。没有角色就什么也不输出（返回 undefined）：不写“No roles defined”，
 * 每个回合都会进上下文的字，没有就一个都不该有。设置文件读不了时是例外：那是“角色功能此刻不可用”，不是“没有角色”，要说。
 */
export function renderProfiles(report: ProfilesReport): string | undefined {
  if (report.unavailable) {
    return "Roles: unavailable — Ensemble could not read settings.json, so `profile` cannot be used until the user restores the file and restarts Ensemble. Delegation itself is refused until then, even with an explicit `harness`.";
  }
  if (report.entries.length === 0) return undefined;
  return [HEADER, ...report.entries.map(roleLine)].join("\n");
}

/** 结构化结果里的角色：配置原样给出，能用时再给实际会落成什么，不能用时给原因代码与原文。 */
export function profilesData(report: ProfilesReport): Record<string, unknown> | undefined {
  if (report.unavailable) return { profilesIssue: report.unavailable };
  if (report.entries.length === 0) return undefined;
  return {
    profiles: report.entries.map((entry) => ({
      name: entry.name,
      usable: entry.check.usable,
      ...(entry.invalid ? { invalid: entry.invalid } : {}),
      ...(entry.harness !== undefined ? { harness: entry.harness } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
      ...(entry.access !== undefined ? { access: entry.access } : {}),
      ...(entry.check.usable ? { effective: entry.check.effective } : { reason: entry.check.issue.reason, why: describeIssue(entry.check.issue) }),
    })),
  };
}
