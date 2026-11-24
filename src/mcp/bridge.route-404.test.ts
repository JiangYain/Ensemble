import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import type { ErrorBody } from "@shared/protocol";
import { EnsembleBridge, explainError } from "./bridge";
import { closeTestBridges, connectBridge, simulateOlderService, startTestService } from "./bridge.fixtures";
import { ServiceClient, ServiceError } from "./client";

/**
 * 服务对没有这条路由的请求回 404：`not_found`，消息 `No route for <METHOD> <path>.`（http/server.ts 路由表末尾的兜底）。
 * 它和“会话不存在”同样是 not_found，出路却相反：不是编号写错，而是服务比插件旧、没有这个端点——explainError 要把两种分开说，
 * 否则主 Agent 会被指去 `status` 里核对一个本来没错的会话编号。
 * 桥发请求之前按 service.json 的 features 查过功能；发送时连接被拒绝、重新发现落到了更老的服务，请求就会撞上这个 404
 * （`read` 的 report 视角是只读请求，没有 `rebuildBody`，重新发现之后原样重发）。
 * 这里：直接看 explainError 对几种 not_found 的措辞；用真服务钉住“它回的那句话确实以桥认的前缀开头”；再经 MCP 的 `read`（report 视角）端到端走一遍上面那条路。
 * 真服务（临时状态目录）加进程内的 MCP 客户端：“桥 ↔ 服务”仍是真实的本地 HTTP，只有 report 路由的 404 是造出来的（造的是真服务会回的那份 JSON 错误体）。
 */

afterEach(closeTestBridges);

const MISSING_ROUTE = "No route for GET /api/sessions/ses_x/report.";
/** 主 Agent 读到的、接在服务原话后面的那几句：措辞要改，改这里与 explain-error.ts 的 explainError 两处。 */
const OLDER_SERVICE_ADVICE =
  "The running Ensemble service is probably older than this plugin and has no such endpoint. Tell the user; retrying will not help until it has been restarted onto the current version.";

describe("explainError: a request for a route the service does not have", () => {
  it("says the service is probably older than the plugin and what to tell the user, instead of sending the model to check a session id", () => {
    const text = explainError(new ServiceError("not_found", MISSING_ROUTE, 404));

    expect(text).toBe(`${MISSING_ROUTE} ${OLDER_SERVICE_ADVICE}`);
    expect(text).toContain("older than this plugin");
    expect(text).not.toContain("list valid session ids");
  });

  it("recognises it whatever the method and the path are", () => {
    for (const message of [
      "No route for POST /api/sessions/ses_x/questions/qst_y/answer.",
      "No route for PUT /api/settings/concurrency.",
      "No route for GET /api/sessions/ses_x/report.",
    ]) {
      expect(explainError(new ServiceError("not_found", message, 404)), message).toBe(`${message} ${OLDER_SERVICE_ADVICE}`);
    }
  });

  it("leaves a not_found that says a session is missing exactly as it was", () => {
    expect(explainError(new ServiceError("not_found", "Session ses_x does not exist.", 404))).toBe("Session ses_x does not exist. Call `status` to list valid session ids.");
    // `context` 里引用的会话不存在：出路是改正或去掉那一项（服务端在 details.via 里标明）。
    const viaContext = new ServiceError("not_found", "Session ses_x referenced in context does not exist.", 404, { via: "context", sessionIds: ["ses_x"] });
    expect(explainError(viaContext)).toBe(
      'Session ses_x referenced in context does not exist. Call `status` with scope "all" to list valid session ids, then correct that `context` item or remove it.',
    );
  });

  it("goes by how the message starts: a session id that happens to read like those words is still a session that does not exist", () => {
    // 服务的“不存在”消息会把模型传来的编号原样写进去；那句话里有这几个词，却不是以它们开头。
    const text = explainError(new ServiceError("not_found", "Session No route for this does not exist.", 404));

    expect(text).toBe("Session No route for this does not exist. Call `status` to list valid session ids.");
  });
});

