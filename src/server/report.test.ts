import { describe, expect, it, vi } from "vitest";
import { REPORT_LIMITS } from "@shared/report";
import type { ReportOptions } from "@shared/report";
import { DAY, lazyHub, NOW, seed, SpyStore } from "./history-fixtures";
import type { SessionFixture } from "./history-fixtures";
import { buildSessionReport, reportDisposition, reportFilename, reportSummaries } from "./report";

const options = (overrides: Partial<ReportOptions> = {}): ReportOptions => ({
  scope: "tree",
  detail: "brief",
  lang: "en",
  exportedAt: "2026-06-02T00:00:00.000Z",
  version: "9.9.9",
  ...overrides,
});

/**
 * a ─┬─ b ── d
 *    └─ c
 * 创建时间依次递增：树里的次序是 a、b、d（b 的子会话）、c。都比保温期老得多，懒加载启动时会被冻结成冷会话。
 */
const TREE: SessionFixture[] = [
  { id: "ses_a", at: NOW - 30 * DAY, meta: { title: "Root" } },
  { id: "ses_b", at: NOW - 29 * DAY, parent: "ses_a", depth: 1, meta: { title: "Child B" } },
  { id: "ses_c", at: NOW - 28 * DAY, parent: "ses_a", depth: 1, meta: { title: "Child C" } },
  { id: "ses_d", at: NOW - 27 * DAY, parent: "ses_b", depth: 2, meta: { title: "Grandchild" } },
];

/** 同一份存储上的两个中枢：一个全部在内存里（热），一个把过了保温期的会话冻结成冷会话。 */
async function hotAndCold(fixtures: readonly SessionFixture[]) {
  const store = new SpyStore();
  const written = await seed(store, fixtures);
  const hot = lazyHub(store, { now: NOW }, { mode: "eager" });
  await hot.load();
  const cold = lazyHub(store, { now: NOW });
  await cold.load();
  return { store, written, hot, cold };
}

describe("reportSummaries", () => {
  it("is the session alone for scope=session, and its whole subtree for scope=tree", async () => {
    const { cold } = await hotAndCold(TREE);
    expect(reportSummaries(cold, "ses_a", "session").map((summary) => summary.id)).toEqual(["ses_a"]);
    expect(reportSummaries(cold, "ses_a", "tree").map((summary) => summary.id).sort()).toEqual(["ses_a", "ses_b", "ses_c", "ses_d"]);
    expect(reportSummaries(cold, "ses_b", "tree").map((summary) => summary.id).sort()).toEqual(["ses_b", "ses_d"]);
    expect(reportSummaries(cold, "ses_d", "tree").map((summary) => summary.id)).toEqual(["ses_d"]);
  });

  it("keeps descendants that were archived: archiving decides what the default view shows, not what the data is", async () => {
    const { cold } = await hotAndCold(TREE);
    await cold.setArchived(["ses_c"], { archivedAt: new Date(NOW).toISOString(), by: "user" });
    expect(cold.summary("ses_c")?.archivedAt).toBeDefined();
    expect(reportSummaries(cold, "ses_a", "tree").map((summary) => summary.id).sort()).toEqual(["ses_a", "ses_b", "ses_c", "ses_d"]);
  });

  it("is empty for a session that does not exist", async () => {
    const { cold } = await hotAndCold(TREE);
    expect(reportSummaries(cold, "ses_nope", "tree")).toEqual([]);
    expect(reportSummaries(cold, "ses_nope", "session")).toEqual([]);
  });
});

