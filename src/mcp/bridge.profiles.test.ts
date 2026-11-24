import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import type { ModelInfo } from "@shared/types";
import { ManualExecutor, READY_INFO } from "../server/testing";
import { EnsembleBridge } from "./bridge";
import { closeTestBridges, connectBridge, connectTestBridge, simulateOlderService, startTestService, tempHome } from "./bridge.fixtures";
import type { ServiceClient } from "./client";

/**
 * 委派角色在 MCP 这一层：`delegate` 的 `profile` 参数与回执、`harnesses` 里的角色清单、错误的提法，
 * 以及新旧版本互相遇到时的样子（新桥 + 老服务、新服务 + 老桥）。文字规则本身（一行怎么写）在 format-profiles.test.ts。
 * 全部用临时状态目录与假执行端，从不碰真实的 settings.json。
 */

afterEach(closeTestBridges);

const models: ModelInfo[] = [
  { id: "m-fast", label: "Fast", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
  { id: "m-big", label: "Big", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

interface Setup {
  /** 启动前就放在状态目录里的 settings.json（原样写入）。 */
  settings?: string;
  /** 把服务写下的 service.json 改成老服务写的样子：没有 features 字段。 */
  old?: boolean;
}

async function setup(options: Setup = {}) {
  const home = tempHome("ensemble-mcp-profiles-");
  if (options.settings !== undefined) writeFileSync(join(home, "settings.json"), options.settings);
  const service = await startTestService({
    home,
    executors: [new ManualExecutor("codex", { models }), new ManualExecutor("pi", { models })],
    env: {},
  });
  // 模拟老服务：在桥发出第一个请求之前改（它在第一次请求时才读 service.json）。
  if (options.old) simulateOlderService(service);
  const bridge = await connectTestBridge(service);

  const headers = { [TOKEN_HEADER]: service.token, "content-type": "application/json" };
  return {
    service,
    ...bridge,
    /** 用户在设置里定义角色（走服务的 HTTP 入口，和网页是同一条路）。 */
    async role(name: string, spec: Record<string, unknown>) {
      const response = await fetch(`${service.url}/api/profiles/${name}`, { method: "PUT", headers, body: JSON.stringify(spec) });
      expect(response.status).toBe(200);
    },
    /** 用户在设置里限制某个执行端开放的模型。 */
    async allow(harness: string, allowed: string[] | null) {
      const response = await fetch(`${service.url}/api/harnesses/${harness}/models`, { method: "PUT", headers, body: JSON.stringify({ allowed }) });
      expect(response.status).toBe(200);
    },
  };
}

const VERIFY = { harness: "codex", model: "m-big", effort: "high", access: "read_only" };
const task = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ task: "Review the diff", cwd: tmpdir(), ...extra });

describe("delegate：参数", () => {
  it("harness 不再必填，profile 是新的可选参数：说明里讲清覆盖规则与“二选一”", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const delegate = tools.find((tool) => tool.name === "delegate")!;
    expect(delegate.inputSchema.required).toEqual(["task"]);
    const properties = delegate.inputSchema.properties as Record<string, { type?: string; minLength?: number; maxLength?: number; description?: string }>;
    expect(properties["profile"]).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(properties["profile"]?.description).toMatch(/role the user defined/);
    expect(properties["profile"]?.description).toMatch(/overrides/);
    expect(properties["profile"]?.description).toMatch(/different `harness` also drops the role's model and effort/);
    expect(properties["harness"]?.description).toMatch(/Required unless you pass `profile`/);
    expect(tools).toHaveLength(8);
  });

  it("harnesses 的说明提到角色", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "harnesses")?.description).toMatch(/roles the user defined/);
  });

  it("harness 与 profile 都没给：在请求服务之前就拒绝，说清两条出路，没有任何会话被创建", async () => {
    const { call, service } = await setup();
    const result = await call("delegate", task());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Give `harness`, or `profile`");
    expect(result.text).toContain("call `harnesses` to see them");
    expect(service.hub.allSummaries()).toHaveLength(0);
  });
});

