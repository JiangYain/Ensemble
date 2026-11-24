import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import type { RunningService } from "../server/service";
import { until } from "../server/testing";
import { closeTestBridges, connectTestBridge, simulateOlderService, startTestService, type McpSession } from "./bridge.fixtures";

/**
 * 汇聚在 MCP 这一层：`delegate` 的 `follows` 既可以是一个 id、也可以是一组 id（一个会话依赖几个会话的结果），
 * 回执怎么说、哪些输入被拒绝、层数限制取最长链并点名是哪个上级、判重按“上级的集合”比较，
 * 以及新桥遇到没有这个功能的老服务时怎么如实降级（只记第一个并说明，而不是悄悄丢掉）。
 * 一行怎么写（详情里的 `follows:` 行）在 format.multiparent.test.ts。全部用临时状态目录与模拟执行端。
 */

afterEach(closeTestBridges);

interface Harness extends McpSession {
  service: RunningService;
}

/** old：把服务写下的 service.json 改成老服务写的样子（没有 features 字段）；桥在第一次请求时才读它，所以要在连接之前改。 */
async function setup(options: { old?: boolean } = {}): Promise<Harness> {
  const service = await startTestService({ homePrefix: "ensemble-mcp-multiparent-", env: {} });
  if (options.old) expect(simulateOlderService(service), "the new service advertises multi-parent").toContain("multi-parent");
  return { service, ...(await connectTestBridge(service)) };
}

/** 经 MCP 委派一个会话，返回它的 id（不等它结束）。 */
async function delegated(harness: McpSession, task: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await harness.call("delegate", { harness: "pi", task, cwd: tmpdir(), ...extra });
  expect(result.isError, result.text).toBe(false);
  return result.data?.["sessionId"] as string;
}

/** 经 MCP 委派一个很快结束的会话，等它完成。 */
async function finished(harness: Harness, task: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await delegated(harness, task, extra);
  await until(() => harness.service.hub.summary(id)?.phase === "done");
  return id;
}

async function twoParents(harness: Harness): Promise<[string, string]> {
  const one = await finished(harness, "[fixture:quick] part one", { title: "Part one" });
  const two = await finished(harness, "[fixture:quick] part two", { title: "Part two" });
  return [one, two];
}

/** 一条越接越深的链：第 n 个会话在第 n 层（0 层到限制那一层，限制那一层再往下就不行了）。 */
async function chainOfFollowUps(harness: Harness): Promise<string[]> {
  const chain: string[] = [];
  for (let level = 0; level <= LIMITS.maxDelegationDepth; level++) {
    chain.push(await delegated(harness, `[fixture:quick] link ${level}`, level > 0 ? { follows: chain[level - 1] } : {}));
  }
  return chain;
}

