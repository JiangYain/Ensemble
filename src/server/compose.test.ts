import { handedOverText, type HandoffBlockSpan, type HandoffPart, type SessionContextItem } from "@shared/handoff";
import type { ContextItem } from "@shared/types";
import { describe, expect, it } from "vitest";
import { composeContext, composePrompt, composePromptParts, type ComposeEntry, type PlainEntry, type SampleFacts, type SessionEntry } from "./compose";

const HEAD = "\n\n---\nContext provided with this task:\n\n";

describe("composePrompt：没有 session 条目时的格式（加会话引用之前就是这样，不能变）", () => {
  it("没有上下文就只有去掉首尾空白的任务原文", () => {
    expect(composePrompt("  Do it  \n", [])).toBe("Do it");
  });

  it("文本条目：标题缺省或只有空白时按序号命名，正文去掉首尾空白", () => {
    const context: ContextItem[] = [
      { kind: "text", text: "  first body  " },
      { kind: "text", title: "  Spec  ", text: "second body" },
      { kind: "text", title: "   ", text: "third body" },
    ];

    expect(composePrompt("Do it", context)).toBe(
      `Do it${HEAD}### Note 1\nfirst body\n\n### Spec\nsecond body\n\n### Note 3\nthird body`,
    );
  });

  it("文件条目：路径加可选的说明", () => {
    const context: ContextItem[] = [
      { kind: "file", path: "src/a.ts" },
      { kind: "file", path: "src/b.ts", note: "  the entry point  " },
    ];

    expect(composePrompt("Do it", context)).toBe(`Do it${HEAD}### File: src/a.ts\n\n### File: src/b.ts\nthe entry point`);
  });

  it("片段条目：路径与行号范围、围栏、语言；结尾的空行去掉；正文里有围栏时改用更长的围栏", () => {
    const context: ContextItem[] = [
      { kind: "snippet", path: "src/a.ts", language: "ts", startLine: 3, endLine: 5, text: "const a = 1;\n\n" },
      { kind: "snippet", path: "src/b.ts", startLine: 7, text: "b()" },
      { kind: "snippet", text: "plain" },
      { kind: "snippet", text: "```\nnested\n```" },
    ];

    expect(composePrompt("Do it", context)).toBe(
      [
        `Do it${HEAD}### Snippet: src/a.ts:3-5`,
        "```ts",
        "const a = 1;",
        "```",
        "",
        "### Snippet: src/b.ts:7",
        "```",
        "b()",
        "```",
        "",
        "### Snippet: Snippet",
        "```",
        "plain",
        "```",
        "",
        "### Snippet: Snippet",
        "````",
        "```",
        "nested",
        "```",
        "````",
      ].join("\n"),
    );
  });

  it("链接条目：标题可有可无", () => {
    const context: ContextItem[] = [
      { kind: "url", url: "https://example.com/a", title: " Docs " },
      { kind: "url", url: "https://example.com/b" },
    ];

    expect(composePrompt("Do it", context)).toBe(`Do it${HEAD}### Link: Docs\nhttps://example.com/a\n\n### Link\nhttps://example.com/b`);
  });

  it("没有 session 条目时 sessionBlocks 不起作用，spans 为空，两个入口给出同一段文字", () => {
    const context: ContextItem[] = [{ kind: "text", text: "body" }];
    const withBlocks = new Map([[0, "### Session ses_x: Unused\nnever rendered"]]);

    expect(composePrompt("Do it", context, withBlocks)).toBe(composePrompt("Do it", context));
    const parts = composePromptParts("Do it", context, withBlocks);
    expect(parts.prompt).toBe(composePrompt("Do it", context));
    expect(parts.spans.size).toBe(0);
  });
});

