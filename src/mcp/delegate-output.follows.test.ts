import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import { replay, toSummary } from "@shared/projection";
import type { DelegateResponse } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import type { SessionMeta, SessionSummary } from "@shared/types";
import { closeTestBridges, setupBridge } from "./bridge.fixtures";
import { renderDelegateOutput } from "./delegate-output";
import type { ParentChoice, PreparedDelegation } from "./delegate-request";

/**
 * 汇聚委派（`follows` 传了几个会话）的回执只说一次：上级的 id 与标题写在一行 `follows N sessions: …` 里，
 * 不再另有详情里那行 `follows: id, id`（那一行在 status / read / wait 的详情里仍然有，见 format.multiparent.test.ts）。
 * 以及 `follows` 的 schema 上限与服务真实接受的个数一致。回执只读构造请求时留下的事实，按事实造出输入即可；schema 那部分用真服务与进程内的 MCP 客户端。
 * 回执的其余文字见 delegate-output.test.ts，汇聚在 MCP 这一层的端到端行为见 bridge.multiparent.test.ts。
 */

afterEach(closeTestBridges);

const PANEL = "http://127.0.0.1:47821/#/sessions/ses_new";

function summaryOf(id: string, meta: Partial<SessionMeta> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created(meta);
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return toSummary(state);
}

/** 上级的摘要：标题直接写在摘要上，不依赖投影怎么取标题。 */
const session = (id: string, title: string): SessionSummary => ({ ...summaryOf(id), title });

function prepared(parents: ParentChoice): PreparedDelegation {
  return { body: { task: "Do the thing", cwd: "C:\\work\\demo" }, cwdSource: "argument", parents, declaredNotRecorded: false };
}

function created(summary: SessionSummary, overrides: Partial<DelegateResponse> = {}): DelegateResponse {
  return { sessionId: "ses_new", runId: "run_1", messageId: "msg_1", summary, ...overrides };
}

const linesOf = (text: string): string[] => text.split("\n");
const lineStarting = (text: string, prefix: string): string | undefined => linesOf(text).find((line) => line.startsWith(prefix));
/** 以 `follows` 开头的行（不论缩进）：详情里的 `follows: …` 与回执里的 `follows N sessions: …` 都算。 */
const followsLines = (text: string): string[] => linesOf(text).filter((line) => line.trimStart().startsWith("follows"));

