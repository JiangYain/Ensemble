import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testOrigin } from "@shared/testing";
import { closeTestBridges, setupBridge as setup } from "./bridge.fixtures";
import { prepareDelegateRequest, type DelegateArgs, type DelegateEnvironment, type PreparedDelegation } from "./delegate-request";
import { BridgeInputError } from "./tool-call";

/**
 * 空串或只含空白的 `cwd` 一律按“没传”算：拒绝判断（桥在主目录里、宿主又没有报告工作区时要求显式传 `cwd`）、实际发给服务的目录、回执里的出处，
 * 三处说的是同一回事。以前空串在判断与出处里算“没传”，取值却仍是空串、原样发给服务（400）；只含空白的则被当成传了，同样 400，还躲过了桥这一层的拒绝。
 * 上半部分对着假的环境直接看请求体；下半部分用真服务（临时状态目录、模拟执行端）与进程内的 MCP 客户端走完整的一趟。
 */

afterEach(closeTestBridges);

/** 全空白的几种写法：空串、空格、制表符加换行。 */
const BLANKS = ["", " ", "   ", "\t \n"];

describe("a blank `cwd`, as the request is built", () => {
  const ROOT = join(tmpdir(), "ensemble-cwd-blank");
  const PROJECT = join(ROOT, "project");
  const HOME = join(ROOT, "home");
  const ROOTS = join(ROOT, "roots");
  const ARGUMENT = join(ROOT, "argument");

  interface Situation {
    /** 宿主报告的工作区。 */
    roots?: string;
    /** 桥进程的启动目录。 */
    bridgeDirectory?: string;
  }

  /** `calls` 按先后记下向外界的询问（取会话、读 roots、读宿主记录）。服务声明了全部功能。 */
  function fake(situation: Situation): { environment: DelegateEnvironment; calls: string[] } {
    const calls: string[] = [];
    const environment: DelegateEnvironment = {
      env: {},
      bridgeDirectory: situation.bridgeDirectory ?? PROJECT,
      homeDirectory: HOME,
      sessions: async () => {
        calls.push("sessions");
        return [];
      },
      supports: () => true,
      hostRoots: async () => {
        calls.push("roots");
        return situation.roots ? { path: situation.roots } : undefined;
      },
      readHostRecord: async () => {
        calls.push("record");
        return {};
      },
    };
    return { environment, calls };
  }

  /** `cwd` 缺省（undefined）与“传了某个值”要分开：省略就是真的不带这个键。 */
  const args = (cwd: string | undefined): DelegateArgs => ({ harness: "pi", task: "Do the thing", ...(cwd !== undefined ? { cwd } : {}) });

  function prepare(cwd: string | undefined, situation: Situation = {}): Promise<PreparedDelegation> {
    return prepareDelegateRequest(args(cwd), testOrigin(), fake(situation).environment);
  }

  /** 期望被桥拒绝（消息直接写给主模型看），返回消息与拒绝之前向外界问过什么。 */
  async function refusal(cwd: string | undefined, situation: Situation): Promise<{ message: string; calls: string[] }> {
    const { environment, calls } = fake(situation);
    const error = await prepareDelegateRequest(args(cwd), testOrigin(), environment).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(BridgeInputError);
    return { message: (error as BridgeInputError).message, calls };
  }

  it("goes where the host reports, with the same request as when it is omitted", async () => {
    const omitted = await prepare(undefined, { roots: ROOTS });
    expect(omitted.body.cwd).toBe(ROOTS);
    expect(omitted.cwdSource).toBe("host-roots");
    expect(omitted.body.origin).toMatchObject({ workspace: ROOTS, workspaceSource: "mcp-roots" });

    for (const blank of BLANKS) {
      const prepared = await prepare(blank, { roots: ROOTS });
      expect(prepared.body, JSON.stringify(blank)).toEqual(omitted.body);
      expect(prepared.cwdSource, JSON.stringify(blank)).toBe("host-roots");
    }
  });

  it("falls back to the bridge's own directory, not to an empty string, and gives the origin no workspace", async () => {
    const omitted = await prepare(undefined);
    expect(omitted.body.cwd).toBe(PROJECT);
    expect(omitted.cwdSource).toBe("bridge-directory");
    expect(omitted.body.origin?.workspace).toBeUndefined();

    for (const blank of BLANKS) {
      const prepared = await prepare(blank);
      expect(prepared.body, JSON.stringify(blank)).toEqual(omitted.body);
      expect(prepared.cwdSource, JSON.stringify(blank)).toBe("bridge-directory");
    }
  });

  it("is still refused in the home directory when the host reports nothing, with the same message and before anything else is asked", async () => {
    const omitted = await refusal(undefined, { bridgeDirectory: HOME });
    expect(omitted.message).toContain("started from the user's home directory");
    expect(omitted.calls).toEqual(["sessions", "roots"]);

    for (const blank of BLANKS) {
      const refused = await refusal(blank, { bridgeDirectory: HOME });
      expect(refused.message, JSON.stringify(blank)).toBe(omitted.message);
      expect(refused.calls, JSON.stringify(blank)).toEqual(omitted.calls);
    }
  });

  it("changes nothing for a value that is not blank: a real path is handed over as written, padded or not", async () => {
    const plain = await prepare(ARGUMENT, { roots: ROOTS });
    expect(plain.body.cwd).toBe(ARGUMENT);
    expect(plain.cwdSource).toBe("argument");

    // 只有全空白算“没传”；带空白的真实路径照原样交给服务，由服务校验（它会说“必须是绝对路径”）。
    const padded = await prepare(` ${ARGUMENT} `, { roots: ROOTS });
    expect(padded.body.cwd).toBe(` ${ARGUMENT} `);
    expect(padded.cwdSource).toBe("argument");
  });
});

