import { describe, expect, it } from "vitest";
import { ENV, LIMITS } from "@shared/constants";
import { DEFAULT_MANAGER_CONFIG } from "./manager";
import { concurrencyFromEnv, maxConcurrentRunsFrom, RunSlots, UNLIMITED_RUNS } from "./run-slots";

const fromValue = (value: string | undefined) => maxConcurrentRunsFrom(value === undefined ? {} : { [ENV.maxConcurrentRuns]: value });

describe("the default concurrency limit", () => {
  it("is 20, so ordinary use never queues", () => {
    expect(LIMITS.maxConcurrentRuns).toBe(20);
    expect(DEFAULT_MANAGER_CONFIG.maxConcurrentRuns).toBe(20);
    expect(maxConcurrentRunsFrom({})).toBe(20);
    expect(new RunSlots(DEFAULT_MANAGER_CONFIG.maxConcurrentRuns).capacity).toEqual({ occupied: 0, max: 20, waiting: 0 });
  });

  it("is overridden by the documented environment variable and no other name", () => {
    expect(ENV.maxConcurrentRuns).toBe("ENSEMBLE_MAX_CONCURRENT_RUNS");
    expect(maxConcurrentRunsFrom({ ENSEMBLE_MAX_CONCURRENT_RUNS: "3" })).toBe(3);
    expect(maxConcurrentRunsFrom({ ENSEMBLE_MAX_CONCURRENT_RUN: "3", MAX_CONCURRENT_RUNS: "3" })).toBe(LIMITS.maxConcurrentRuns);
  });
});

describe("maxConcurrentRunsFrom", () => {
  it.each([
    ["8", 8],
    ["1", 1],
    ["20", 20],
    ["150", 150],
    // 两侧空白是手写环境变量时常见的误差，不是错误：与 service.ts 里其他整数环境变量一样先 trim。
    [" 12 ", 12],
    ["\t7\n", 7],
  ])("reads %j as the limit %i", (raw, expected) => {
    expect(fromValue(raw)).toBe(expected);
  });

  it.each(["0", "unlimited", "UNLIMITED", "Unlimited", " unlimited ", " 0 "])("reads %j as no limit", (raw) => {
    expect(fromValue(raw)).toBe(UNLIMITED_RUNS);
  });

  it.each([
    undefined, "", "   ", "-3", "-0", "2.5", "0.5", "abc", "12abc", "1e2", "0x10", "+5", "Infinity", "NaN", "null", "no limit", "unlimited!",
    "99999999999999999999", // 超出安全整数：不能变成 1e20 这种实际等于“不限”的值，也不能变成 NaN
    "３",                   // 全角数字
  ])("falls back to the default for %j instead of throwing or guessing", (raw) => {
    expect(fromValue(raw)).toBe(LIMITS.maxConcurrentRuns);
  });

  it("only ever returns a value RunSlots accepts", () => {
    for (const raw of [undefined, "", "-1", "1.5", "x", "0", "unlimited", "1", "99999999999999999999"]) {
      expect(() => new RunSlots(fromValue(raw))).not.toThrow();
    }
  });
});

