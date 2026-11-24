/**
 * 会话报告的服务端部分：收集要导出的会话、按需逐个读取事件交给渲染器，以及下载用的文件名。
 *
 * 渲染本身是 `shared/report.ts` 里的纯函数（网页、HTTP 路由与 MCP 共用同一份）；这里只负责取数，而且全程只读——
 * 不写、不删、不改写任何会话记录，也不解冻冷会话：冷的、已归档的会话读的就是它们磁盘上的事件日志，
 * 与热会话走同一条 `hub.readEvents`，所以内容与归档前、冻结前一致。
 */

import { parentIdsOf } from "@shared/lineage";
import { ReportBuilder } from "@shared/report";
import type { ReportDetail, ReportOptions, ReportScope } from "@shared/report-options";
import type { SessionId, SessionSummary } from "@shared/types";
import { EnsembleError } from "./errors";
import type { EventHub } from "./hub";

/**
 * 以 rootId 为根、要写进报告的会话摘要。scope=session 只有它自己；scope=tree 是它名下的整棵子树（含已归档的后代：
 * 归档只决定默认视图里看不看得见，不是数据的一部分，导出的内容不该因为谁被归档而变）。
 * 根不存在时返回空数组。有 seen 兜底：数据被改坏出现环时也不会死循环，汇聚节点（多个上级）经由哪条路走到都只收一次。
 */
export function reportSummaries(hub: EventHub, rootId: SessionId, scope: ReportScope): SessionSummary[] {
  const root = hub.summary(rootId);
  if (!root) return [];
  if (scope === "session") return [root];

  const out: SessionSummary[] = [];
  const seen = new Set<SessionId>();
  const pending: SessionSummary[] = [root];
  while (pending.length > 0) {
    const summary = pending.pop();
    if (!summary || seen.has(summary.id)) continue;
    seen.add(summary.id);
    out.push(summary);
    for (const childId of summary.childIds) {
      const child = seen.has(childId) ? undefined : hub.summary(childId);
      if (child) pending.push(child);
    }
  }
  return out;
}

/**
 * 渲染一份报告。大树按会话逐个读取、逐个交给渲染器，读完一个就放掉它的事件，不会把整棵树的事件同时放在内存里；
 * 字符预算用完之后连事件都不再读（冷会话的日志要从磁盘读，不该为了一份已经放不下的内容读遍整棵树）。
 * 根会话不存在时抛 not_found（路由通常已先查过，这里挡的是查与读之间被删除的竞态）。
 */
export async function buildSessionReport(hub: EventHub, rootId: SessionId, options: ReportOptions): Promise<string> {
  const summaries = reportSummaries(hub, rootId, options.scope);
  if (summaries.length === 0) throw new EnsembleError("not_found", `Session ${rootId} does not exist.`);
  // 汇聚节点还跟随的别的上级可能在这份报告之外：只取它们的标题（索引里读，不解冻），让“还跟随”一行写出 id 与标题。
  const included = new Set(summaries.map((summary) => summary.id));
  const references: Record<SessionId, string> = {};
  for (const summary of summaries) {
    for (const id of parentIdsOf(summary)) {
      if (included.has(id) || id in references) continue;
      const title = hub.summary(id)?.title;
      if (title !== undefined) references[id] = title;
    }
  }
  const builder = new ReportBuilder(rootId, summaries, Object.keys(references).length > 0 ? { references, ...options } : options);
  for (const summary of builder.order) {
    const events = builder.wantsEvents() ? await hub.readEvents(summary.id) : undefined;
    builder.add(summary.id, events);
  }
  return builder.build();
}

// ───────────────────────── 下载文件名 ─────────────────────────

/** 文件名里标题部分最多保留的字符数（按码点数，不会切开代理对）：中文标题按 UTF-8 也不过 150 字节，加上编号与后缀远低于常见文件系统的 255。 */
const SLUG_MAX_CODE_POINTS = 48;

/**
 * 不能出现在文件名里的字符：Windows 不允许的 `< > : " / \ | ? *`、控制字符（含 DEL 与 C1）、落单的代理码元（编码成 UTF-8 会出错），
 * 以及零宽字符、行 / 段分隔符与会改变显示方向的格式字符——后者能把扩展名伪装成别的东西。
 */
function isUnsafeFilenameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    '<>:"/\\|?*'.includes(char)
  );
}

/** 不以点、连字符或下划线开头或结尾（Windows 不接受以点结尾的文件名，开头的点又会变成隐藏文件）。 */
function trimSeparators(text: string): string {
  return text.replace(/^[.\-_]+/, "").replace(/[.\-_]+$/, "");
}

/** 把一段文字变成文件名里可用的一节：不安全字符与空白一律折成一个连字符，超长截断。可能得到空串。 */
function filenamePart(text: string): string {
  const spaced = Array.from(text)
    .map((char) => (isUnsafeFilenameChar(char) ? " " : char))
    .join("");
  const dashed = trimSeparators(spaced.trim().replace(/\s+/g, "-"));
  return trimSeparators(Array.from(dashed).slice(0, SLUG_MAX_CODE_POINTS).join(""));
}

/** ASCII 回退名里允许的字符：可打印的 ASCII，去掉 `%`（个别客户端会对 filename= 做百分号解码）。引号与反斜杠在前一步已去掉。 */
function asciiPart(text: string): string {
  return trimSeparators(
    Array.from(text)
      .filter((char) => char > " " && char <= "~" && char !== "%")
      .join(""),
  );
}

export interface ReportFilename {
  /** 完整文件名（可含非 ASCII 字符）。 */
  utf8: string;
  /** 只含 ASCII 的回退名：给只认 `filename=` 的客户端。 */
  ascii: string;
}

/**
 * 下载的文件名：`<标题>-<会话 id>[-tree][-full].md`。标题里不能用的字符折成连字符、超长截断，标题为空（或没有一个可用字符）时写 `session`；
 * 会话 id 保留完整，主 Agent 可以直接拿去 `read`。树与完整版带后缀，同一个会话的几份导出不会重名。
 */
export function reportFilename(summary: Pick<SessionSummary, "id" | "title">, options: { scope: ReportScope; detail: ReportDetail }): ReportFilename {
  const id = filenamePart(summary.id) || "session";
  const tail = `-${id}${options.scope === "tree" ? "-tree" : ""}${options.detail === "full" ? "-full" : ""}.md`;
  const slug = filenamePart(summary.title);
  return { utf8: `${slug || "session"}${tail}`, ascii: `${asciiPart(slug) || "session"}${tail}` };
}

/** RFC 5987 / 8187 的 `attr-char` 之外的字符都要百分号编码；`encodeURIComponent` 还会放过 `' ( ) *`，这里补上。 */
function encodeExtendedValue(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `Content-Disposition` 头：始终是附件；文件名含非 ASCII 字符时同时给 `filename*`（UTF-8），旧客户端读 ASCII 回退名。 */
export function reportDisposition(name: ReportFilename): string {
  const plain = `attachment; filename="${name.ascii}"`;
  return name.utf8 === name.ascii ? plain : `${plain}; filename*=UTF-8''${encodeExtendedValue(name.utf8)}`;
}
