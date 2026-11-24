/**
 * 会话报告：把一个会话（或一棵任务树）的真实记录渲染成一份干净的 Markdown，方便存档、贴进 PR 说明或发给别人复盘。
 *
 * 纯函数，不碰 Node API，也不读时钟（导出时刻由调用方传入）：服务端的 HTTP 路由、MCP 的 `read` 视图与网页共用这一份渲染，
 * 同一份输入永远得到同一份输出（排序一律按字符串码元比较，不依赖 locale）。
 *
 * 真实性：报告里的每一句都是从已记录的事件里**原文引用或计数**得到的——委派原文、命令行、
 * 路径、回答、消息都原样引用；“关键步骤”由 report-facts 里写死的规则挑出；不做摘要、不做推断、不让模型改写；推理内容从不收录。
 * 做不到的事如实写出（没有最终回答、费用未上报、某处被截断了多少字符），绝不编造成功的叙述。
 *
 * 模块划分（按职责，各自只依赖前面的）：
 * - report-options：范围 / 详细程度 / 语言、字符上限、预算收紧的阶梯——没有渲染器依赖，HTTP 校验与网页只需要它；
 * - report-labels：英文与中文的固定措辞，以及枚举值到措辞的映射；
 * - report-markdown：Markdown 原语（转义、围栏、表格、截断）与带截断提示的“引用”；
 * - report-facts：从事件日志里**一次性**整理出一个会话的事实（回放、按运行分组、回答、关键步骤、用量）；
 * - report-steps：会话片段里“过程”的行——逐条的步骤（含提问）、类别计数、散落条目与会话级的状态变化，只消费整理好的事实，只被 report-session 使用、不反向导入它；
 * - report-session：单个会话的片段，只消费整理好的事实；
 * - 本文件：任务树的先后、字符预算怎么分与收紧、整份报告的头尾，以及对外的导出。
 *
 * 版式取舍（都不是用户逐项确认的）：
 * - 所有“被引用的原文”一律放进围栏代码块：围栏长度总是比内容里最长的反引号串多一个（至少 3 个），所以原文里的 Markdown、
 *   HTML、未闭合的围栏都不会漏出来影响报告的版式；
 * - 表格只用于元信息与用量；路径、命令、标识用行内代码；不使用 HTML，不使用 emoji；
 * - 标题层级固定：scope=session 时 H1 报告标题、H2 各分节；scope=tree 时 H1、H2（概览 / 任务树 / 会话 / 用量 / 生成说明）、
 *   H3 每个会话、H4 会话内各分节、H5 运行与上下文。
 *
 * 字符数上限（maxChars）：渲染前先给每个会话分一份预算；放不下就按固定的阶梯逐级缩小各类引用的上限
 * （步骤条数、长文本、其余引用、工具输出、文件清单），并在对应位置写明；再放不下的会话整段略去并在任务树里标出；
 * 最后还有一道只裁剪正文的安全网。任何一处截断都有明文提示，不会悄悄发生。
 */

import type { EnsembleEvent } from "./events";
import { parentIdsOf } from "./lineage";
import { byText, prepareReportSession, sumRows } from "./report-facts";
import type { ReportSessionStats, UsageKey, UsageRow } from "./report-facts";
import type { ReportLabelKey } from "./report-labels";
import { code, costCell, cutMarkdown, durationCell, esc, heading, makeCtx, num, pushAll, tableLines, tokenCell, utc } from "./report-markdown";
import type { Ctx } from "./report-markdown";
import { LEVELS, REPORT_LIMITS, trimFor } from "./report-options";
import type { ReportOptions } from "./report-options";
import { formatSession, harnessText, phaseText, titleText } from "./report-session";
import type { SessionId, SessionPhase, SessionSummary } from "./types";

// 对外导出：下面这些原先都定义在本文件里，拆分之后改由各自的模块持有，这里原样转出，调用方不必改 import。
export { REPORT_LABELS } from "./report-labels";
export type { ReportLabelKey } from "./report-labels";
export { cutMarkdown } from "./report-markdown";
export { REPORT_DETAILS, REPORT_LANGS, REPORT_LIMITS, REPORT_SCOPES } from "./report-options";
export type { ReportDetail, ReportLang, ReportOptions, ReportScope } from "./report-options";