describe("delegate：按角色委派", () => {
  it("会话用的是角色的取值；回执一行写明每个字段取自哪里；结构化结果带着同一份来由", async () => {
    const { call, role, service } = await setup();
    await role("verify", VERIFY);
    const result = await call("delegate", task({ profile: "verify" }));
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Delegated to ");
    expect(result.text).toContain('role "verify": harness, model, effort, access from the role.');
    expect(result.text).not.toContain("not applied from the role");
    expect(result.data).toMatchObject({
      harness: "codex",
      profile: { name: "verify", sources: { harness: "profile", model: "profile", effort: "profile", access: "profile" } },
    });
    expect(service.hub.summary(result.data?.["sessionId"] as string)).toMatchObject({ harness: "codex", model: { requested: "m-big" }, effort: "high", access: "read_only" });
  });

  it("名字对大小写宽容；角色只固定了执行端时，其余照默认（回执里写 by default）", async () => {
    const { call, role, service } = await setup();
    await role("scout", { harness: "pi" });
    const result = await call("delegate", task({ profile: "Scout" }));
    expect(result.isError).toBe(false);
    expect(result.text).toContain('role "scout": harness from the role; model, effort, access by default.');
    expect(service.hub.summary(result.data?.["sessionId"] as string)).toMatchObject({ harness: "pi", access: "full" });
  });

  it("显式传的参数覆盖角色里的同名字段，回执如实说角色的哪个值没有用上", async () => {
    const { call, role, service } = await setup();
    await role("verify", VERIFY);
    const result = await call("delegate", task({ profile: "verify", effort: "low", access: "full" }));
    expect(result.isError).toBe(false);
    expect(result.text).toContain('role "verify": harness, model from the role; effort, access from your call.');
    expect(result.text).toContain('not applied from the role: effort "high" (you passed another effort); access "read_only" (you passed another access level).');
    expect(service.hub.summary(result.data?.["sessionId"] as string)).toMatchObject({ harness: "codex", model: { requested: "m-big" }, effort: "low", access: "full" });
  });

  it("显式换了模型：角色的强度不继承，回执说明它属于角色的模型", async () => {
    const { call, role } = await setup();
    await role("verify", VERIFY);
    const result = await call("delegate", task({ profile: "verify", model: "m-fast" }));
    expect(result.isError).toBe(false);
    expect(result.text).toContain('not applied from the role: model "m-big" (you passed another model); effort "high" (it belongs to the role\'s model, not the one you passed).');
  });

  it("显式换了执行端：角色的模型与强度不会套到另一个执行端上，回执说明它们属于角色的执行端；访问权限继承", async () => {
    const { call, role, service } = await setup();
    await role("verify", VERIFY);
    const result = await call("delegate", task({ profile: "verify", harness: "pi" }));
    expect(result.isError).toBe(false);
    expect(result.text).toContain('role "verify": access from the role; harness from your call; model, effort by default.');
    expect(result.text).toContain(
      'not applied from the role: harness "codex" (you passed another harness); ' +
        'model "m-big" (it belongs to the role\'s harness, not the one you passed); ' +
        'effort "high" (it belongs to the role\'s harness, not the one you passed).',
    );
    const summary = service.hub.summary(result.data?.["sessionId"] as string)!;
    expect(summary.harness).toBe("pi");
    expect(summary.model).toBeUndefined();
    expect(summary.access).toBe("read_only");
  });

  it("不带 profile 的委派照旧：没有角色那一行，结构化结果里也没有 profile（新服务 + 老桥看到的就是这样）", async () => {
    const { call, role } = await setup();
    await role("verify", VERIFY);
    const result = await call("delegate", task({ harness: "pi", model: "m-big" }));
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("role \"");
    expect(result.data).not.toHaveProperty("profile");
  });

  it("同一个角色连发两次是重复（判重按解析之后的实际取值，细节见 service.profiles.test.ts）：第二次得到已有的会话并如实说明，回执仍带着角色", async () => {
    const { call, role, service } = await setup();
    await role("verify", VERIFY);
    const first = await call("delegate", task({ profile: "verify" }));
    const second = await call("delegate", task({ profile: "verify" }));
    expect(second.isError).toBe(false);
    expect(second.text).toContain("Not delegated again");
    expect(second.data).toMatchObject({ duplicate: true, sessionId: first.data?.["sessionId"], profile: { name: "verify" } });
    expect(service.hub.allSummaries()).toHaveLength(1);
  });
});