/** 服务端记了两个上级的新会话（摘要里有 `parentSessionIds`，详情会写一行 `follows: …`）；老服务只记第一个，摘要里就没有它。 */
const JOINED = summaryOf("ses_new", { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
const FIRST_ONLY = summaryOf("ses_new", { parentSessionId: "ses_a", depth: 1 });

const BOTH: ParentChoice = {
  followed: [session("ses_a", "Part one"), session("ses_b", "Part two")],
  inferred: undefined,
  wanted: ["ses_a", "ses_b"],
  recorded: ["ses_a", "ses_b"],
};

describe("renderDelegateOutput：汇聚委派的上级只说一次", () => {
  it("前提：服务记了两个上级的摘要里确有 parentSessionIds，老服务的没有", () => {
    expect(JOINED.parentSessionIds).toEqual(["ses_a", "ses_b"]);
    expect(FIRST_ONLY.parentSessionIds).toBeUndefined();
  });

  it("回执里只有一行 follows，各上级的编号与标题都在这一行里；各个编号在整份回执里只出现一次", () => {
    const { text } = renderDelegateOutput(prepared(BOTH), created(JOINED), PANEL);

    expect(followsLines(text)).toEqual(["    follows 2 sessions: ses_a “Part one”, ses_b “Part two”"]);
    expect(linesOf(text)).not.toContain("    follows: ses_a, ses_b");
    for (const id of ["ses_a", "ses_b"]) expect(text.split(id), id).toHaveLength(2);
  });

  it("去掉的只是详情里那一行：其余文字与摘要里没有 parentSessionIds 时一字不差", () => {
    const withList = renderDelegateOutput(prepared(BOTH), created(JOINED), PANEL).text;
    const withoutList = renderDelegateOutput(prepared(BOTH), created(FIRST_ONLY), PANEL).text;

    expect(withList).toBe(withoutList);
    // 详情的其余部分都还在：面板地址、工作目录出处、下一步。
    expect(linesOf(withList)).toContain(`    panel: ${PANEL}`);
    expect(linesOf(withList)).toContain("    workspace source: argument");
    expect(withList).toContain("Next: open the panel URL");
  });

  it("这一行带着的说明还在：没有采用推断的上级时写明", () => {
    const overridden: ParentChoice = { ...BOTH, inferred: "ses_x" };

    const line = lineStarting(renderDelegateOutput(prepared(overridden), created(JOINED), PANEL).text, "    follows 2 sessions: ");

    expect(line).toContain("ses_a “Part one”, ses_b “Part two”");
    expect(line).toContain("(not nested under session ses_x: `follows` takes precedence)");
  });

  it("老服务只记了第一个：说明还在，回执里也只有一行 follows（它的详情本来就没有那一行）", () => {
    const olderService: ParentChoice = { ...BOTH, recorded: ["ses_a"] };

    const { text } = renderDelegateOutput(prepared(olderService), created(FIRST_ONLY), PANEL);

    expect(followsLines(text)).toEqual(["    follows 2 sessions: ses_a “Part one”, ses_b “Part two”"]);
    const note = lineStarting(text, "    note: ");
    expect(note).toContain("recorded only the first of them (ses_a)");
    expect(note).toContain("the others are not linked in the panel");
  });

  it("命中重复委派的回执不写这次的上级；详情里的 follows 行是那个已有会话自己的事实，照旧保留", () => {
    const { text } = renderDelegateOutput(prepared(BOTH), created(JOINED, { duplicate: { ageMs: 4_000 } }), PANEL);

    expect(linesOf(text)).toContain("    follows: ses_a, ses_b");
    expect(text).not.toContain("follows 2 sessions");
  });
});

describe("`follows` 的个数上限", () => {
  const joining = (follows: string[]): Record<string, unknown> => ({ harness: "pi", task: "[fixture:quick] join them", cwd: tmpdir(), follows });
  const missing = (count: number): string[] => Array.from({ length: count }, (_, index) => `ses_missing${index}`);

  it("schema 里的 maxItems 就是服务真实接受的个数（LIMITS.maxParents），不是更大的数", async () => {
    const { client } = await setupBridge();

    const delegate = (await client.listTools()).tools.find((tool) => tool.name === "delegate")!;
    const follows = JSON.stringify((delegate.inputSchema.properties as Record<string, unknown>)["follows"]);

    expect(follows).toContain(`"maxItems":${LIMITS.maxParents}`);
    expect(follows).not.toContain('"maxItems":50');
  });

  it("恰好上限个 id 能通过 schema（走到桥里才发现会话不存在）；多一个在 schema 这一层就被拒绝，不进桥里的检查", async () => {
    const { call, sessions } = await setupBridge();

    const atLimit = await call("delegate", joining(missing(LIMITS.maxParents)));
    expect(atLimit.isError).toBe(true);
    // 这是桥里“会话不存在”的检查在说话：schema 放行了。
    expect(atLimit.text).toContain("do not exist");

    const overLimit = await call("delegate", joining(missing(LIMITS.maxParents + 1)));
    expect(overLimit.isError).toBe(true);
    expect(overLimit.text).toContain("follows");
    // 没有走到桥里的检查：不是“会话不存在”，也不是服务的错误。
    expect(overLimit.text).not.toContain("do not exist");
    expect(overLimit.text).not.toContain("invalid_request");
    expect(sessions()).toHaveLength(0);
  });
});
