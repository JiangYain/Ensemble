import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV, LIMITS, TOKEN_HEADER } from "@shared/constants";
import type { StateSnapshot } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import { silentLogger } from "./logger";
import type { ManagerConfig } from "./manager";
import { UNLIMITED_RUNS } from "./run-slots";
import { startService, type RunningService } from "./service";
import { ManualExecutor, until } from "./testing";

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

/** env 一律显式传入：不读测试进程自己的环境变量，结果才不会因机器而异。 */
async function boot(env: NodeJS.ProcessEnv, extra: { executor?: ManualExecutor; managerConfig?: Partial<ManagerConfig> } = {}): Promise<RunningService> {
  const service = await startService({
    home: mkdtempSync(join(tmpdir(), "ensemble-home-")),
    port: 0,
    executors: [extra.executor ?? new ManualExecutor("pi")],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
    env,
    ...(extra.managerConfig ? { managerConfig: extra.managerConfig } : {}),
  });
  running.push(service);
  return service;
}

describe("the concurrency limit of a running service", () => {
  it("is 20 when nothing is configured", async () => {
    const service = await boot({});
    expect(service.manager.capacity()).toEqual({ occupied: 0, max: LIMITS.maxConcurrentRuns, waiting: 0 });
    expect(service.manager.capacity().max).toBe(20);
  });

  it.each([
    ["8", 8],
    [" 12 ", 12],
    ["0", UNLIMITED_RUNS],
    ["unlimited", UNLIMITED_RUNS],
    ["UNLIMITED", UNLIMITED_RUNS],
    ["", 20],
    ["-3", 20],
    ["2.5", 20],
    ["abc", 20],
  ])("reads ENSEMBLE_MAX_CONCURRENT_RUNS=%j as %i, and a bad value never stops the service from starting", async (raw, expected) => {
    const service = await boot({ [ENV.maxConcurrentRuns]: raw });
    expect(service.manager.capacity().max).toBe(expected);
  });

  it("lets an explicit managerConfig win over the environment", async () => {
    const service = await boot({ [ENV.maxConcurrentRuns]: "7" }, { managerConfig: { maxConcurrentRuns: 2 } });
    expect(service.manager.capacity().max).toBe(2);
  });

  it("really queues the session past the environment's limit, and says so", async () => {
    const executor = new ManualExecutor("pi");
    const service = await boot({ [ENV.maxConcurrentRuns]: "2" }, { executor });
    const delegate = (task: string) => service.manager.delegate({ harness: "pi", task, cwd: tmpdir(), origin: testOrigin() });
    const first = await delegate("first");
    await delegate("second");
    const third = await delegate("third");
    await until(() => executor.sessions.length === 2, 4000, "two sessions opened");

    expect(service.hub.state(third.sessionId)?.status).toBe("queued");
    expect(service.manager.capacity()).toEqual({ occupied: 2, max: 2, waiting: 1 });

    executor.sessions.find((session) => session.input.meta.id === first.sessionId)!.complete(first.runId);
    await until(() => executor.sessions.length === 3, 4000, "the third session opened after a slot freed");
    expect(service.manager.capacity()).toMatchObject({ occupied: 2, waiting: 0 });
  });

  it("reaches the page as plain numbers; no limit is 0, never null or Infinity", async () => {
    const service = await boot({ [ENV.maxConcurrentRuns]: "unlimited" });
    const response = await fetch(`${service.url}/api/state`, { headers: { [TOKEN_HEADER]: service.token } });
    const snapshot = (await response.json()) as StateSnapshot;
    expect(snapshot.capacity).toEqual({ occupied: 0, max: UNLIMITED_RUNS, waiting: 0 });
  });
});