describe("buildSessionReport", () => {
  it("gives a cold session the same report as a hot one, and does not thaw it by reading", async () => {
    const { hot, cold } = await hotAndCold(TREE);
    for (const { id } of TREE) {
      expect(hot.isHot(id), `${id} hot`).toBe(true);
      expect(cold.isHot(id), `${id} cold`).toBe(false);
    }
    for (const scope of ["session", "tree"] as const) {
      for (const detail of ["brief", "full"] as const) {
        const fromHot = await buildSessionReport(hot, "ses_a", options({ scope, detail }));
        const fromCold = await buildSessionReport(cold, "ses_a", options({ scope, detail }));
        expect(fromCold, `${scope}/${detail}`).toBe(fromHot);
      }
    }
    for (const { id } of TREE) expect(cold.isHot(id), `${id} still cold`).toBe(false);
  });

  it("numbers the tree the way the web shows it: by creation time under each parent", async () => {
    const { cold } = await hotAndCold(TREE);
    const markdown = await buildSessionReport(cold, "ses_a", options());
    const headings = markdown.split("\n").filter((line) => /^### \d/.test(line));
    expect(headings).toEqual(["### 1 Root", "### 1.1 Child B", "### 1.1.1 Grandchild", "### 1.2 Child C"]);
  });

  it("gives an archived session the same report as before it was archived", async () => {
    const { cold } = await hotAndCold(TREE);
    const before = await buildSessionReport(cold, "ses_a", options());
    await cold.setArchived(["ses_b", "ses_d"], { archivedAt: new Date(NOW).toISOString(), by: "user" });
    expect(cold.summary("ses_b")?.archivedAt).toBeDefined();
    expect(await buildSessionReport(cold, "ses_a", options())).toBe(before);
    // 单独导出一个已归档的会话也行。
    expect(await buildSessionReport(cold, "ses_b", options({ scope: "session" }))).toContain("# Session report: Child B");
  });

  it("rejects a session that does not exist with not_found", async () => {
    const { cold } = await hotAndCold(TREE);
    await expect(buildSessionReport(cold, "ses_nope", options())).rejects.toMatchObject({ code: "not_found" });
  });

  it("is read-only: the stored logs and the sessions' sequence numbers are exactly what they were", async () => {
    const { store, written, cold } = await hotAndCold(TREE);
    const seqBefore = TREE.map(({ id }) => cold.summary(id)?.seq);
    await buildSessionReport(cold, "ses_a", options({ detail: "full" }));
    await buildSessionReport(cold, "ses_a", options({ scope: "session", lang: "zh" }));
    for (const [id, events] of written) expect(await store.load(id), id).toEqual(events);
    expect(TREE.map(({ id }) => cold.summary(id)?.seq)).toEqual(seqBefore);
  });

  it("stops reading logs once the character budget is gone: a big tree with the smallest limit reads only the root", async () => {
    const kids: SessionFixture[] = Array.from({ length: 40 }, (_, index) => ({
      id: `ses_k${String(index).padStart(2, "0")}`,
      at: NOW - 50 * DAY + index * 1000,
      parent: "ses_root",
      depth: 1,
    }));
    const store = new SpyStore();
    await seed(store, [{ id: "ses_root", at: NOW - 60 * DAY }, ...kids]);
    const hub = lazyHub(store, { now: NOW });
    await hub.load();
    expect(hub.counts()).toEqual({ total: 41, hot: 0, archived: 0 });
    store.logReads.length = 0;
    const read = vi.spyOn(hub, "readEvents");

    const small = await buildSessionReport(hub, "ses_root", options({ maxChars: REPORT_LIMITS.minChars }));
    expect(small.length).toBeLessThanOrEqual(REPORT_LIMITS.minChars);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("ses_root");
    expect(store.logReads).toEqual(["ses_root"]);

    // 对照：不设上限时每个会话都要读。
    read.mockClear();
    await buildSessionReport(hub, "ses_root", options());
    expect(read).toHaveBeenCalledTimes(41);
  });
});

describe("reportFilename", () => {
  const name = (title: string, scope: "session" | "tree" = "session", detail: "brief" | "full" = "brief", id = "ses_01abc") =>
    reportFilename({ id, title }, { scope, detail });

  it("is <title>-<id>.md, with a suffix for the tree and for the full version", () => {
    expect(name("Refactor the parser").utf8).toBe("Refactor-the-parser-ses_01abc.md");
    expect(name("Refactor the parser", "tree").utf8).toBe("Refactor-the-parser-ses_01abc-tree.md");
    expect(name("Refactor the parser", "session", "full").utf8).toBe("Refactor-the-parser-ses_01abc-full.md");
    expect(name("Refactor the parser", "tree", "full").utf8).toBe("Refactor-the-parser-ses_01abc-tree-full.md");
    expect(name("Refactor the parser").ascii).toBe(name("Refactor the parser").utf8);
  });

  it("turns characters Windows does not allow in a file name into hyphens", () => {
    expect(name('a<b>c:d"e/f\\g|h?i*j').utf8).toBe("a-b-c-d-e-f-g-h-i-j-ses_01abc.md");
  });

  it("drops control characters and the format characters that can disguise an extension", () => {
    expect(name("evil\u202Etxt.exe\u0007name").utf8).toBe("evil-txt.exe-name-ses_01abc.md");
    expect(name("zero\u200Bwidth\uFEFFjoin").utf8).toBe("zero-width-join-ses_01abc.md");
  });

  it("does not start or end with dots, hyphens or underscores, and never writes a path", () => {
    expect(name("  ..hidden.. ").utf8).toBe("hidden-ses_01abc.md");
    expect(name("__x__").utf8).toBe("x-ses_01abc.md");
    expect(name("T", "session", "brief", "ses/../x").utf8).toBe("T-ses-..-x.md");
  });

  it("falls back to 'session' when no usable character is left", () => {
    expect(name("").utf8).toBe("session-ses_01abc.md");
    expect(name("???").utf8).toBe("session-ses_01abc.md");
    expect(name("   ").ascii).toBe("session-ses_01abc.md");
  });

  it("keeps non-ASCII titles in the UTF-8 name and gives older clients an ASCII fallback", () => {
    expect(name("重构解析器").utf8).toBe("重构解析器-ses_01abc.md");
    expect(name("重构解析器").ascii).toBe("session-ses_01abc.md");
    expect(name("重构 parser 解析").utf8).toBe("重构-parser-解析-ses_01abc.md");
    expect(name("重构 parser 解析").ascii).toBe("parser-ses_01abc.md");
  });

  it("cuts a long title at 48 code points without splitting a character", () => {
    expect(name("x".repeat(100)).utf8).toBe(`${"x".repeat(48)}-ses_01abc.md`);
    const cjk = name("字".repeat(100)).utf8.replace(/-ses_01abc\.md$/, "");
    expect(Array.from(cjk)).toHaveLength(48);
    const emoji = name("😀".repeat(100)).utf8.replace(/-ses_01abc\.md$/, "");
    expect(Array.from(emoji)).toHaveLength(48);
    expect(emoji).toBe("😀".repeat(48));
  });

  it("copes with a lone surrogate: it is dropped, and the header can still be built", () => {
    const lone = name("a\uD800b");
    expect(lone.utf8).toBe("a-b-ses_01abc.md");
    expect(() => reportDisposition(lone)).not.toThrow();
    expect(reportDisposition(lone)).toBe('attachment; filename="a-b-ses_01abc.md"');
  });
});

describe("reportDisposition", () => {
  const header = (title: string) => reportDisposition(reportFilename({ id: "ses_01abc", title }, { scope: "session", detail: "brief" }));

  it("is a plain attachment with one filename when the name is ASCII", () => {
    expect(header("Refactor the parser")).toBe('attachment; filename="Refactor-the-parser-ses_01abc.md"');
  });

  it("adds an RFC 5987 filename* with the characters that encodeURIComponent leaves alone encoded too", () => {
    expect(header("é it's (ok)")).toBe(`attachment; filename="it's-(ok)-ses_01abc.md"; filename*=UTF-8''%C3%A9-it%27s-%28ok%29-ses_01abc.md`);
  });

  it("does not let a percent sign through in the ASCII name, but keeps it, encoded, in filename*", () => {
    expect(header("100% done")).toBe(`attachment; filename="100-done-ses_01abc.md"; filename*=UTF-8''100%25-done-ses_01abc.md`);
  });

  it("encodes a Chinese title as UTF-8", () => {
    expect(header("重构")).toBe(`attachment; filename="session-ses_01abc.md"; filename*=UTF-8''%E9%87%8D%E6%9E%84-ses_01abc.md`);
  });

  it("never lets a quote, a backslash or a line break into the header", () => {
    const value = header('say "hi"\r\nSet-Cookie: x=1\\');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.match(/"/g)).toHaveLength(2);
    expect(value).not.toContain("\\");
  });
});