describe("composePromptParts：会话引用块", () => {
  const blockA = "### Session ses_a: Upstream A\nSource: session ses_a (codex).\n\n#### Final answer (run 1 of 1)\n```text\nHello\n```";
  const blockB = "### Session ses_b: Upstream B\nSource: session ses_b (claude).";

  it("块原样放进提示，位置是边拼边量的：按区间取回的就是那一块", () => {
    const context: ContextItem[] = [
      { kind: "text", text: "intro" },
      { kind: "session", sessionId: "ses_a" },
      { kind: "file", path: "src/a.ts" },
      { kind: "session", sessionId: "ses_b" },
    ];
    const { prompt, spans } = composePromptParts(
      "Do it",
      context,
      new Map([
        [1, blockA],
        [3, blockB],
      ]),
    );

    expect(prompt).toBe(`Do it${HEAD}### Note 1\nintro\n\n${blockA}\n\n### File: src/a.ts\n\n${blockB}`);
    expect([...spans.keys()]).toEqual([1, 3]);
    const first = spans.get(1);
    const second = spans.get(3);
    expect(prompt.slice(first?.start, first?.end)).toBe(blockA);
    expect(prompt.slice(second?.start, second?.end)).toBe(blockB);
    // 块与块之间的空行、别的条目都不在区间里。
    expect(first && second && first.end < second.start).toBe(true);
  });

  it("相邻两块之间只隔一个空行，区间不重叠也不吞掉空行", () => {
    const { prompt, spans } = composePromptParts(
      "Do it",
      [
        { kind: "session", sessionId: "ses_a" },
        { kind: "session", sessionId: "ses_b" },
      ],
      new Map([
        [0, blockA],
        [1, blockB],
      ]),
    );
    const first = spans.get(0);
    const second = spans.get(1);

    expect(first?.start).toBe(`Do it${HEAD}`.length);
    expect(first && second && second.start - first.end).toBe(2);
    expect(prompt.slice(first?.end, second?.start)).toBe("\n\n");
    expect(prompt.endsWith(blockB)).toBe(true);
  });

  it("任务原文的首尾空白照旧被去掉，区间按去掉之后的位置算", () => {
    const { prompt, spans } = composePromptParts("   Do it  \n", [{ kind: "session", sessionId: "ses_a" }], new Map([[0, blockA]]));
    const span = spans.get(0);

    expect(prompt).toBe(`Do it${HEAD}${blockA}`);
    expect(prompt.slice(span?.start, span?.end)).toBe(blockA);
  });

  it("有 session 条目却没交进渲染好的块：抛出，而不是悄悄少一块", () => {
    expect(() => composePrompt("Do it", [{ kind: "session", sessionId: "ses_a" }])).toThrow(/context\[0\] references a session but its block was not rendered/);
    expect(() =>
      composePromptParts("Do it", [{ kind: "text", text: "x" }, { kind: "session", sessionId: "ses_a" }], new Map([[0, blockA]])),
    ).toThrow(/context\[1\] references a session/);
  });

  it("不认识的条目种类（更新版本写下的记录）抛出带内容的错误，而不是返回 undefined 或空串", () => {
    const unknown = { kind: "audio", url: "x" } as unknown as ContextItem;

    expect(() => composePrompt("Do it", [unknown])).toThrow(/unsupported context kind: .*audio/);
  });
});

