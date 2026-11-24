import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPair, selectBoth } from "./engine.fixtures";

const log = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("./positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./positions")>();
  return {
    ...actual,
    readPositions: (spaceKey?: string) => {
      log.events.push(`read ${spaceKey ?? "(none)"}`);
      return actual.readPositions(spaceKey);
    },
  };
});

/**
 * 特征化测试：切换工作空间时几件事发生的先后——只有把“谁先谁后”记成一条流水才看得出来的那种。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("canvas workspaces: the order things happen in when the space is switched", () => {
  beforeEach(() => {
    localStorage.clear();
    log.events.length = 0;
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("reads the new space's positions before it tells anyone that the selection is gone", () => {
    const { engine } = mountPair();
    try {
      selectBoth(engine);
      engine.subscribeSelection(() => log.events.push(`selection ${engine.getSelectedIds().length}`));
      log.events.length = 0;
      engine.switchSpace("b");
      expect(log.events).toEqual(["read b", "selection 0"]);
    } finally {
      engine.unmount();
    }
  });
});