describe("the sentence the bridge recognises is the one the service writes", () => {
  it("gives the advice for what a real service answers to a route it does not have", async () => {
    const service = await startTestService({ homePrefix: "ensemble-mcp-route404-", env: {} });

    const response = await fetch(`${service.url}/api/sessions/ses_x/no-such-route`, { headers: { [TOKEN_HEADER]: service.token } });
    const { error } = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("No route for GET /api/sessions/ses_x/no-such-route.");
    expect(explainError(new ServiceError(error.code, error.message, response.status, error.details))).toBe(`${error.message} ${OLDER_SERVICE_ADVICE}`);
  });
});

/** 与连接被拒绝时 fetch 抛出的错误同一个形状：TypeError，原因里带 ECONNREFUSED。 */
function connectionRefused(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
}

/** 报告导出的路由：`/api/sessions/<id>/report`。 */
const REPORT_ROUTE = /^\/api\/sessions\/[^/]+\/report$/;

/**
 * 一个真服务，加一个经内存传输连着它的桥与 MCP 客户端。桥的服务客户端记下发给 report 路由的每个请求，并能让下一次这样的请求发不出去（连接被拒绝）；
 * 发出去了的 report 请求一律得到 404 “No route for …”——就像它到了一个没有这条路由的老服务；其余请求照常交给真服务。
 */
async function setup() {
  const service = await startTestService({ homePrefix: "ensemble-mcp-route404-", env: {} });
  const reportRequests: string[] = [];
  let refuseNext: (() => void) | undefined;
  const client = new ServiceClient({
    paths: service.paths,
    ensure: async () => {
      throw new Error("the service should already be running");
    },
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (!REPORT_ROUTE.test(url.pathname)) return fetch(input, init);
      reportRequests.push(`${method} ${url.pathname}`);
      if (refuseNext) {
        const beforeRefusing = refuseNext;
        refuseNext = undefined;
        beforeRefusing();
        throw connectionRefused();
      }
      const body: ErrorBody = { error: { code: "not_found", message: `No route for ${method} ${url.pathname}.` } };
      return new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/json" } });
    }) satisfies typeof fetch,
  });
  const bridge = new EnsembleBridge({ paths: service.paths, version: "test", env: {}, cwd: tmpdir(), client, openExternal: () => {} });
  const session = await connectBridge(bridge);
  return {
    service,
    session,
    reportRequests,
    /** 下一次发给 report 路由的请求发不出去（连接被拒绝）；发之前先做 `beforeRefusing`（例如把服务换成老版本）。只作用一次。 */
    refuseNextReport(beforeRefusing: () => void): void {
      refuseNext = beforeRefusing;
    },
  };
}

describe("read · view=report when the service that ends up answering has no report route", () => {
  it("says the service is probably older, not that the session id should be checked", async () => {
    const rig = await setup();
    let advertised: readonly string[] | undefined;
    // 请求发出去时连接被拒绝；桥重新发现，看到的是不认识报告导出的老服务（只是改 service.json），请求原样重发，撞上它的 404。
    rig.refuseNextReport(() => {
      advertised = simulateOlderService(rig.service);
    });

    const result = await rig.session.call("read", { sessionId: "ses_any", view: "report" });

    expect(advertised, "the new service advertises report export, so the switch really took it away").toContain("session-report");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No route for GET /api/sessions/ses_any/report.");
    expect(result.text).toContain("probably older than this plugin");
    expect(result.text).toContain("Tell the user; retrying will not help");
    // 编号没有错，是服务没有这个端点：不能再说“去 status 里找有效的会话编号”。
    expect(result.text).not.toContain("list valid session ids");
    // 被拒绝的那一次，加重新发现之后重发的那一次；404 是业务回答，不会再有第三次。
    expect(rig.reportRequests).toEqual(["GET /api/sessions/ses_any/report", "GET /api/sessions/ses_any/report"]);
  });

  it("still sends the model to the session list for a session that does not exist, through the same bridge", async () => {
    const rig = await setup();

    const result = await rig.session.call("read", { sessionId: "ses_missing" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Session ses_missing does not exist.");
    expect(result.text).toContain("Call `status` to list valid session ids.");
    expect(result.text).not.toContain("older than this plugin");
    expect(rig.reportRequests).toEqual([]);
  });
});
