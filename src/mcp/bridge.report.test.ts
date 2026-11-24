/**
 * `read` 的 report 视角（把会话或整棵任务树导出为 Markdown 报告）：参数规整、经桥转交服务端的报告、老服务的协商降级。
 * 报告本身的内容与排版由 shared/report.test.ts 与 server/report.test.ts 覆盖；这里只管“桥有没有把它原样、安全地交到主 Agent 手里”。
 * 一律用临时目录当 ENSEMBLE_HOME，不碰这台机器上真实的数据。
 */
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import { REPORT_LIMITS } from "@shared/report";
import { FixtureExecutor } from "../server/executors/fixture";
import { until } from "../server/testing";
import { closeTestBridges, connectTestBridge, simulateOlderService, startTestService } from "./bridge.fixtures";
import { ServiceClient, ServiceError } from "./client";
import { parseReadArgs, ReadInputError } from "./read";

// ───────────────────────── 参数 ─────────────────────────

describe('parseReadArgs · view="report"', () => {
  it("defaults to this session alone, the brief level and the usual 12000-character budget", () => {
    const request = parseReadArgs({ sessionId: " ses_a ", view: "report" });
    expect(request).toEqual({ kind: "report", sessionId: "ses_a", scope: "session", detail: "brief", maxChars: 12_000 });
    expect(request).not.toHaveProperty("raisedFrom");
  });

  it("takes the tree scope, the full level and a bigger budget as given", () => {
    expect(parseReadArgs({ sessionId: "ses_a", view: "report", scope: "tree", detail: "full", maxChars: 30_000 })).toEqual({
      kind: "report",
      sessionId: "ses_a",
      scope: "tree",
      detail: "full",
      maxChars: 30_000,
    });
    expect(parseReadArgs({ sessionId: "ses_a", view: "report", maxChars: 10_000_000 })).toMatchObject({ maxChars: 40_000 });
  });

  it("raises a budget that is below what a report fits in, and remembers what was asked for", () => {
    expect(parseReadArgs({ sessionId: "s", view: "report", maxChars: 2000 })).toMatchObject({ maxChars: REPORT_LIMITS.minChars, raisedFrom: 2000 });
    // 低于 schema 下限 500 的值先被收回到 500，但“原来要的”是什么要如实说出来。
    expect(parseReadArgs({ sessionId: "s", view: "report", maxChars: 100 })).toMatchObject({ maxChars: REPORT_LIMITS.minChars, raisedFrom: 100 });
    // 正好是下限、或更大：不算被抬高。
    for (const maxChars of [REPORT_LIMITS.minChars, REPORT_LIMITS.minChars + 1]) {
      const request = parseReadArgs({ sessionId: "s", view: "report", maxChars });
      expect(request).toMatchObject({ maxChars });
      expect(request).not.toHaveProperty("raisedFrom");
    }
  });

  it("refuses what cannot apply to a report instead of silently ignoring it", () => {
    expect(() => parseReadArgs({ sessionId: "s", view: "report", runIndex: 1 })).toThrow(ReadInputError);
    expect(() => parseReadArgs({ sessionId: "s", view: "report", runIndex: 1 })).toThrow(/cannot be combined with `runIndex`/);
    expect(() => parseReadArgs({ sessionId: "s", view: "report", afterSeq: 3 })).toThrow(/`afterSeq`/);
    expect(() => parseReadArgs({ sessionId: "s", view: "report", includeReasoning: true })).toThrow(/never includes reasoning/);
    expect(() => parseReadArgs({ sessionId: "s", view: "report", runIndex: 1, afterSeq: 3, includeReasoning: true })).toThrow(/`runIndex`, `afterSeq`, `includeReasoning`/);
    // 明确写 false 等于没写。
    expect(parseReadArgs({ sessionId: "s", view: "report", includeReasoning: false })).toMatchObject({ kind: "report" });
  });

  it("keeps `scope` and `detail` for the report: any other view refuses them", () => {
    expect(() => parseReadArgs({ sessionId: "s", view: "errors", scope: "tree" })).toThrow(/only apply to `view="report"`/);
    expect(() => parseReadArgs({ sessionId: "s", detail: "full" })).toThrow(/only apply to `view="report"`/);
    expect(() => parseReadArgs({ sessionId: "s", view: "result", scope: "session" })).toThrow(ReadInputError);
  });

  it("does not mix with a batch read", () => {
    expect(() => parseReadArgs({ sessionIds: ["a"], view: "report" })).toThrow(/cannot be combined with view="report"/);
    expect(() => parseReadArgs({ sessionIds: ["a"], scope: "tree" })).toThrow(/`scope`/);
    expect(() => parseReadArgs({ sessionIds: ["a"], detail: "full" })).toThrow(/`detail`/);
  });

  it("rechecks the values at run time, and still needs a session", () => {
    expect(() => parseReadArgs({ sessionId: "s", view: "report", scope: "forest" as never })).toThrow(/`scope` must be "session".*got "forest"/);
    expect(() => parseReadArgs({ sessionId: "s", view: "report", detail: "verbose" as never })).toThrow(/`detail` must be "brief".*got "verbose"/);
    expect(() => parseReadArgs({ view: "report" })).toThrow(/Pass `sessionId`/);
  });
});