describe("composeContext：按条目一次组装（提示、区间、记录与回执出自同一份条目）", () => {
  const blockA = "### Session ses_a: Upstream A\nSource: session ses_a (codex).\n\n#### Final answer (run 1 of 1)\n```text\nHello\n```";
  const blockB = "### Session ses_b: Upstream B\nSource: session ses_b (claude).";
  const intro: PlainEntry["item"] = { kind: "text", text: "intro" };
  const file: PlainEntry["item"] = { kind: "file", path: "src/a.ts" };
  const link: PlainEntry["item"] = { kind: "url", url: "https://example.com/doc" };

  const facts = (title: string): SampleFacts => ({ at: "2026-03-04T05:06:07.000Z", title, harness: "codex", phase: "done", runCount: 1 });

  /** 一个渲染好的会话引用条目：原输入是合并之后的样子（规范的 include，没有 sample）。 */
  function session(sessionId: string, block: string, include: HandoffPart[] = ["result"]): SessionEntry {
    return { item: { kind: "session", sessionId, include }, include, block, sample: facts(`Upstream ${sessionId}`) };
  }

  function sessionAt(context: readonly ContextItem[], index: number): SessionContextItem {
    const item = context[index];
    if (item?.kind !== "session") throw new Error(`context[${index}] is not a session item`);
    return item;
  }

  /** 记录里某个会话引用的块区间；缺了就让测试失败，而不是对 undefined 做 slice（那会取回整段提示）。 */
  function spanOf(context: readonly ContextItem[], index: number): HandoffBlockSpan {
    const span = sessionAt(context, index).sample?.block;
    if (!span) throw new Error(`context[${index}] has no block span`);
    return span;
  }

  it("没有条目：只有去掉首尾空白的任务原文，没有记录也没有回执", () => {
    expect(composeContext("  Do it  \n", [])).toEqual({ prompt: "Do it", context: [], receipts: [] });
  });

  it("只有普通条目：提示与 composePrompt 逐字相同，记录里是传进来的同一个对象，没有回执", () => {
    const items: PlainEntry["item"][] = [
      intro,
      { kind: "file", path: "src/b.ts", note: "  entry  " },
      { kind: "snippet", path: "src/c.ts", startLine: 3, text: "c()\n" },
      link,
    ];

    const composed = composeContext("Do it", items.map((item) => ({ item })));

    expect(composed.prompt).toBe(composePrompt("Do it", items));
    expect(composed.context).toHaveLength(items.length);
    items.forEach((item, index) => expect(composed.context[index]).toBe(item));
    expect(composed.receipts).toEqual([]);
  });

  it("混排：每个会话块的区间对准它自己的块，块前后的文字一个字不差，其余条目原样，回执按会话出现的先后", () => {
    const a = session("ses_a", blockA, ["result", "files"]);
    const b = session("ses_b", blockB);

    const { prompt, context, receipts } = composeContext("Do it", [{ item: intro }, a, { item: file }, b, { item: link }]);

    const first = spanOf(context, 1);
    const second = spanOf(context, 3);
    expect(prompt.slice(0, first.start)).toBe(`Do it${HEAD}### Note 1\nintro\n\n`);
    expect(prompt.slice(first.start, first.end)).toBe(blockA);
    expect(prompt.slice(first.end, second.start)).toBe("\n\n### File: src/a.ts\n\n");
    expect(prompt.slice(second.start, second.end)).toBe(blockB);
    expect(prompt.slice(second.end)).toBe("\n\n### Link\nhttps://example.com/doc");
    expect(handedOverText(prompt, sessionAt(context, 1))).toBe(blockA);
    expect(handedOverText(prompt, sessionAt(context, 3))).toBe(blockB);

    expect(context.map((item) => item.kind)).toEqual(["text", "session", "file", "session", "url"]);
    expect(context[0]).toBe(intro);
    expect(context[2]).toBe(file);
    expect(context[4]).toBe(link);
    expect(context[1]).toEqual({ kind: "session", sessionId: "ses_a", include: ["result", "files"], sample: { ...a.sample, block: first } });
    expect(receipts).toEqual([
      { sessionId: "ses_a", include: ["result", "files"], ...a.sample },
      { sessionId: "ses_b", include: ["result"], ...b.sample },
    ]);
    expect(receipts[0]).not.toHaveProperty("block");
  });

  it("相邻的两个引用：中间只隔一个空行，两个区间既不重叠也不吞掉空行", () => {
    const { prompt, context } = composeContext("   Do it  \n", [session("ses_a", blockA), session("ses_b", blockB)]);

    const first = spanOf(context, 0);
    const second = spanOf(context, 1);
    expect(prompt).toBe(`Do it${HEAD}${blockA}\n\n${blockB}`);
    expect(first.start).toBe(`Do it${HEAD}`.length);
    expect(prompt.slice(first.end, second.start)).toBe("\n\n");
    expect(second.end).toBe(prompt.length);
  });

  it("提示里有代理对（emoji）与中文：区间按 JavaScript 字符串下标算，按区间取回的原文一个字不差", () => {
    const smile = "\u{1F600}";
    const block = `### Session ses_a: Fix ${smile}\nAnswer ${smile}${smile} 完成`;

    const { prompt, context } = composeContext(`Do ${smile} it`, [{ item: { kind: "text", title: smile, text: `${smile} 备注` } }, session("ses_a", block)]);

    const span = spanOf(context, 1);
    expect(span).toEqual({ start: prompt.indexOf(block), end: prompt.indexOf(block) + block.length });
    expect(prompt.slice(span.start, span.end)).toBe(block);
    expect(handedOverText(prompt, sessionAt(context, 1))).toBe(block);
    // 前提：区间之前确有代理对，按码点数算与按码元数算不同；区间用的是后者（与 slice、handedOverText 同一口径）。
    expect([...prompt.slice(0, span.start)].length).toBeLessThan(span.start);
  });

  it("与 composePromptParts 是同一份拼接：同样的块给出逐字相同的提示与同样的区间", () => {
    const entries: ComposeEntry[] = [{ item: intro }, session("ses_a", blockA), { item: file }, session("ses_b", blockB)];

    const composed = composeContext("Do it", entries);
    const parts = composePromptParts(
      "Do it",
      entries.map((entry) => entry.item),
      new Map([
        [1, blockA],
        [3, blockB],
      ]),
    );

    expect(parts.prompt).toBe(composed.prompt);
    expect([...parts.spans.keys()]).toEqual([1, 3]);
    expect(parts.spans.get(1)).toEqual(spanOf(composed.context, 1));
    expect(parts.spans.get(3)).toEqual(spanOf(composed.context, 3));
  });

  it("不改传进来的条目：合并之后的 session 条目上不会多出 sample，取样事实原样", () => {
    const entry = session("ses_a", blockA);
    const before = structuredClone(entry);

    composeContext("Do it", [entry]);

    expect(entry).toEqual(before);
    expect(entry.item).not.toHaveProperty("sample");
  });

  it("不认识的条目种类（更新版本写下的记录）抛出带内容的错误，而不是返回 undefined 或空串", () => {
    const unknown = { kind: "audio", url: "x" } as unknown as PlainEntry["item"];

    expect(() => composeContext("Do it", [{ item: unknown }])).toThrow(/unsupported context kind: .*audio/);
  });
});
