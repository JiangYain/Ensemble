import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seed } from "../server/history-fixtures";
import { silentLogger } from "../server/logger";
import { pathsFor } from "../server/paths";
import { FileEventStore } from "../server/store";
import { ManualExecutor, until } from "../server/testing";
import { closeTestBridges, connectTestBridge, startTestService, tempHome, type TestBridge } from "./bridge.fixtures";

/**
 * `wait` 对“没结束”的会话怎么措辞：没结束的会话可能在排队、启动中、运行中或待命，所以超时、“只结束了几个”、
 * 以及“新出现值得留意的事”这几句只能说“还没结束”，不能说“在运行”。以前写的是 “still running” / “Still working” / “still have work in progress”。
 * 各阶段都是真的：启动中与排队靠上限钉成 1 的模拟执行端（它不报告“开始”，第一个会话停在“启动中”，第二个排队），
 * 待命（ready）与已结束的靠启动前写进状态目录的日志；“值得留意”由一个可以拨快的时钟触发（静默一分钟的阈值，等待开始之后才拨快）。
 * 全部用临时状态目录与模拟执行端。
 */

afterEach(closeTestBridges);

/** 把没结束的会话说成“在运行”的几种旧写法。 */
const CLAIMS_RUNNING = /still (?:running|working)|work in progress/i;

const READY = "ses_readyfixture";
const FINISHED = "ses_donefixture";

async function delegate(bridge: TestBridge, task: string): Promise<string> {
  const result = await bridge.call("delegate", { harness: "codex", task, cwd: tmpdir() });
  expect(result.isError, result.text).toBe(false);
  return result.data?.["sessionId"] as string;
}

/**
 * 一个服务里同时有：启动中的会话、排队的会话（并发上限 1）、待命的会话、已结束的会话。
 * 待命与已结束的两个是启动之前就写进状态目录的日志；前两个经 MCP 委派。
 */
async function setup() {
  let skewMs = 0;
  const home = tempHome("ensemble-mcp-wait-wording-");
  await seed(new FileEventStore(pathsFor(home).sessions, silentLogger), [
    { id: READY, ending: "ready", meta: { harness: "codex" } },
    { id: FINISHED, ending: "done", meta: { harness: "codex" } },
  ]);
  const service = await startTestService({
    home,
    env: {},
    // autoStart 缺省为 false：运行停在“启动中”，不会自己开始，也就不会自己结束。
    executors: [new ManualExecutor("codex")],
    // 启动方显式给定的上限压过环境变量与设置文件，“满了”不依赖别的东西。
    managerConfig: { maxConcurrentRuns: 1 },
    attention: {
      // 静默一分钟才算：正常跑测试时不会触发；要触发时由 `skewClock` 把“值得留意”的时钟拨快。
      limits: { quietMs: 60_000, longToolMs: 60_000, longRunMs: 3_600_000, undeliveredMs: 3_600_000, sharedFileWindowMs: 600_000 },
      tickMs: 50,
      settleMs: 20,
      now: () => Date.now() + skewMs,
    },
  });
  const bridge = await connectTestBridge(service);
  const starting = await delegate(bridge, "Audit the parser");
  const queued = await delegate(bridge, "Audit the lexer");
  await until(() => service.hub.summary(starting)?.phase === "starting", 4000, "the first session to be starting");
  return {
    ...bridge,
    service,
    ids: { starting, queued, ready: READY, finished: FINISHED },
    /** 把“值得留意”的时钟拨快这么多毫秒（只影响它，不影响别的）。 */
    skewClock(ms: number): void {
      skewMs = ms;
    },
  };
}