// ───────────────────────── 对外类型 ─────────────────────────

export interface ReportSessionInput {
  summary: SessionSummary;
  /** 这个会话的事件日志（按 seq 升序）；undefined = 没有读到。 */
  events: readonly EnsembleEvent[] | undefined;
}

export interface ReportInput extends ReportOptions {
  /** 以哪个会话为根；scope=session 只含它自己，scope=tree 含它名下的整棵子树。 */
  rootId: SessionId;
  sessions: readonly ReportSessionInput[];
}

// ───────────────────────── 任务树与分块构建 ─────────────────────────

/** 状态分布里各状态的固定先后。 */
const PHASE_ORDER: readonly SessionPhase[] = [
  "running", "starting", "queued", "ready", "done", "failed", "cancelled", "stopped", "lost",
];

interface Planned {
  summary: SessionSummary;
  /** 树里的编号：根是 "1"，它的第二个子会话是 "1.2"。 */
  number: string;
  depth: number;
}

/**
 * 展开顺序：先序；同一上级下按创建时间、再按 id（都按字符串码元比较，不依赖 locale）。
 * 汇聚节点（多个上级）在任务树里只出现一次：挂在它的上级里排在最前、又确实在这份报告里的那一个之下（通常就是第一个上级），
 * 别的上级在它自己的字段表里以“还跟随”一行写出，不在那些上级之下重复展开。
 */
function planOrder(rootId: SessionId, summaries: readonly SessionSummary[], tree: boolean): Planned[] {
  const byId = new Map<SessionId, SessionSummary>();
  for (const summary of summaries) byId.set(summary.id, summary);
  const root = byId.get(rootId);
  if (!root) return [];
  if (!tree) return [{ summary: root, number: "1", depth: 0 }];

  const children = new Map<SessionId, SessionSummary[]>();
  for (const summary of summaries) {
    if (summary.id === rootId) continue;
    const parent = parentIdsOf(summary).find((id) => id !== summary.id && byId.has(id));
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(summary);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => byText(a.createdAt, b.createdAt) || byText(a.id, b.id));
  }
  const out: Planned[] = [];
  const seen = new Set<SessionId>();
  const visit = (summary: SessionSummary, number: string, depth: number): void => {
    if (seen.has(summary.id)) return;
    seen.add(summary.id);
    out.push({ summary, number, depth });
    (children.get(summary.id) ?? []).forEach((child, index) => visit(child, `${number}.${index + 1}`, depth + 1));
  };
  visit(root, "1", 0);
  return out;
}

interface Slot extends Planned {
  /** pending = 还没轮到；rendered = 已有片段；omitted = 因预算不足而略去。 */
  state: "pending" | "rendered" | "omitted";
  /** 渲染了，但没有读到事件历史（只有概览）。 */
  unread: boolean;
  /** 渲染好的片段；只留文字与统计，不留会话历史（事实在 add 里整理、用完即放）。 */
  text: string;
  level: number;
  stats: ReportSessionStats | undefined;
}

/** 任务树目录最多占字符预算的这一份；放不下的会话在目录里合并成一句“另有 k 个”。 */
const DIRECTORY_SHARE = 0.25;

/** 头部与尾部（标题、概览、目录、用量总表、生成说明）预估要占的字符数；只用来给会话片段划预算，不求精确。 */
function reserveFor(count: number, tree: boolean, limit: number): number {
  const head = 800 + (tree ? Math.min(Math.floor(limit * DIRECTORY_SHARE), count * 240) + 700 : 0);
  const tail = 1_900 + (tree ? 260 * Math.min(count, 12) + 500 : 0);
  return head + tail;
}

/**
 * 分块构建报告：任务树里的会话一个一个来——调用方（HTTP 路由）读一个会话的事件、交给 add、放掉，再读下一个，
 * 不必把整棵树的事件同时放在内存里。预算耗尽后 wantsEvents() 变成 false，后面的会话连事件都不用读。
 *
 * 用法：new ReportBuilder(rootId, summaries, options)，然后按 `order` 的顺序对每个会话调 add（可先问 wantsEvents()），最后 build()。
 */