describe("`follows` as a list of sessions", () => {
  it("is documented as one id or several, with the limit, what it is for, and which one is the primary", async () => {
    const h = await setup();
    const delegate = (await h.client.listTools()).tools.find((tool) => tool.name === "delegate")!;
    const follows = (delegate.inputSchema.properties as Record<string, { description?: string }>)["follows"];

    expect(delegate.inputSchema.required ?? []).not.toContain("follows");
    // 既收一个字符串、也收一组字符串（不钉死 JSON Schema 的写法，只看两种形状都在）。
    expect(JSON.stringify(follows)).toContain('"type":"string"');
    expect(JSON.stringify(follows)).toContain('"type":"array"');
    expect(follows?.description).toContain(`at most ${LIMITS.maxParents}`);
    expect(follows?.description).toMatch(/convergence/i);
    expect(follows?.description).toMatch(/first id is the primary one/i);
    // 原有的说明不丢：它不改变发起端，也不是为了画线而列会话。
    expect(follows?.description).toMatch(/does not change/i);
    expect(follows?.description).toMatch(/Do not list sessions just to draw lines/);
    expect(h.client.getInstructions()).toContain(`pass all of their ids as \`follows\` (up to ${LIMITS.maxParents})`);
  });

  it("records every one of them as a parent, in the order given, and answers with the sessions it follows", async () => {
    const h = await setup();
    const [first, second] = await twoParents(h);

    const joined = await h.call("delegate", { harness: "pi", task: "[fixture:quick] accept both", cwd: tmpdir(), follows: [first, second] });

    expect(joined.isError, joined.text).toBe(false);
    const id = joined.data?.["sessionId"] as string;
    expect(h.service.hub.summary(id)).toMatchObject({ parentSessionId: first, parentSessionIds: [first, second], depth: 1 });
    expect(h.service.hub.summary(first)?.childIds).toEqual([id]);
    expect(h.service.hub.summary(second)?.childIds).toEqual([id]);
    // 回执里每个上级只说一次：一行写清各自的 id 与标题；详情里的 `follows: id, id` 行不在回执里重复（它在 status / read / wait 的详情里，见最后一条）。
    expect(joined.text).toContain(`    follows 2 sessions: ${first} “Part one”, ${second} “Part two”`);
    expect(joined.text).not.toContain("    follows: ");
    for (const parent of [first, second]) expect(joined.text.split(parent), parent).toHaveLength(2);
    expect(joined.text).not.toContain("nested under");
    expect(joined.text).not.toContain("older than this plugin");
  });

  it("answers exactly as before when the list holds one id, and when `follows` is a plain string", async () => {
    const h = await setup();
    const [first] = await twoParents(h);

    const listed = await h.call("delegate", { harness: "pi", task: "[fixture:quick] listed", cwd: tmpdir(), follows: [first] });
    const plain = await h.call("delegate", { harness: "pi", task: "[fixture:quick] plain", cwd: tmpdir(), follows: first });

    for (const result of [listed, plain]) {
      expect(result.isError, result.text).toBe(false);
      const summary = h.service.hub.summary(result.data?.["sessionId"] as string);
      expect(summary).toMatchObject({ parentSessionId: first, depth: 1 });
      expect(summary).not.toHaveProperty("parentSessionIds");
      expect(result.text).toContain(`follows session ${first} “Part one”`);
      expect(result.text).not.toMatch(/follows \d+ sessions/);
      expect(result.text).not.toContain("    follows: ");
    }
  });

  it("ignores blanks and repeats, and keeps the order it was written in (the first one is the primary)", async () => {
    const h = await setup();
    const [first, second] = await twoParents(h);

    const id = await delegated(h, "[fixture:quick] accept both", { follows: [` ${second} `, first, second, "  "] });

    expect(h.service.hub.summary(id)).toMatchObject({ parentSessionId: second, parentSessionIds: [second, first] });
  });

  it("accepts as many as one session may follow", async () => {
    const h = await setup();
    const parents: string[] = [];
    for (let n = 0; n < LIMITS.maxParents; n++) parents.push(await delegated(h, `[fixture:quick] part ${n}`));

    const joined = await h.call("delegate", { harness: "pi", task: "[fixture:quick] collect them all", cwd: tmpdir(), follows: parents });

    expect(joined.isError, joined.text).toBe(false);
    expect(h.service.hub.summary(joined.data?.["sessionId"] as string)?.parentSessionIds).toEqual(parents);
    expect(joined.text).toContain(`follows ${LIMITS.maxParents} sessions: `);
  });

  it("refuses one more than that before anything is sent, naming the parameter", async () => {
    const h = await setup();
    const [first] = await twoParents(h);
    const before = h.service.hub.sessionIds().length;
    const tooMany = [first, ...Array.from({ length: LIMITS.maxParents }, (_, index) => `ses_extra${index}`)];

    const result = await h.call("delegate", { harness: "pi", task: "[fixture:quick] collect them all", cwd: tmpdir(), follows: tooMany });

    expect(result.isError).toBe(true);
    // schema 的上限就是真实的上限（见 delegate-output.follows.test.ts），所以超限在 MCP 校验参数这一层就被拒绝，不进桥的代码，错误里点名 `follows`；
    // 带建议（保留真正依赖的、或拆出一个中间会话）的那句措辞只在不经 schema 的路径上出现（delegate-request.test.ts）。
    expect(result.text).toContain("follows");
    // 数量先于“有没有这个会话”被检查（schema 在桥之前就拒绝了）：要是反过来，这里说的就是“ses_extra0 不存在”，而不是真正的问题。
    expect(result.text).not.toContain("does not exist");
    expect(result.text).not.toContain("invalid_request");
    expect(h.service.hub.sessionIds()).toHaveLength(before);
  });

  it("names every session that does not exist at once, and creates nothing", async () => {
    const h = await setup();
    const [first] = await twoParents(h);
    const before = h.service.hub.sessionIds().length;

    const several = await h.call("delegate", { harness: "pi", task: "[fixture:quick] fix", cwd: tmpdir(), follows: [first, "ses_nope1", "ses_nope2"] });

    expect(several.isError).toBe(true);
    expect(several.text).toContain("Sessions ses_nope1, ses_nope2 (passed as `follows`) do not exist");
    expect(several.text).toContain("`status`");
    expect(several.text).not.toContain(`${first},`);
    expect(several.text).not.toContain("invalid_request");

    // 只有一个不存在时措辞与以前一样（单数）。
    const one = await h.call("delegate", { harness: "pi", task: "[fixture:quick] fix", cwd: tmpdir(), follows: [first, "ses_nope1"] });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("Session ses_nope1 (passed as `follows`) does not exist");
    expect(h.service.hub.sessionIds()).toHaveLength(before);
  });
});