describe("RunSlots with a limit", () => {
  const holder = () => {
    const started: string[] = [];
    return { started, start: (id: string) => () => void started.push(id) };
  };

  it("starts requests immediately up to the limit and makes the next one wait", () => {
    const slots = new RunSlots(2);
    const { started, start } = holder();
    expect(slots.request("a", start("a"))).toBe(true);
    expect(slots.request("b", start("b"))).toBe(true);
    expect(started).toEqual(["a", "b"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 0 });

    expect(slots.request("c", start("c"))).toBe(false);
    expect(started).toEqual(["a", "b"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 1 });
  });

  it("hands a freed slot to the longest-waiting session first", () => {
    const slots = new RunSlots(2);
    const { started, start } = holder();
    for (const id of ["a", "b", "c", "d", "e"]) slots.request(id, start(id));
    expect(started).toEqual(["a", "b"]);

    slots.release("b");
    expect(started).toEqual(["a", "b", "c"]);
    slots.release("a");
    expect(started).toEqual(["a", "b", "c", "d"]);
    slots.release("c");
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 0 });

    slots.release("d");
    slots.release("e");
    expect(slots.capacity).toEqual({ occupied: 0, max: 2, waiting: 0 });
  });

  it("drops a waiting session that gives up, without handing it a slot or losing anyone else's place", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    for (const id of ["a", "b", "c", "d"]) slots.request(id, start(id));
    slots.release("b");
    expect(slots.capacity).toEqual({ occupied: 1, max: 1, waiting: 2 });
    slots.release("a");
    expect(started).toEqual(["a", "c"]);
    slots.release("c");
    expect(started).toEqual(["a", "c", "d"]);
  });

  it("ignores releasing someone who holds nothing, and releasing twice", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    slots.request("a", start("a"));
    slots.request("b", start("b"));
    slots.release("nobody");
    expect(started).toEqual(["a"]);
    slots.release("a");
    slots.release("a");
    expect(started).toEqual(["a", "b"]);
    expect(slots.capacity).toEqual({ occupied: 1, max: 1, waiting: 0 });
  });

  it("lets a session request again after it released", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    slots.request("a", start("a"));
    slots.release("a");
    expect(slots.request("a", start("a"))).toBe(true);
    expect(started).toEqual(["a", "a"]);
    expect(slots.capacity.occupied).toBe(1);
  });
});

describe("RunSlots without a limit", () => {
  it("never makes anyone wait, however many hold a slot", () => {
    const slots = new RunSlots(UNLIMITED_RUNS);
    let started = 0;
    for (let i = 0; i < 1_000; i += 1) {
      expect(slots.request(`s${i}`, () => void (started += 1))).toBe(true);
      expect(slots.capacity.waiting).toBe(0);
    }
    expect(started).toBe(1_000);
    expect(slots.capacity).toEqual({ occupied: 1_000, max: UNLIMITED_RUNS, waiting: 0 });
  });

  it("frees slots on release and tolerates releasing unknown or already released ids", () => {
    const slots = new RunSlots(UNLIMITED_RUNS);
    const noop = () => undefined;
    slots.request("a", noop);
    slots.request("b", noop);
    slots.release("a");
    slots.release("a");
    slots.release("never-requested");
    expect(slots.capacity).toEqual({ occupied: 1, max: UNLIMITED_RUNS, waiting: 0 });
    slots.release("b");
    expect(slots.capacity).toEqual({ occupied: 0, max: UNLIMITED_RUNS, waiting: 0 });
    expect(slots.request("a", noop)).toBe(true);
  });

  it("reports unlimited as 0 so the numbers stay valid JSON", () => {
    expect(UNLIMITED_RUNS).toBe(0);
    const slots = new RunSlots(UNLIMITED_RUNS);
    slots.request("a", () => undefined);
    expect(JSON.parse(JSON.stringify(slots.capacity))).toEqual({ occupied: 1, max: 0, waiting: 0 });
  });

  it("treats Infinity as unlimited and reports it as 0 (Infinity would serialize to null)", () => {
    const slots = new RunSlots(Infinity);
    for (let i = 0; i < 50; i += 1) expect(slots.request(`s${i}`, () => undefined)).toBe(true);
    expect(JSON.parse(JSON.stringify(slots.capacity))).toEqual({ occupied: 50, max: 0, waiting: 0 });
  });
});

