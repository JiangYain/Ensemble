import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ManualExecutor } from "../server/testing";
import { closeTestBridges, connectTestBridge, startTestService } from "./bridge.fixtures";

/**
 * 并发上限满了、委派的会话在排队（还没有开始）时，MCP 这一层说的话要与实际一致：回执首句与 `read` 都不能说它“在后台工作”。
 * 上限钉成 1：第一个会话占住唯一的名额（模拟执行端不报告“开始”，它的运行停在“启动中”），第二个因此排队。
 * 全部用临时状态目录与模拟执行端，不碰真实数据。
 */

afterEach(closeTestBridges);

const WORKING = "It is working in the background; you do not need to poll.";
const QUEUED = "It is queued: the concurrent-run limit is full, so it starts when a slot frees up. You do not need to poll.";

async function setup() {
  const service = await startTestService({
    homePrefix: "ensemble-mcp-queued-",
    executors: [new ManualExecutor("codex")],
    env: {},
    // 启动方显式给定的上限压过环境变量与设置文件，这里的“满了”不依赖别的东西。
    managerConfig: { maxConcurrentRuns: 1 },
  });
  return connectTestBridge(service);
}

type Bridge = Awaited<ReturnType<typeof setup>>;

/** 委派两个互不相同的任务（相同的会被当成重复）：第一个拿到名额，第二个排队。 */
async function delegateTwo(bridge: Bridge) {
  const first = await bridge.call("delegate", { harness: "codex", task: "Audit the parser", cwd: tmpdir() });
  expect(first.isError, first.text).toBe(false);
  const second = await bridge.call("delegate", { harness: "codex", task: "Audit the lexer", cwd: tmpdir() });
  expect(second.isError, second.text).toBe(false);
  return { first, second, firstId: first.data?.["sessionId"] as string, secondId: second.data?.["sessionId"] as string };
}

describe("delegate when the concurrent-run limit is full", () => {
  it("tells the session that got the slot it is working, and the one that is waiting that it is queued", async () => {
    const { first, second } = await delegateTwo(await setup());

    expect(first.data?.["phase"]).not.toBe("queued");
    expect(first.text).toContain(WORKING);

    expect(second.data?.["phase"]).toBe("queued");
    expect(second.text).toContain(QUEUED);
    // 详情里的状态行本来就写着排队，首句不能与它矛盾。
    expect(second.text).toContain("queued (waiting for a free slot)");
    expect(second.text).not.toContain("working in the background");
  });
});

describe("read when the concurrent-run limit is full", () => {
  it("says a queued session has not started, not that it is still working", async () => {
    const bridge = await setup();
    const { secondId } = await delegateTwo(bridge);

    const result = await bridge.call("read", { sessionId: secondId });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("No output yet — the session is queued and has not started. Call `wait` or check the panel.");
    expect(result.text).not.toContain("still working");
  });

  it("does not say the session that holds the slot is queued", async () => {
    const bridge = await setup();
    const { firstId } = await delegateTwo(bridge);

    const result = await bridge.call("read", { sessionId: firstId });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain("queued and has not started");
  });
});