describe("a blank `cwd`, through the bridge and a real service", () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), "ensemble-cwd-blank-"));

  /** 三种写法的“没传”。每个写法各用一个任务，免得被当成 120 秒内的重复委派。 */
  const VARIANTS: { label: string; cwd?: string }[] = [{ label: "omitted" }, { label: "empty string", cwd: "" }, { label: "only spaces", cwd: "   " }];
  const delegation = (variant: { cwd?: string }, index: number): Record<string, unknown> => ({
    harness: "pi",
    task: `[fixture:quick] hello ${index}`,
    ...(variant.cwd !== undefined ? { cwd: variant.cwd } : {}),
  });

  it("starts the session in the folder the host reports, and says so, however the missing cwd is written", async () => {
    const root = dir();
    const { call, service } = await setup({ clientName: "codex-mcp-client", roots: [root], cwd: dir() });

    for (const [index, variant] of VARIANTS.entries()) {
      const delegated = await call("delegate", delegation(variant, index));
      expect(delegated.isError, `${variant.label}: ${delegated.text}`).toBe(false);
      expect(delegated.text, variant.label).toContain("workspace source: the workspace folder reported by the host");
      const summary = service.hub.summary(delegated.data?.["sessionId"] as string);
      expect(summary?.cwd.toLowerCase(), variant.label).toBe(root.toLowerCase());
      expect(summary?.origin.workspaceSource, variant.label).toBe("mcp-roots");
    }
  });

  it("starts the session in the bridge's directory, and says that is a fallback, however the missing cwd is written", async () => {
    const bridgeDirectory = dir();
    const { call, service } = await setup({ cwd: bridgeDirectory });

    for (const [index, variant] of VARIANTS.entries()) {
      const delegated = await call("delegate", delegation(variant, index));
      expect(delegated.isError, `${variant.label}: ${delegated.text}`).toBe(false);
      expect(delegated.text, variant.label).toContain("workspace source: the bridge process directory");
      expect(delegated.text, variant.label).toContain("pass `cwd` explicitly");
      const summary = service.hub.summary(delegated.data?.["sessionId"] as string);
      expect(summary?.cwd.toLowerCase(), variant.label).toBe(bridgeDirectory.toLowerCase());
      // 来源的工作目录不拿桥进程目录凑数。
      expect(summary?.origin, variant.label).not.toHaveProperty("workspace");
    }
  });

  it("refuses to guess the project in the home directory, with the same message however the missing cwd is written, and never asks the service to create anything", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "ensemble-fake-home-"));
    const { call, sessions, requested } = await setup({ cwd: homeDirectory, homeDirectory });

    const refusals: string[] = [];
    for (const [index, variant] of VARIANTS.entries()) {
      const refused = await call("delegate", delegation(variant, index));
      expect(refused.isError, variant.label).toBe(true);
      refusals.push(refused.text);
    }

    expect(refusals[0]).toContain("home directory");
    expect(refusals[0]).toContain("Call `delegate` again with `cwd`");
    expect(new Set(refusals).size, "the refusal is the same for every way of not passing cwd").toBe(1);
    expect(sessions()).toHaveLength(0);
    // 创建会话是对 /api/sessions 的 POST（取会话清单的 GET 带着查询串）：一个都没有发出去，不是发出去之后被服务拒绝。
    expect(requested.filter((url) => url.endsWith("/api/sessions"))).toEqual([]);
  });
});