export class ReportBuilder {
  /** 会话在报告里的展开顺序（先序）；scope=session 时只有根。 */
  readonly order: readonly SessionSummary[];
  private readonly slots: Slot[];
  private readonly root: SessionSummary;
  private readonly options: ReportOptions;
  private readonly tree: boolean;
  private readonly titles: ReadonlyMap<SessionId, string>;
  private readonly limit: number;
  private readonly bodyBudget: number;
  private used = 0;
  private cursor = 0;

  constructor(rootId: SessionId, summaries: readonly SessionSummary[], options: ReportOptions) {
    const planned = planOrder(rootId, summaries, options.scope === "tree");
    const first = planned[0];
    if (!first) throw new Error(`report: session ${rootId} is not among the given summaries`);
    this.root = first.summary;
    this.options = options;
    this.tree = options.scope === "tree";
    // 报告自己包含的会话用自己的标题，盖过调用方给的引用。
    this.titles = new Map([...Object.entries(options.references ?? {}), ...summaries.map((summary): [SessionId, string] => [summary.id, summary.title])]);
    this.order = planned.map((entry) => entry.summary);
    this.slots = planned.map((entry): Slot => ({ ...entry, state: "pending", unread: false, text: "", level: 0, stats: undefined }));
    const raw = options.maxChars;
    this.limit = raw !== undefined && Number.isFinite(raw) ? Math.max(REPORT_LIMITS.minChars, Math.floor(raw)) : Number.POSITIVE_INFINITY;
    this.bodyBudget = Number.isFinite(this.limit) ? Math.max(0, this.limit - reserveFor(this.slots.length, this.tree, this.limit)) : Number.POSITIVE_INFINITY;
  }

  /**
   * 下一个会话还值得读事件吗？false = 预算已经用完，直接 add(id, undefined) 即可。
   * 根会话永远要读：上限很小而树很大时，头尾的预留可能把正文预算吃光，根会话也不该因此变成“没读到”。
   */
  wantsEvents(): boolean {
    if (this.cursor >= this.slots.length) return false;
    return this.cursor === 0 || this.bodyBudget - this.used >= REPORT_LIMITS.minSectionChars;
  }

  /** 交入下一个会话的事件（必须按 order 的顺序）；undefined = 没有读到（或预算已尽而没读）。 */
  add(sessionId: SessionId, events: readonly EnsembleEvent[] | undefined): void {
    const index = this.cursor;
    const slot = this.slots[index];
    if (!slot || slot.summary.id !== sessionId) {
      throw new Error(`report: expected session ${slot?.summary.id ?? "(none)"} next, got ${sessionId}`);
    }
    this.cursor += 1;
    const remaining = this.bodyBudget - this.used;
    // 预算已经不够展开一个会话了：整段略去（根会话除外，它总是要有的）。
    if (remaining < REPORT_LIMITS.minSectionChars && index > 0) {
      slot.state = "omitted";
      return;
    }

    // 这个会话的事实只在这里整理一次：回放日志、按运行分组、挑回答、分关键步骤、汇总用量都不随收紧的档位变化，
    // 五档预算共用同一份；渲染完 prepared 就随函数返回放掉，slot 里只留文字与统计，一次只有一个会话的历史在内存里。
    const prepared = prepareReportSession(slot.summary, events, this.options.detail);
    const ctx = makeCtx(this.options, this.tree, slot.number, this.titles);
    const share = Math.floor(remaining / (this.slots.length - index));
    let level = 0;
    let text = "";
    for (; level < LEVELS; level++) {
      text = formatSession(prepared, ctx, trimFor(this.options.detail, level), level, this.limit);
      if (text.length <= share) break;
    }
    if (level >= LEVELS) level = LEVELS - 1;
    // 根会话总是收下（超出的部分由最后的安全网处理）；其余会话在最紧的一级也放不进剩余预算时整段略去。
    if (index > 0 && text.length > remaining) {
      slot.state = "omitted";
      return;
    }
    slot.state = "rendered";
    slot.unread = events === undefined;
    slot.text = text;
    slot.level = level;
    slot.stats = prepared.stats;
    this.used += text.length + 2;
  }