describe("`follows` against the parent the bridge would have inferred", () => {
  it("takes precedence as a whole, and says which session it did not nest the new one under", async () => {
    const h = await setup();
    const [first, second] = await twoParents(h);
    const own = await delegated(h, "[fixture:long] my own parent");
    const inside = await connectTestBridge(h.service, { env: { ENSEMBLE_PARENT_SESSION: own } });

    const plain = await inside.call("delegate", { harness: "pi", task: "[fixture:quick] plain", cwd: tmpdir() });
    expect(h.service.hub.summary(plain.data?.["sessionId"] as string)).toMatchObject({ parentSessionId: own, depth: 1 });
    expect(plain.text).toContain(`nested under session ${own}`);

    const explicit = await inside.call("delegate", { harness: "pi", task: "[fixture:quick] explicit", cwd: tmpdir(), follows: [first, second] });
    expect(h.service.hub.summary(explicit.data?.["sessionId"] as string)).toMatchObject({ parentSessionId: first, parentSessionIds: [first, second], depth: 1 });
    expect(explicit.text).toContain(`follows 2 sessions: ${first}`);
    expect(explicit.text).toContain(`(not nested under session ${own}: \`follows\` takes precedence)`);
    await h.call("cancel", { sessionId: own, stop: true });
  });

  it("does not say that when the inferred parent is one of the sessions it follows", async () => {
    const h = await setup();
    const [first] = await twoParents(h);
    const own = await delegated(h, "[fixture:long] my own parent");
    const inside = await connectTestBridge(h.service, { env: { ENSEMBLE_PARENT_SESSION: own } });

    const explicit = await inside.call("delegate", { harness: "pi", task: "[fixture:quick] explicit", cwd: tmpdir(), follows: [own, first] });

    expect(h.service.hub.summary(explicit.data?.["sessionId"] as string)).toMatchObject({ parentSessionId: own, parentSessionIds: [own, first] });
    expect(explicit.text).toContain(`follows 2 sessions: ${own}`);
    expect(explicit.text).not.toContain("not nested under");
    await h.call("cancel", { sessionId: own, stop: true });
  });
});

describe("the nesting limit with several parents", () => {
  it("counts the longest chain, and names the parent that decides it instead of blaming the whole list", async () => {
    const h = await setup();
    const chain = await chainOfFollowUps(h);
    const deepest = chain[chain.length - 1]!;
    const shallow = await delegated(h, "[fixture:quick] standalone");

    // 最深的放在后面：被点名的必须是真正让链过深的那个，而不是排在第一位的主上级。
    const result = await h.call("delegate", { harness: "pi", task: "[fixture:quick] join", cwd: tmpdir(), follows: [shallow, deepest] });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`depth ${LIMITS.maxDelegationDepth + 1}`);
    expect(result.text).toContain("the deepest of its 2 parents");
    expect(result.text).toContain(`Session ${deepest}, one of the sessions passed as \`follows\``);
    expect(result.text).not.toContain(`Session ${shallow}, one of the sessions`);
    expect(result.text).toContain("drop it from `follows`");
    expect(result.text).toContain("omit `follows`");
    expect(result.text).not.toContain("Do the work yourself");
    expect(h.service.hub.sessionIds()).toHaveLength(chain.length + 1);
  });

  it("accepts the same join when its deepest parent is one level up", async () => {
    const h = await setup();
    const chain = await chainOfFollowUps(h);
    const shallow = await delegated(h, "[fixture:quick] standalone");

    const joined = await delegated(h, "[fixture:quick] join", { follows: [shallow, chain[LIMITS.maxDelegationDepth - 1]!] });

    expect(h.service.hub.summary(joined)).toMatchObject({ parentSessionId: shallow, depth: LIMITS.maxDelegationDepth });
  });

  it("keeps the advice it gave before for one parent that sits at the end of a long chain", async () => {
    const h = await setup();
    const chain = await chainOfFollowUps(h);

    const result = await h.call("delegate", { harness: "pi", task: "[fixture:quick] one more", cwd: tmpdir(), follows: chain[chain.length - 1]! });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("The session passed as `follows` sits at the end of a long chain of follow-ups");
    expect(result.text).toContain("Follow an earlier session in that chain instead");
    expect(result.text).not.toContain("one of the sessions passed as");
    expect(result.text).not.toContain("the deepest of its");
  });
});