describe("RunSlots construction", () => {
  it.each([-1, -Infinity, 1.5, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses %s instead of silently queueing or admitting everyone",
    (max) => {
      expect(() => new RunSlots(max)).toThrow(RangeError);
    },
  );

  it("accepts 1 as the smallest real limit", () => {
    const slots = new RunSlots(1);
    expect(slots.request("a", () => undefined)).toBe(true);
    expect(slots.request("b", () => undefined)).toBe(false);
  });

  it("reports -0 as plain 0: capacity goes out as JSON and is compared with Object.is", () => {
    expect(new RunSlots(-0).capacity.max).toBe(UNLIMITED_RUNS);
  });
});

describe("RunSlots.setMax: changing the limit while sessions are running", () => {
  const holder = () => {
    const started: string[] = [];
    return { started, start: (id: string) => () => void started.push(id) };
  };

  it("starts waiting sessions in the order they asked when the limit goes up, and stops at the new limit", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    for (const id of ["a", "b", "c", "d", "e"]) slots.request(id, start(id));
    expect(started).toEqual(["a"]);

    slots.setMax(3);
    expect(started).toEqual(["a", "b", "c"]);
    expect(slots.capacity).toEqual({ occupied: 3, max: 3, waiting: 2 });

    // 之后释放仍然先到先得，新上限继续生效：每释放一个只补一个。
    slots.release("a");
    expect(started).toEqual(["a", "b", "c", "d"]);
    slots.release("b");
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(slots.capacity).toEqual({ occupied: 3, max: 3, waiting: 0 });
  });

  it("starts everybody who is waiting when the limit is lifted, and nobody waits afterwards", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    for (const id of ["a", "b", "c", "d"]) slots.request(id, start(id));
    slots.setMax(UNLIMITED_RUNS);
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 4, max: UNLIMITED_RUNS, waiting: 0 });
    expect(slots.request("e", start("e"))).toBe(true);
    expect(slots.capacity.waiting).toBe(0);
  });

  it("never takes a slot back when the limit goes down: running sessions keep theirs and new ones queue", () => {
    const slots = new RunSlots(3);
    const { started, start } = holder();
    for (const id of ["a", "b", "c"]) slots.request(id, start(id));

    slots.setMax(1);
    // 占用数暂时高于上限：这是调低的如实结果，不是错误。
    expect(slots.capacity).toEqual({ occupied: 3, max: 1, waiting: 0 });
    expect(slots.request("d", start("d"))).toBe(false);
    expect(slots.request("e", start("e"))).toBe(false);
    expect(started).toEqual(["a", "b", "c"]);
    expect(slots.capacity).toEqual({ occupied: 3, max: 1, waiting: 2 });
  });

  it("hands out slots again only once occupancy is back under the lowered limit", () => {
    const slots = new RunSlots(3);
    const { started, start } = holder();
    for (const id of ["a", "b", "c"]) slots.request(id, start(id));
    slots.setMax(2);
    slots.request("d", start("d"));
    slots.request("e", start("e"));

    // 3 → 2：占用数刚回到上限，还没有空位。
    slots.release("a");
    expect(started).toEqual(["a", "b", "c"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 2 });

    // 2 → 1：有一个空位，只补一个，而且是等得最久的 d。
    slots.release("b");
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 1 });

    slots.release("c");
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 0 });
  });

  it("brings in only the missing slots when a lowered limit is raised again before occupancy has drained", () => {
    const slots = new RunSlots(3);
    const { started, start } = holder();
    for (const id of ["a", "b", "c"]) slots.request(id, start(id));
    slots.setMax(1);
    slots.request("d", start("d"));
    slots.request("e", start("e"));

    slots.setMax(4);
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 4, max: 4, waiting: 1 });
  });

  it("keeps the order of the people waiting across several changes of the limit", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    for (const id of ["a", "b", "c", "d"]) slots.request(id, start(id));

    slots.setMax(2); // b 补上
    slots.setMax(1); // 调低：谁也不动
    slots.release("a");
    expect(started).toEqual(["a", "b"]); // 占用数是 1，不低于上限 1，c 继续等
    slots.release("b");
    expect(started).toEqual(["a", "b", "c"]);
    slots.release("c");
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 1, max: 1, waiting: 0 });
  });

  it("takes a waiting session out of the queue when it gives up, even while the limit is being changed", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    for (const id of ["a", "b", "c"]) slots.request(id, start(id));
    slots.release("b"); // b 还在排队就放弃了
    slots.setMax(2);
    expect(started).toEqual(["a", "c"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 0 });
  });

  it("does nothing, and tells nobody, when the limit stays the same", () => {
    const slots = new RunSlots(2);
    let changes = 0;
    slots.onChange(() => void (changes += 1));
    slots.setMax(2);
    expect(changes).toBe(0);
    slots.setMax(5);
    expect(changes).toBe(1);
  });

  it("can go from a limit to none and back without losing track of who is running", () => {
    const slots = new RunSlots(2);
    const { started, start } = holder();
    for (const id of ["a", "b", "c"]) slots.request(id, start(id));
    slots.setMax(UNLIMITED_RUNS);
    expect(started).toEqual(["a", "b", "c"]);
    slots.setMax(2);
    expect(slots.capacity).toEqual({ occupied: 3, max: 2, waiting: 0 });
    slots.request("d", start("d"));
    slots.release("a");
    slots.release("b");
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 0 });
  });

  it.each([-1, 1.5, Number.NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses %s and keeps the current limit and queue", (value) => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    slots.request("a", start("a"));
    slots.request("b", start("b"));
    expect(() => slots.setMax(value)).toThrow(RangeError);
    expect(slots.capacity).toEqual({ occupied: 1, max: 1, waiting: 1 });
    expect(started).toEqual(["a"]);
  });

  it("reads Infinity as no limit and -0 as 0, the same as the constructor", () => {
    const slots = new RunSlots(1);
    slots.setMax(Infinity);
    expect(slots.capacity.max).toBe(UNLIMITED_RUNS);
    slots.setMax(3);
    slots.setMax(-0);
    expect(slots.capacity.max).toBe(UNLIMITED_RUNS);
  });
});