describe("`wait` when the sessions have not finished", () => {
  it("says nothing has finished yet after a timeout, not that the sessions are still running, whether they are starting, queued or ready", async () => {
    const { call, service, ids } = await setup();

    for (const phase of ["starting", "queued", "ready"] as const) {
      const id = ids[phase];
      expect(service.hub.summary(id)?.phase, `the fixture really is ${phase}`).toBe(phase);

      const waited = await call("wait", { sessionIds: [id], timeoutSeconds: 1, attention: false });

      expect(waited.isError, `${phase}: ${waited.text}`).toBe(false);
      expect(waited.data?.["reason"], phase).toBe("timeout");
      expect(waited.text, phase).toContain("Timed out after 1s — nothing has finished yet. Wait again or do other work.");
      expect(waited.text, phase).not.toMatch(CLAIMS_RUNNING);
      expect(waited.text, phase).toContain(id);
    }
  });

  it("counts what has finished when only some sessions have, instead of saying nothing has", async () => {
    const { call, ids } = await setup();

    const waited = await call("wait", { sessionIds: [ids.starting, ids.finished], timeoutSeconds: 1, attention: false });

    expect(waited.data?.["reason"]).toBe("timeout");
    expect(waited.text).toContain("Timed out after 1s — only 1 of 2 sessions have finished. Wait again or do other work.");
    expect(waited.text).not.toContain("nothing has finished yet");
    expect(waited.text).not.toMatch(CLAIMS_RUNNING);
  });

  it("says the rest have not finished yet when it returns because one of them has", async () => {
    const { call, ids } = await setup();

    const waited = await call("wait", { sessionIds: [ids.starting, ids.queued, ids.finished], mode: "any_settled", timeoutSeconds: 5 });

    expect(waited.data?.["reason"]).toBe("settled");
    expect(waited.text).toContain("1 of 3 sessions have finished; the rest have not finished yet.");
    expect(waited.text).not.toMatch(CLAIMS_RUNNING);
  });

  it("does not call a session that newly shows something worth a look 'running' either — its phase may be starting, queued or ready", async () => {
    const { call, service, ids, skewClock } = await setup();
    const everyone = [ids.starting, ids.queued, ids.ready];
    // 服务处理一次 wait 时，先取“开始时已有哪些值得留意的事”作基线，紧接着（同一段同步代码，见 server/wait.ts）订阅 hub 的变化：
    // 看到多了一次订阅，就说明基线已经取过了。不靠固定的等待时间去猜，机器再忙也不会把“静默了两分钟”误算进基线。
    const subscriptions = vi.spyOn(service.hub, "subscribe");
    const before = subscriptions.mock.calls.length;

    const pending = call("wait", { sessionIds: everyone, timeoutSeconds: 15 });
    await until(() => subscriptions.mock.calls.length > before, 4000, "the service to start waiting");
    // 现在才把“值得留意”的时钟拨快：“静默了两分钟”是等待开始之后才出现的，所以是新的。
    skewClock(120_000);
    const waited = await pending;

    expect(waited.isError, waited.text).toBe(false);
    expect(waited.data?.["reason"]).toBe("attention");
    // 只有启动中的那个会话静默了：排队的与待命的没有在做事，没有“静默”可言。
    expect(waited.data?.["raised"]).toEqual([expect.objectContaining({ sessionId: ids.starting, kind: "quiet" })]);
    expect(waited.text).toContain(`Session ${ids.starting} newly shows something worth a look`);
    expect(waited.text).toContain("It has not finished yet; this is a fact to check, not a verdict.");
    expect(waited.text).not.toMatch(CLAIMS_RUNNING);
    // 同一份返回里列着的三个会话分别是启动中、排队、待命，没有一个在运行。
    for (const phase of ["starting", "queued", "ready"] as const) {
      expect(service.hub.summary(ids[phase])?.phase, phase).toBe(phase);
      expect(waited.text, phase).toContain(ids[phase]);
    }
  });

  it("is described the same way in the tool description and the instructions", async () => {
    const service = await startTestService({ homePrefix: "ensemble-mcp-wait-wording-", env: {}, executors: [new ManualExecutor("codex")] });
    const { client } = await connectTestBridge(service);

    const wait = (await client.listTools()).tools.find((tool) => tool.name === "wait");
    expect(wait?.description).toContain("If it times out, the remaining sessions have not finished yet");
    expect(wait?.description).not.toMatch(CLAIMS_RUNNING);

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("`wait` also returns early when an unfinished session newly shows something worth a look");
    expect(instructions).not.toContain("a running session newly shows");
    expect(instructions).not.toMatch(CLAIMS_RUNNING);
  });
});
