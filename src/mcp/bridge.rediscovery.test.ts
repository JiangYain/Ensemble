import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import type { DelegateRequest } from "@shared/protocol";
import type { RunningService } from "../server/service";
import { ManualExecutor } from "../server/testing";
import { EnsembleBridge } from "./bridge";
import { closeTestBridges, connectBridge, simulateOlderService, startTestService } from "./bridge.fixtures";
import { ServiceClient } from "./client";

/**
 * 委派的请求体是按桥当时连着的服务的能力（service.json 的 features）写的。发出去的时候连接被拒绝，桥重新发现服务再发一次——
 * 重新发现之后连上的可能是另一个版本：老服务会把不认识的 `profile` 静默丢掉，角色里的只读就变成了完全访问。
 * 这里在 POST 的那一刻把服务换成“老服务”（只是改 service.json，服务本身还是新的），看桥发出了什么、对主 Agent 说了什么。
 * 用真服务（临时状态目录、模拟执行端）与进程内的 MCP 客户端；“桥 ↔ 服务”仍是真实的本地 HTTP，只有被拒绝的那一次是造出来的。
 */

afterEach(closeTestBridges);

interface Sent {
  method: string;
  path: string;
  body: string | undefined;
}

/** 与连接被拒绝时 fetch 抛出的错误同一个形状：TypeError，原因里带 ECONNREFUSED。 */
function connectionRefused(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
}

async function setup() {
  const service = await startTestService({
    homePrefix: "ensemble-mcp-rediscovery-",
    executors: [new ManualExecutor("codex"), new ManualExecutor("pi")],
    env: {},
  });
  const sent: Sent[] = [];
  let refuseNext: (() => void) | undefined;
  const client = new ServiceClient({
    paths: service.paths,
    ensure: async () => {
      throw new Error("the service should already be running");
    },
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      sent.push({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
      if (refuseNext && method === "POST" && url.pathname === "/api/sessions") {
        const beforeRefusing = refuseNext;
        refuseNext = undefined;
        beforeRefusing();
        throw connectionRefused();
      }
      return fetch(input, init);
    }) satisfies typeof fetch,
  });
  const bridge = new EnsembleBridge({ paths: service.paths, version: "test", env: {}, cwd: tmpdir(), client, openExternal: () => {} });
  const session = await connectBridge(bridge);
  return {
    service,
    session,
    sent,
    /** 下一次 `POST /api/sessions` 发不出去（连接被拒绝）；发之前先做 `beforeRefusing`（例如把服务换成老版本）。只作用一次。 */
    refuseNextDelegation(beforeRefusing: () => void = () => {}): void {
      refuseNext = beforeRefusing;
    },
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** 发给 `POST /api/sessions` 的请求体，按发出的先后。 */
function delegationBodies({ sent }: Harness): DelegateRequest[] {
  return sent
    .filter((request) => request.method === "POST" && request.path === "/api/sessions")
    .map((request) => JSON.parse(request.body ?? "{}") as DelegateRequest);
}

/** 用户在设置里定义角色（走服务的 HTTP 入口，和网页是同一条路）。 */
async function defineRole(service: RunningService, name: string, spec: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${service.url}/api/profiles/${name}`, {
    method: "PUT",
    headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
  expect(response.status).toBe(200);
}

const READER = { harness: "codex", access: "read_only" };
const reading = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ profile: "reader", harness: "codex", task: "Review the parser", cwd: tmpdir(), ...extra });

describe("a delegation that has to be re-sent after the service is re-discovered", () => {
  it("is not handed to an older service that would drop `profile` and run the role's read-only session with Full Access", async () => {
    const harness = await setup();
    await defineRole(harness.service, "reader", READER);
    let advertised: readonly string[] | undefined;
    // 请求体按新服务写好、发出去时连接被拒绝；桥重新发现，看到的是不认识角色的老服务。
    harness.refuseNextDelegation(() => {
      advertised = simulateOlderService(harness.service);
    });

    const result = await harness.session.call("delegate", reading());

    expect(advertised, "the new service advertises roles, so the switch really took roles away").toContain("delegation-profiles");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("older than this plugin and does not know roles");
    expect(result.text).toContain("`profile` would be ignored");
    // 只发出过被拒绝的那一次；老服务那边什么都没有被创建，更没有一个 Full Access 的会话。
    expect(delegationBodies(harness)).toHaveLength(1);
    expect(harness.service.hub.allSummaries()).toEqual([]);
  });

  it("is sent again unchanged when the service that answers declares the same abilities (the usual case: it was only restarted)", async () => {
    const harness = await setup();
    await defineRole(harness.service, "reader", READER);
    harness.refuseNextDelegation();

    const result = await harness.session.call("delegate", reading());

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("access: read_only");
    const [refused, resent] = harness.sent.filter((request) => request.method === "POST" && request.path === "/api/sessions");
    expect(resent?.body).toBe(refused?.body);
    expect(delegationBodies(harness)[0]).toMatchObject({ profile: "reader", harness: "codex" });
    expect(harness.service.hub.allSummaries()).toHaveLength(1);
    expect(harness.service.hub.allSummaries()[0]).toMatchObject({ harness: "codex", access: "read_only" });
  });

  it("is rebuilt for what the older service can store: no session reference is sent, and the receipt says so", async () => {
    const harness = await setup();
    harness.refuseNextDelegation(() => {
      simulateOlderService(harness.service);
    });

    const result = await harness.session.call("delegate", { harness: "pi", task: "Review the parser", cwd: tmpdir(), conversationId: "conv-1" });

    expect(result.isError, result.text).toBe(false);
    const [refused, resent] = delegationBodies(harness);
    // 按新服务写的第一份带着自报的对话标识；按老服务重新写的第二份没有它（老服务会拒绝整条委派），来源 key 仍在。
    expect(refused?.origin?.sessionRef).toEqual({ id: "conv-1", kind: "conversation", source: "declared" });
    expect(resent?.origin).not.toHaveProperty("sessionRef");
    expect(resent?.origin?.key).toBe(refused?.origin?.key);
    // 回执说的与实际发出的是同一回事。
    expect(result.text).toContain("cannot store `conversationId` as a session reference");
    const [stored] = harness.service.hub.allSummaries();
    expect(stored?.origin.sessionRef).toBeUndefined();
    expect(stored?.origin.key).toBe(refused?.origin?.key);
  });
});