  build(): string {
    const ctx = makeCtx(this.options, this.tree, "", this.titles);
    const headText = this.headLines(ctx).join("\n");
    const tailText = this.tailLines(ctx).join("\n");
    let bodyText = this.bodyLines(ctx).join("\n\n");
    const glue = 2 * 2 + 1;
    if (Number.isFinite(this.limit) && headText.length + bodyText.length + tailText.length + glue > this.limit) {
      const note = `> ${ctx.t("cutReport", { limit: num(this.limit) })}`;
      const allowed = this.limit - headText.length - tailText.length - glue - note.length - 2;
      if (allowed >= 200) {
        bodyText = `${cutMarkdown(bodyText, allowed)}\n\n${note}`;
      } else {
        // 头尾加起来就已经超过上限（极端的大树）：只好对整份文档做截断。
        const whole = [headText, bodyText, tailText].filter((part) => part !== "").join("\n\n");
        return `${cutMarkdown(whole, this.limit - note.length - glue)}\n\n${note}\n`;
      }
    }
    return `${[headText, bodyText, tailText].filter((part) => part.trim() !== "").join("\n\n")}\n`;
  }

  // ── 头部：标题、（树的）总览与目录 ──

  private headLines(c: Ctx): string[] {
    const title = titleText(c, this.root.title);
    const out: string[] = [
      heading(1, c.t(this.tree ? "h1Tree" : "h1Session", { title })),
      "",
      c.t("kicker", { time: utc(this.options.exportedAt), version: esc(this.options.version), scope: this.options.scope, detail: this.options.detail }),
    ];
    if (!this.tree) return out;
    out.push("", heading(2, c.t("overview")), "");
    pushAll(out, this.treeOverview(c));
    out.push("", heading(2, c.t("tree")), "");
    pushAll(out, this.directory(c));
    out.push("", heading(2, c.t("sessions")));
    return out;
  }

  private treeOverview(c: Ctx): string[] {
    const rows: string[][] = [];
    const add = (key: ReportLabelKey, value: string): void => {
      rows.push([c.t(key), value]);
    };
    const total = this.slots.length;
    const rendered = this.slots.filter((slot) => slot.state === "rendered");
    const notIncluded = total - rendered.length;
    let runs = 0;
    let updatedAt = this.root.updatedAt;
    const phases = new Map<SessionPhase, number>();
    for (const slot of this.slots) {
      runs += slot.summary.runCount;
      if (slot.summary.updatedAt > updatedAt) updatedAt = slot.summary.updatedAt;
      phases.set(slot.summary.phase, (phases.get(slot.summary.phase) ?? 0) + 1);
    }
    const statuses = PHASE_ORDER.filter((phase) => phases.has(phase)).map((phase) => `${phaseText(c, phase)} ${phases.get(phase) ?? 0}`);
    const runTime = sumRows(rendered.map((slot): UsageRow => slot.stats?.usage ?? {})).total.ms;
    const paths = new Set<string>();
    for (const slot of rendered) for (const path of slot.stats?.files ?? []) paths.add(path);

    add("fRootSession", `${titleText(c, this.root.title)} (${code(this.root.id)})`);
    add("fSessionCount", `${total}${notIncluded > 0 ? ` (${c.t("sessionsNotIncluded", { n: notIncluded })})` : ""}`);
    add("fRuns", String(runs));
    if (statuses.length > 0) add("fStatuses", statuses.join(c.sep));
    add("fRunTimeSum", durationCell(runTime));
    add("fCreated", utc(this.root.createdAt));
    add("fActivity", utc(updatedAt));
    add("fFilesCount", String(paths.size));
    return tableLines([c.t("colField"), c.t("colValue")], rows);
  }

  private directory(c: Ctx): string[] {
    const budget = Number.isFinite(this.limit) ? Math.floor(this.limit * DIRECTORY_SHARE) : Number.POSITIVE_INFINITY;
    const lines: string[] = [];
    let size = 0;
    let listed = 0;
    for (const slot of this.slots) {
      const summary = slot.summary;
      const runTime = slot.stats?.usage.ms;
      let line = `${"  ".repeat(slot.depth)}- ${slot.number} ${titleText(c, summary.title)} — ${harnessText(c, summary)} · ${phaseText(c, summary.phase)} · ${durationCell(runTime)} · ${code(summary.id)}`;
      if (slot.state !== "rendered") line += ` — ${c.t("dirOmitted")}`;
      else if (slot.unread) line += ` — ${c.t("dirUnread")}`;
      // 根总是列出；其余的在目录超出它那份预算后合并成一句。
      if (listed > 0 && size + line.length + 1 > budget) break;
      lines.push(line);
      size += line.length + 1;
      listed += 1;
    }
    if (listed < this.slots.length) lines.push(`- ${c.t("dirMore", { n: this.slots.length - listed })}`);
    return lines;
  }