// ───────────────────────── 桥与服务 ─────────────────────────

afterEach(closeTestBridges);

/** 一个临时目录里的服务，加一个经内存传输连着它的桥与 MCP 客户端。`requested` 收着桥发出的每个请求的地址。 */
async function setup() {
  const service = await startTestService({ homePrefix: "ensemble-mcp-report-", executors: [new FixtureExecutor("pi", { speed: 0 })] });
  return { service, ...(await connectTestBridge(service)) };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/**
 * 委派一个会话并等它结束（阶段 done 且没有在途的消息：之后日志不再增长）。不带标签的任务走模拟执行端的完整场景：
 * 两次编辑、一次失败的 `npm test`、一次通过的 `npm test`、最终回答与用量；`[fixture:quick]` 只有一句回答。
 */
async function finished(harness: Harness, task = "Split the parser into two layers", extra: Record<string, unknown> = {}): Promise<string> {
  const delegated = await harness.call("delegate", { harness: "pi", task, cwd: tmpdir(), ...extra });
  expect(delegated.isError, delegated.text).toBe(false);
  const id = delegated.data?.["sessionId"] as string;
  await until(
    () => {
      const summary = harness.service.hub.summary(id);
      return summary?.phase === "done" && summary.messages.pending === 0;
    },
    12_000,
    `${id} done`,
  );
  return id;
}

/** 导出时刻写在报告里：比较两份报告的其余内容时先把它抹掉。 */
const withoutTimes = (text: string): string => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/g, "<time>");

