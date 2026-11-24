import { describe, expect, it } from "vitest";
import type { HarnessInfo } from "@shared/types";
import { silentLogger } from "../logger";
import { ManualExecutor, READY_INFO } from "../testing";
import { ExecutorRegistry } from "./registry";
import type { Executor } from "./types";

/** 探测由测试手动放行的执行端，并统计探测次数。 */
class SlowProbeExecutor extends ManualExecutor {
  probes = 0;
  private pending: ((info: HarnessInfo) => void)[] = [];
  failWith: Error | undefined;

  override probe(): Promise<HarnessInfo> {
    this.probes += 1;
    if (this.failWith) return Promise.reject(this.failWith);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  release(patch: Partial<HarnessInfo> = {}): void {
    const info = { ...READY_INFO(this.id, patch), checkedAt: `t${this.probes}` };
    for (const resolve of this.pending.splice(0)) resolve(info);
  }
}

function setup(executor: Executor = new SlowProbeExecutor("codex")) {
  let clock = 1_000_000;
  const registry = new ExecutorRegistry([executor], silentLogger, { now: () => clock });
  const updates: HarnessInfo[] = [];
  registry.onUpdate((info) => updates.push(info));
  return { registry, updates, advance: (ms: number) => (clock += ms) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ExecutorRegistry", () => {
  it("waits for a cold probe and runs it once for concurrent callers", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry } = setup(executor);
    const first = registry.info("codex");
    const second = registry.info("codex");
    executor.release();
    expect((await first)?.status).toBe("ready");
    expect(await second).toBe(await first);
    expect(executor.probes).toBe(1);
  });

  it("serves the cached result while it is fresh", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry, advance } = setup(executor);
    const pending = registry.info("codex");
    executor.release();
    await pending;
    advance(30_000);
    await registry.info("codex");
    expect(executor.probes).toBe(1);
  });

  it("returns a stale ready result immediately and refreshes in the background", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry, updates, advance } = setup(executor);
    const cold = registry.info("codex");
    executor.release({ defaultModel: "model-a" });
    await cold;

    advance(5 * 60_000);
    const stale = await registry.info("codex");
    expect(stale?.defaultModel).toBe("model-a");
    expect(executor.probes).toBe(2);

    // 刷新在后台完成并带来了变化：缓存更新，并通知监听者。
    executor.release({ defaultModel: "model-b" });
    await tick();
    expect((await registry.info("codex"))?.defaultModel).toBe("model-b");
    expect(updates.map((info) => info.defaultModel)).toEqual(["model-a", "model-b"]);
  });

  it("does not use a stale result that is not ready, so a user who just fixed their setup sees the truth", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry, advance } = setup(executor);
    const cold = registry.info("codex");
    executor.release({ status: "needs_setup", setup: { code: "codex_login_required", message: "sign in" } });
    await cold;

    advance(90_000);
    const refreshed = registry.info("codex");
    executor.release({ status: "ready" });
    expect((await refreshed)?.status).toBe("ready");
  });

  it("does not use a result older than the stale window at all", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry, advance } = setup(executor);
    const cold = registry.info("codex");
    executor.release({ defaultModel: "old" });
    await cold;

    advance(11 * 60_000);
    const refreshed = registry.info("codex");
    executor.release({ defaultModel: "new" });
    expect((await refreshed)?.defaultModel).toBe("new");
  });

  it("forces a fresh probe on request", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry } = setup(executor);
    const cold = registry.info("codex");
    executor.release();
    await cold;
    const forced = registry.info("codex", { force: true });
    executor.release();
    await forced;
    expect(executor.probes).toBe(2);
  });

  it("snapshots instantly with a 'checking' placeholder and fills in when the probe finishes", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry, updates } = setup(executor);
    const placeholder = registry.snapshot();
    expect(placeholder).toEqual([expect.objectContaining({ id: "codex", displayName: "Codex", status: "checking", models: [] })]);
    expect(executor.probes).toBe(1);

    // 再次取快照不会重复探测。
    registry.snapshot();
    expect(executor.probes).toBe(1);

    executor.release();
    await tick();
    expect(updates).toEqual([expect.objectContaining({ id: "codex", status: "ready" })]);
    expect(registry.snapshot()[0]?.status).toBe("ready");
  });

  it("warms every harness in the background without blocking", async () => {
    const executor = new SlowProbeExecutor("pi");
    const { registry } = setup(executor);
    registry.warm();
    registry.warm();
    expect(executor.probes).toBe(1);
  });

  it("stays quiet when a refresh only changes the check time", async () => {
    const executor = new SlowProbeExecutor("codex");
    const { registry, updates } = setup(executor);
    const cold = registry.info("codex");
    executor.release();
    await cold;
    const forced = registry.info("codex", { force: true });
    executor.release();
    await forced;
    expect(updates).toHaveLength(1);
  });

  it("turns a throwing probe into an unavailable harness with a reason, and still notifies", async () => {
    const executor = new SlowProbeExecutor("codex");
    executor.failWith = new Error("spawn exploded");
    const { registry, updates } = setup(executor);
    const info = await registry.info("codex");
    expect(info).toMatchObject({ status: "unavailable", setup: { code: "probe_failed", message: "spawn exploded" } });
    expect(updates).toHaveLength(1);
  });

  it("returns undefined for harnesses that are not enabled", async () => {
    const { registry } = setup();
    expect(await registry.info("cursor")).toBeUndefined();
  });
});