describe("RunSlots: start callbacks that call back into the slots", () => {
  const holder = () => {
    const started: string[] = [];
    return { started, start: (id: string) => () => void started.push(id) };
  };

  it("copes with a session that releases its own slot as soon as it is started (SessionRuntime.startNext with nothing to send)", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    slots.request("a", start("a"));
    slots.request("b", () => {
      started.push("b");
      slots.release("b");
    });
    slots.request("c", start("c"));
    slots.request("d", start("d"));

    // b 被提升后立刻把名额还回去：c 接上，d 仍在排队，没有重复提升也没有漏。
    slots.setMax(2);
    expect(started).toEqual(["a", "b", "c"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 1 });

    slots.release("a");
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 2, max: 2, waiting: 0 });
  });

  it("queues a request made from inside a start callback behind the people already waiting", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    let lateGranted: boolean | undefined;
    slots.request("a", start("a"));
    slots.request("b", () => {
      started.push("b");
      lateGranted = slots.request("late", start("late"));
    });
    slots.request("c", start("c"));

    slots.setMax(3);
    expect(lateGranted).toBe(false);
    expect(started).toEqual(["a", "b", "c"]);
    expect(slots.capacity).toEqual({ occupied: 3, max: 3, waiting: 1 });

    slots.release("a");
    expect(started).toEqual(["a", "b", "c", "late"]);
  });

  it("starts nobody twice when the limit is changed from inside a start callback", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    slots.request("a", start("a"));
    slots.request("b", () => {
      started.push("b");
      slots.setMax(4);
    });
    slots.request("c", start("c"));
    slots.request("d", start("d"));

    slots.setMax(2);
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 4, max: 4, waiting: 0 });
  });

  it("gives the slot back when a start that runs immediately throws, and carries on", () => {
    const slots = new RunSlots(1);
    expect(() => slots.request("a", () => {
      throw new Error("boom a");
    })).toThrow("boom a");
    expect(slots.capacity).toEqual({ occupied: 0, max: 1, waiting: 0 });
    expect(slots.request("b", () => undefined)).toBe(true);
    expect(slots.capacity).toEqual({ occupied: 1, max: 1, waiting: 0 });
  });

  it("returns the slot of a session whose start throws while the limit goes up, keeps promoting the rest, then reports the first error", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    let changes = 0;
    slots.onChange(() => void (changes += 1));
    slots.request("a", start("a"));
    slots.request("b", () => {
      throw new Error("boom b");
    });
    slots.request("c", start("c"));
    slots.request("d", start("d"));
    const before = changes;

    expect(() => slots.setMax(3)).toThrow("boom b");
    expect(started).toEqual(["a", "c", "d"]);
    expect(slots.capacity).toEqual({ occupied: 3, max: 3, waiting: 0 });
    expect(slots.capacity.max).toBe(3); // 新上限已经生效，错误没有把它回滚
    expect(changes).toBeGreaterThan(before); // 监听者照常被通知：页面不会停在旧数字上
  });

  it("does not leak the slot or block the queue when a start throws during a release either", () => {
    const slots = new RunSlots(1);
    const { started, start } = holder();
    slots.request("a", start("a"));
    slots.request("b", () => {
      throw new Error("boom b");
    });
    slots.request("c", start("c"));

    expect(() => slots.release("a")).toThrow("boom b");
    expect(started).toEqual(["a", "c"]);
    expect(slots.capacity).toEqual({ occupied: 1, max: 1, waiting: 0 });
  });
});