describe("read · view=report", () => {
  it("is offered with its two parameters, and the tool says what it contains and that nothing is redacted", async () => {
    const { client } = await setup();
    const read = (await client.listTools()).tools.find((tool) => tool.name === "read")!;
    const properties = read.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(read.inputSchema.required ?? []).toEqual([]);
    expect(properties["view"]?.enum).toContain("report");
    expect(properties["scope"]?.enum).toEqual(["session", "tree"]);
    expect(properties["detail"]?.enum).toEqual(["brief", "full"]);
    expect(properties["maxChars"]?.description).toContain(String(REPORT_LIMITS.minChars));
    expect(read.description).toMatch(/Markdown/);
    expect(read.description).toMatch(/redacts nothing/);
    expect(client.getInstructions()).toContain('view="report"');
  });

  it("hands over the service's Markdown report unchanged, and reads only (the session's records do not move)", async () => {
    const harness = await setup();
    const id = await finished(harness);
    const seqBefore = harness.service.hub.summary(id)!.seq;

    const result = await harness.call("read", { sessionId: id, view: "report" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text.startsWith("# Session report: ")).toBe(true);
    // 委派原文与真实执行过的命令在里面；没有“游标”这类读取视角专有的东西。
    expect(result.text).toContain("Split the parser into two layers");
    expect(result.text).toContain("`npm test`");
    expect(result.text).not.toContain("cursor: #");
    expect(result.data).toMatchObject({ view: "report", sessionId: id, scope: "session", detail: "brief" });

    // 与直接问服务（同样的参数）得到的是同一份，只差导出时刻：桥不改写、不加叙述。
    const direct = await fetch(`${harness.service.url}/api/sessions/${id}/report?scope=session&detail=brief&lang=en&maxChars=12000`, {
      headers: { [TOKEN_HEADER]: harness.service.token },
    });
    expect(direct.status).toBe(200);
    const body = await direct.text();
    expect(withoutTimes(result.text)).toBe(withoutTimes(body.trimEnd()));
    expect(result.data?.["chars"]).toBe(body.length);

    expect(harness.service.hub.summary(id)!.seq).toBe(seqBefore);
  });

  it('forwards `detail="full"`: only then are tool outputs in the report', async () => {
    const harness = await setup();
    const id = await finished(harness);

    const brief = await harness.call("read", { sessionId: id, view: "report" });
    const full = await harness.call("read", { sessionId: id, view: "report", detail: "full", maxChars: 40_000 });
    expect(brief.isError).toBe(false);
    expect(full.isError).toBe(false);
    // 通过的那次 `npm test` 的输出只有它自己的输出里才有。
    expect(brief.text).not.toContain("Tests: 18 passed");
    expect(full.text).toContain("Tests: 18 passed");
    expect(full.data).toMatchObject({ detail: "full" });
  });

  it('covers the whole task tree with `scope="tree"`; the default stays on the one session', async () => {
    const harness = await setup();
    const parent = await finished(harness, "[fixture:quick] Parent brief");
    const child = await finished(harness, "[fixture:quick] Child brief", { follows: parent });
    expect(harness.service.hub.summary(child)).toMatchObject({ parentSessionId: parent });

    const tree = await harness.call("read", { sessionId: parent, view: "report", scope: "tree" });
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text.startsWith("# Task tree report: ")).toBe(true);
    for (const id of [parent, child]) expect(tree.text).toContain(id);
    expect(tree.text).toContain("[fixture:quick] Child brief");
    expect(tree.data).toMatchObject({ view: "report", scope: "tree" });

    const alone = await harness.call("read", { sessionId: parent, view: "report" });
    expect(alone.text.startsWith("# Session report: ")).toBe(true);
    expect(alone.text).not.toContain("[fixture:quick] Child brief");
  });

  it("says so when the budget had to be raised to what a report fits in", async () => {
    const harness = await setup();
    const id = await finished(harness, "[fixture:quick] Small one");

    const result = await harness.call("read", { sessionId: id, view: "report", maxChars: 2000 });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(`\`maxChars\` 2000 is below the ${REPORT_LIMITS.minChars} characters a report needs`);
    expect(result.text).toContain(`maxChars=${REPORT_LIMITS.minChars}`);
    expect(result.text.startsWith("# Session report: ")).toBe(true);

    const enough = await harness.call("read", { sessionId: id, view: "report", maxChars: REPORT_LIMITS.minChars });
    expect(enough.text).not.toContain("a report needs");
  });

  it("refuses combinations that cannot apply, in words the model can act on", async () => {
    const harness = await setup();
    const id = await finished(harness, "[fixture:quick] Another small one");

    const batch = await harness.call("read", { sessionIds: [id], view: "report" });
    expect(batch.isError).toBe(true);
    expect(batch.text).toMatch(/cannot be combined with view="report"/);

    const run = await harness.call("read", { sessionId: id, view: "report", runIndex: 1 });
    expect(run.isError).toBe(true);
    expect(run.text).toMatch(/always covers whole sessions/);

    const stray = await harness.call("read", { sessionId: id, scope: "tree" });
    expect(stray.isError).toBe(true);
    expect(stray.text).toMatch(/only apply to `view="report"`/);
  });

  it("answers a session that does not exist with the service's not_found and the usual way out", async () => {
    const harness = await setup();
    const result = await harness.call("read", { sessionId: "ses_missing", view: "report" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Call `status` to list valid session ids.");
  });

  it("tells the model plainly when the running service is older and cannot export reports, without sending the request", async () => {
    const harness = await setup();
    // 模拟老服务：service.json 里没有 features 字段（桥在第一次请求时才读它）。
    expect(simulateOlderService(harness.service), "the new service advertises the report route").toContain("session-report");

    const result = await harness.call("read", { sessionId: "ses_any", view: "report" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/older than this plugin and cannot export reports/);
    expect(result.text).toContain("tell the user to restart Ensemble");
    expect(result.text).toContain("`transcript`");
    expect(harness.requested.filter((url) => url.includes("/report"))).toEqual([]);

    // 其余视角在这个“老服务”上照常工作：降级只影响 report 这一个视角。
    const id = await finished(harness, "[fixture:quick] Still readable");
    const plain = await harness.call("read", { sessionId: id });
    expect(plain.isError, plain.text).toBe(false);
    expect(plain.text).toContain("Final answer:");
  });
});

describe('ServiceClient · `as: "text"`', () => {
  it("returns a Markdown body as it is, still turns an error into a ServiceError with its code, and keeps refusing non-JSON by default", async () => {
    const harness = await setup();
    const id = await finished(harness, "[fixture:quick] For the client");
    const client = new ServiceClient({
      paths: harness.service.paths,
      ensure: async () => {
        throw new Error("the service should already be running");
      },
    });

    const markdown = await client.request<string>("GET", `/api/sessions/${id}/report?lang=en`, { as: "text" });
    expect(markdown.startsWith("# Session report: ")).toBe(true);

    // 出错时服务回的永远是 JSON 错误体：即使要的是文本，业务错误照样带着 code 与状态。
    const missing = await client.request<string>("GET", "/api/sessions/ses_missing/report", { as: "text" }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ServiceError);
    expect(missing).toMatchObject({ code: "not_found", status: 404 });

    // 不声明 as 就是原来的行为：成功的非 JSON 响应仍然是一个明确的错误，而不是把正文当对象交出去。
    const asJson = await client.request("GET", `/api/sessions/${id}/report`).catch((error: unknown) => error);
    expect(asJson).toBeInstanceOf(ServiceError);
    expect(asJson).toMatchObject({ code: "bad_response" });
  });
});