describe("delegate：角色不存在、用不了", () => {
  it("名字不存在：错误里列出用户定义的角色，并点明两条出路；没有会话被创建", async () => {
    const { call, role, service } = await setup();
    await role("verify", VERIFY);
    await role("scout", { harness: "pi" });
    const result = await call("delegate", task({ profile: "ghost", harness: "pi" }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('There is no role named "ghost". Roles defined by the user: verify, scout.');
    expect(result.text).toContain("Use one of those names as `profile`, or pass `harness` instead.");
    expect(service.hub.allSummaries()).toHaveLength(0);
  });

  it("用户一个角色都没定义：说清这一点（不再叠加“用这些名字”的建议）", async () => {
    const { call } = await setup();
    const result = await call("delegate", task({ profile: "verify" }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the user has not defined any roles");
    expect(result.text).not.toContain("Use one of those names");
  });

  it("角色此刻用不了：错误点名角色与原因，附上出路；绝不悄悄退回默认，也不再叠加别的建议", async () => {
    const { call, role, allow, service } = await setup();
    await role("stale", { harness: "pi", model: "m-big" });
    await allow("pi", ["m-fast"]);
    const result = await call("delegate", task({ profile: "stale" }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Role "stale" cannot be used right now: model "m-big" is not open for harness "pi" (open: m-fast).');
    expect(result.text).toContain("Ensemble Settings, under Roles");
    expect(result.text).toContain("explicit values override the role");
    expect(result.text).not.toContain("[profile_unusable]");
    expect(service.hub.allSummaries()).toHaveLength(0);

    // 显式给一个被开放的模型就能用：显式的盖过角色里用不了的那一项。
    const rescued = await call("delegate", task({ profile: "stale", model: "m-fast" }));
    expect(rescued.isError).toBe(false);
  });

  it("设置文件读不了：角色没法解析，错误写明原因，并告诉主 Agent 重试没有用", async () => {
    const { call } = await setup({ settings: "{ nope" });
    const result = await call("delegate", task({ profile: "verify" }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Role "verify" cannot be resolved');
    expect(result.text).toContain("retrying will not help");
  });
});

describe("新桥遇到老服务", () => {
  it("带 profile 就拦住（老服务会悄悄丢掉不认识的字段，角色里的模型、强度、只读就没了），请求根本没有发出去；用 harness 的委派照常", async () => {
    const { call, role, service } = await setup({ old: true });
    await role("verify", VERIFY);

    const refused = await call("delegate", task({ profile: "verify" }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("older than this plugin and does not know roles");
    expect(refused.text).toContain("instead of `profile`");
    // 同时给了 harness 也一样：老服务会丢掉 profile，只按 harness 执行，等于悄悄忽略了角色。
    const withHarness = await call("delegate", task({ profile: "verify", harness: "pi" }));
    expect(withHarness.isError).toBe(true);
    expect(withHarness.text).toContain("older than this plugin");
    expect(service.hub.allSummaries()).toHaveLength(0);

    const plain = await call("delegate", task({ harness: "pi" }));
    expect(plain.isError).toBe(false);
    expect(service.hub.allSummaries()).toHaveLength(1);
  });

  it("老服务的 harnesses 回复没有 profiles 字段：输出与以前完全一样，没有角色块", async () => {
    // 假的服务端客户端：只回答 harnesses，回复里没有 profiles（老服务的形状）。
    const requests: string[] = [];
    const stub = {
      request: async (method: string, path: string) => {
        requests.push(`${method} ${path}`);
        if (path.startsWith("/api/harnesses")) return { harnesses: [READY_INFO("pi")] };
        throw new Error("not available");
      },
    } as unknown as ServiceClient;
    // paths 只有排查日志用得到：放进临时目录。
    const paths = { originDebugLog: join(mkdtempSync(join(tmpdir(), "ensemble-mcp-stub-")), "origin-debug.log") } as never;
    const bridge = new EnsembleBridge({ paths, version: "test", env: {}, cwd: tmpdir(), client: stub, openExternal: () => {} });
    const { call } = await connectBridge(bridge);

    const result = await call("harnesses");
    expect(result.text).toContain("pi — ");
    expect(result.text).not.toContain("Roles");
    expect(result.data).not.toHaveProperty("profiles");
    expect(result.data).not.toHaveProperty("profilesIssue");
    expect(requests).toContain("GET /api/harnesses");
  });
});

describe("harnesses：角色清单", () => {
  it("用户没有定义角色：什么也不多输出（每个回合都会进上下文的字，没有就一个都不该有）", async () => {
    const { call } = await setup();
    const result = await call("harnesses");
    expect(result.isError).toBe(false);
    expect(result.text).not.toMatch(/Roles/);
    expect(result.text).not.toMatch(/profile/);
    expect(result.data).not.toHaveProperty("profiles");
    expect(result.data).not.toHaveProperty("profilesIssue");
    expect(result.data?.["harnesses"]).toHaveLength(2);
  });

  it("有角色：一行一个，写明固定了什么、没固定的此刻会落成什么，能不能用、为什么不能", async () => {
    const { call, role, allow } = await setup();
    await role("verify", VERIFY);
    await role("scout", { harness: "pi" });
    await allow("pi", ["m-fast"]);
    await role("stale", { harness: "pi", model: "m-big" });

    const result = await call("harnesses");
    expect(result.isError).toBe(false);
    const block = result.text.slice(result.text.indexOf("Roles —"));
    expect(block).toContain("Pass a name as `profile` to `delegate`");
    expect(block).toContain("anything you pass explicitly overrides the role");
    expect(block).toContain("• verify — codex · model m-big · effort high · access read_only — usable now");
    expect(block).toContain("• scout — pi · model m-fast (default) · effort low (default) · access full (default) — usable now");
    expect(block).toContain('• stale — pi · model m-big · access full (default) — NOT usable now: model "m-big" is not open for harness "pi" (open: m-fast)');
    // 角色块排在执行端清单之后，按创建顺序。
    expect(result.text.indexOf("• pi")).toBeLessThan(result.text.indexOf("Roles —"));
    expect(block.indexOf("• verify")).toBeLessThan(block.indexOf("• scout"));
    expect(block.indexOf("• scout")).toBeLessThan(block.indexOf("• stale"));
  });

  it("结构化结果里的角色：配置原样给出，能用时给实际会落成什么，不能用时给原因代码与原文", async () => {
    const { call, role, allow } = await setup();
    await role("verify", VERIFY);
    await allow("pi", ["m-fast"]);
    await role("stale", { harness: "pi", model: "m-big" });

    const profiles = (await call("harnesses")).data?.["profiles"] as Record<string, unknown>[];
    expect(profiles).toEqual([
      {
        name: "verify",
        usable: true,
        harness: "codex",
        model: "m-big",
        effort: "high",
        access: "read_only",
        effective: { harness: "codex", access: "read_only", enforcement: "enforced", model: "m-big", effort: "high" },
      },
      {
        name: "stale",
        usable: false,
        harness: "pi",
        model: "m-big",
        reason: "model_not_open",
        why: 'model "m-big" is not open for harness "pi" (open: m-fast)',
      },
    ]);
  });

  it("设置文件读不了：说“角色此刻不可用”（它不是“没有角色”），结构化结果里给原因", async () => {
    const { call } = await setup({ settings: "{ nope" });
    const result = await call("harnesses");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Roles: unavailable");
    expect(result.text).toContain("Delegation itself is refused until then, even with an explicit `harness`.");
    expect(result.data).toMatchObject({ profilesIssue: "unreadable_file" });
    expect(result.data).not.toHaveProperty("profiles");
  });

  it("角色改了，下一次调用立即是新的（没有桥这一层的缓存）：删掉之后清单消失", async () => {
    const { call, role, service } = await setup();
    await role("verify", VERIFY);
    expect((await call("harnesses")).text).toContain("• verify");

    await fetch(`${service.url}/api/profiles/verify`, { method: "DELETE", headers: { [TOKEN_HEADER]: service.token } });
    const after = await call("harnesses");
    expect(after.text).not.toContain("• verify");
    expect(after.text).not.toMatch(/Roles/);
  });
});