describe("RunSlots.onChange", () => {
  it("tells listeners about every change in occupancy, waiting and limit, with the books already settled", () => {
    const slots = new RunSlots(1);
    const seen: Array<{ occupied: number; max: number; waiting: number }> = [];
    slots.onChange(() => void seen.push(slots.capacity));
    slots.request("a", () => undefined);
    slots.request("b", () => undefined);
    slots.setMax(2);
    slots.release("a");
    expect(seen).toEqual([
      { occupied: 1, max: 1, waiting: 0 },
      { occupied: 1, max: 1, waiting: 1 },
      { occupied: 2, max: 2, waiting: 0 },
      { occupied: 1, max: 2, waiting: 0 },
    ]);
  });

  it("stops telling a listener that unsubscribed", () => {
    const slots = new RunSlots(2);
    let calls = 0;
    const unsubscribe = slots.onChange(() => void (calls += 1));
    slots.request("a", () => undefined);
    expect(calls).toBe(1);
    unsubscribe();
    slots.release("a");
    expect(calls).toBe(1);
  });

  it("is not told about releasing someone who holds nothing", () => {
    const slots = new RunSlots(2);
    let calls = 0;
    slots.onChange(() => void (calls += 1));
    slots.release("nobody");
    expect(calls).toBe(0);
  });

  it("keeps the books straight when a listener throws", () => {
    const slots = new RunSlots(1);
    const started: string[] = [];
    slots.onChange(() => {
      throw new Error("listener bug");
    });
    expect(slots.request("a", () => void started.push("a"))).toBe(true);
    expect(slots.request("b", () => void started.push("b"))).toBe(false);
    slots.setMax(2);
    expect(started).toEqual(["a", "b"]);
    slots.release("a");
    expect(slots.capacity).toEqual({ occupied: 1, max: 2, waiting: 0 });
  });
});

describe("concurrencyFromEnv", () => {
  const read = (value: string | undefined) => concurrencyFromEnv(value === undefined ? {} : { [ENV.maxConcurrentRuns]: value });

  it("says where the limit came from", () => {
    expect(read(undefined)).toEqual({ max: LIMITS.maxConcurrentRuns, source: "default" });
    expect(read("")).toEqual({ max: LIMITS.maxConcurrentRuns, source: "default" });
    expect(read("   ")).toEqual({ max: LIMITS.maxConcurrentRuns, source: "default" });
    expect(read("8")).toEqual({ max: 8, source: "env" });
    expect(read(" 12 ")).toEqual({ max: 12, source: "env" });
    expect(read("0")).toEqual({ max: UNLIMITED_RUNS, source: "env" });
    expect(read("unlimited")).toEqual({ max: UNLIMITED_RUNS, source: "env" });
    expect(read(" UNLIMITED ")).toEqual({ max: UNLIMITED_RUNS, source: "env" });
  });

  it("keeps an unusable value as text for the startup warning, but never uses it", () => {
    expect(read("abc")).toEqual({ max: LIMITS.maxConcurrentRuns, source: "default", ignored: "abc" });
    expect(read(" -3 ")).toEqual({ max: LIMITS.maxConcurrentRuns, source: "default", ignored: "-3" });
    expect(read("2.5")).toEqual({ max: LIMITS.maxConcurrentRuns, source: "default", ignored: "2.5" });
    expect(read("99999999999999999999")).toEqual({ max: LIMITS.maxConcurrentRuns, source: "default", ignored: "99999999999999999999" });
  });

  it("still accepts any positive integer from the environment, beyond the range the settings window allows", () => {
    expect(LIMITS.concurrentRunsSetting.max).toBeLessThan(5000);
    expect(read("5000")).toEqual({ max: 5000, source: "env" });
  });

  it("agrees with maxConcurrentRunsFrom", () => {
    for (const raw of [undefined, "", "3", "0", "unlimited", "abc", "-1"]) {
      expect(concurrencyFromEnv(raw === undefined ? {} : { [ENV.maxConcurrentRuns]: raw }).max).toBe(fromValue(raw));
    }
  });
});