describe("ExecutorRegistry with a model policy", () => {
  const catalog = [{ id: "a", label: "A" }, { id: "b", label: "B" }];

  function withPolicy() {
    const executor = new SlowProbeExecutor("codex");
    let allowed: string[] | undefined;
    const registry = new ExecutorRegistry([executor], silentLogger, { policy: { modelSettings: () => allowed === undefined ? {} : { allowedModels: allowed } } });
    const updates: HarnessInfo[] = [];
    registry.onUpdate((info) => updates.push(info));
    return { executor, registry, updates, setAllowed: (next: string[] | undefined) => void (allowed = next) };
  }

  it("attaches the user's allowed models to what it returns, without touching the full catalog", async () => {
    const { executor, registry, setAllowed } = withPolicy();
    setAllowed(["b"]);
    const pending = registry.info("codex");
    executor.release({ models: catalog });
    const info = await pending;
    expect(info?.allowedModels).toEqual(["b"]);
    expect(info?.models.map((model) => model.id)).toEqual(["a", "b"]);
    expect(registry.snapshot()[0]?.allowedModels).toEqual(["b"]);
    expect((await registry.all())[0]?.allowedModels).toEqual(["b"]);
  });

  it("adds nothing when there is no restriction, and hands out the same object as before", async () => {
    const { executor, registry } = withPolicy();
    const first = registry.info("codex");
    executor.release({ models: catalog });
    const info = await first;
    expect(info && "allowedModels" in info).toBe(false);
    expect(await registry.info("codex")).toBe(info);
  });

  it("applies a changed list at once, without probing again, and the placeholder carries it too", async () => {
    const { executor, registry, setAllowed } = withPolicy();
    setAllowed(["a"]);
    expect(registry.snapshot()[0]).toMatchObject({ status: "checking", allowedModels: ["a"] });
    const cold = registry.info("codex");
    executor.release({ models: catalog });
    await cold;

    setAllowed(["a", "b"]);
    expect((await registry.info("codex"))?.allowedModels).toEqual(["a", "b"]);
    setAllowed(undefined);
    expect((await registry.info("codex"))?.allowedModels).toBeUndefined();
    expect(executor.probes).toBe(1);
  });

  it("publishes a list change even before the first probe completes", async () => {
    const { executor, registry, updates, setAllowed } = withPolicy();
    setAllowed(["a"]);
    registry.policyChanged("codex");
    expect(updates[0]).toMatchObject({ id: "codex", status: "checking", allowedModels: ["a"] });
    expect(executor.probes).toBe(0);

    const cold = registry.info("codex");
    executor.release({ models: catalog });
    await cold;
    expect(updates[1]).toMatchObject({ id: "codex", status: "ready", allowedModels: ["a"] });

    setAllowed(["b"]);
    registry.policyChanged("codex");
    expect(updates).toHaveLength(3);
    expect(updates[2]).toMatchObject({ id: "codex", allowedModels: ["b"] });
  });

  it("a later probe of the same catalog does not forget the list or fire a spurious update", async () => {
    const { executor, registry, updates, setAllowed } = withPolicy();
    setAllowed(["a"]);
    const cold = registry.info("codex");
    executor.release({ models: catalog });
    await cold;
    const forced = registry.info("codex", { force: true });
    executor.release({ models: catalog });
    expect((await forced)?.allowedModels).toEqual(["a"]);
    expect(updates).toHaveLength(1);
  });
});