describe("a service that is older than the plugin and does not know about several parents", () => {
  it("records only the first parent and says so, instead of silently dropping the others", async () => {
    const h = await setup({ old: true });
    const [first, second] = await twoParents(h);

    const joined = await h.call("delegate", { harness: "pi", task: "[fixture:quick] accept both", cwd: tmpdir(), follows: [first, second] });

    // 不是错误：委派照常发出，只是这一点没能记录，而且明说了。
    expect(joined.isError, joined.text).toBe(false);
    const id = joined.data?.["sessionId"] as string;
    // 这里的服务其实是新的：桥要是照样把 parentSessionIds 发过去，它就会记下两个——所以没记，说明桥没发。
    expect(h.service.hub.summary(id)).toMatchObject({ parentSessionId: first, depth: 1 });
    expect(h.service.hub.summary(id)).not.toHaveProperty("parentSessionIds");
    expect(h.service.hub.summary(second)?.childIds).toEqual([]);
    expect(joined.text).toContain(`follows 2 sessions: ${first} “Part one”, ${second} “Part two”`);
    expect(joined.text).toContain(`older than this plugin and recorded only the first of them (${first}); the others are not linked in the panel`);
    expect(joined.text).not.toContain("    follows: ");
  });

  it("says nothing about it for one parent, which every service records", async () => {
    const h = await setup({ old: true });
    const [first] = await twoParents(h);

    const joined = await h.call("delegate", { harness: "pi", task: "[fixture:quick] fix", cwd: tmpdir(), follows: [first] });

    expect(joined.isError, joined.text).toBe(false);
    expect(h.service.hub.summary(joined.data?.["sessionId"] as string)).toMatchObject({ parentSessionId: first });
    expect(joined.text).toContain(`follows session ${first}`);
    expect(joined.text).not.toContain("older than this plugin");
  });

  it("does not refuse a join the way it refuses `profile`: the work is still handed over", async () => {
    const h = await setup({ old: true });
    const [first, second] = await twoParents(h);

    const id = await delegated(h, "[fixture:quick] accept both", { follows: [first, second] });

    await until(() => h.service.hub.summary(id)?.phase === "done");
    expect(h.service.hub.summary(id)?.parentSessionId).toBe(first);
  });
});

describe("delegating the same join twice", () => {
  const job = { harness: "pi", task: "[fixture:hold] Accept both", cwd: tmpdir() };

  it("is one delegation when the parents are the same sessions, whatever the order, and another when the set differs", async () => {
    const h = await setup();
    const [first, second] = await twoParents(h);

    const created = await h.call("delegate", { ...job, follows: [first, second] });
    expect(created.text).toMatch(/^Delegated to /);

    const reordered = await h.call("delegate", { ...job, follows: [second, first] });
    expect(reordered.text).toMatch(/^Not delegated again: an identical delegation was created /);
    expect(reordered.data).toMatchObject({ sessionId: created.data?.["sessionId"], duplicate: true });

    const fewer = await h.call("delegate", { ...job, follows: [first] });
    expect(fewer.text).toMatch(/^Delegated to /);
    expect(fewer.data?.["sessionId"]).not.toBe(created.data?.["sessionId"]);

    const none = await h.call("delegate", job);
    expect(none.text).toMatch(/^Delegated to /);
    expect(new Set([created, fewer, none].map((result) => result.data?.["sessionId"])).size).toBe(3);
  });
});

describe("a session that follows several sessions, listed by `status`", () => {
  it("shows the parents on a `follows:` line of the detailed view, and only for the session that has several", async () => {
    const h = await setup();
    const [first, second] = await twoParents(h);
    const joined = await delegated(h, "[fixture:quick] accept both", { follows: [first, second] });
    const single = await delegated(h, "[fixture:quick] fix", { follows: first });

    const status = await h.call("status", { sessionIds: [joined, single], detail: true });

    expect(status.isError, status.text).toBe(false);
    expect(status.text).toContain(`    follows: ${first}, ${second}`);
    expect(status.text.match(/ {4}follows: /g)).toHaveLength(1);
  });
});