  // ── 正文：各会话的片段 ──

  private bodyLines(c: Ctx): string[] {
    const out: string[] = [];
    let omitted = 0;
    for (const slot of this.slots) {
      if (slot.state === "rendered") out.push(slot.text);
      else omitted += 1;
    }
    if (omitted > 0 && this.tree) out.push(c.t("sessionsOmitted", { n: omitted, limit: num(this.limit) }));
    return out;
  }

  // ── 尾部：（树的）用量总表与生成说明 ──

  private tailLines(c: Ctx): string[] {
    const out: string[] = [];
    const rendered = this.slots.filter((slot) => slot.state === "rendered");
    if (this.tree) {
      pushAll(out, this.usageAll(c, rendered));
      out.push("");
    }
    out.push(heading(2, c.t("notes")), "");

    let events = 0;
    let shortened = 0;
    for (const slot of rendered) {
      events += slot.stats?.events ?? 0;
      if (slot.level > 0) shortened += 1;
    }
    const base = trimFor(this.options.detail, 0);
    const bullets = [
      c.t("nSource", { version: esc(this.options.version), time: utc(this.options.exportedAt), events: num(events), sessions: rendered.length }),
      c.t("nFacts"),
      this.options.detail === "full"
        ? c.t("nFull", { block: num(base.block), output: num(base.output) })
        : c.t("nBrief", { steps: num(base.steps) }),
      c.t("nExcluded"),
      c.t("nFiles"),
      c.t("nVerbatim"),
      c.t("nUnits"),
    ];
    if (shortened > 0) bullets.push(c.t("nTrimmed", { limit: num(this.limit), n: shortened }));
    for (const bullet of bullets) out.push(`- ${bullet}`);
    return out;
  }

  private usageAll(c: Ctx, rendered: readonly Slot[]): string[] {
    const out = [heading(2, c.t("usageAll")), ""];
    const rows: string[][] = [];
    const usages: UsageRow[] = [];
    const partialAll = new Set<UsageKey>();
    for (const slot of rendered) {
      const usage: UsageRow = slot.stats?.usage ?? {};
      usages.push(usage);
      for (const key of slot.stats?.partial ?? []) partialAll.add(key);
      rows.push([
        `${slot.number} ${titleText(c, slot.summary.title)}`,
        tokenCell(c, usage.input, false),
        tokenCell(c, usage.output, false),
        tokenCell(c, usage.cached, false),
        tokenCell(c, usage.reasoning, false),
        costCell(c, usage.cost, false),
        durationCell(usage.ms),
      ]);
    }
    const { total, partial } = sumRows(usages);
    for (const key of partial) partialAll.add(key);
    rows.push([
      c.t("uTotal"),
      tokenCell(c, total.input, partialAll.has("input")),
      tokenCell(c, total.output, partialAll.has("output")),
      tokenCell(c, total.cached, partialAll.has("cached")),
      tokenCell(c, total.reasoning, partialAll.has("reasoning")),
      costCell(c, total.cost, partialAll.has("cost")),
      durationCell(total.ms),
    ]);
    const header = [c.t("uSession"), c.t("uInput"), c.t("uOutput"), c.t("uCached"), c.t("uReasoning"), c.t("uCost"), c.t("uDuration")];
    pushAll(out, tableLines(header, rows, [1, 2, 3, 4, 5, 6]));
    if ([...partialAll].some((key) => key !== "ms")) out.push("", c.t("uPartial"));
    out.push("", c.t("uNote"));
    return out;
  }
}

/** 一次性渲染：事件已经全部在内存里时用它（测试、网页、MCP）；按需分块读取的调用方直接用 ReportBuilder。 */
export function renderReport(input: ReportInput): string {
  const builder = new ReportBuilder(input.rootId, input.sessions.map((entry) => entry.summary), input);
  const events = new Map<SessionId, readonly EnsembleEvent[] | undefined>();
  for (const entry of input.sessions) events.set(entry.summary.id, entry.events);
  for (const summary of builder.order) builder.add(summary.id, events.get(summary.id));
  return builder.build();
}
