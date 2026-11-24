import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import { api, token } from "./api";

/**
 * 网页发出的每个请求的方法、地址与请求体，以及它们落在“更早的服务”（还没有归档 / 角色 / 并发设置 / 提问的那一版）上会怎样。
 * 服务端用 zod 校验请求体：不认识的字段被静默丢掉而不是报错，所以那一版已有的端点，网页只能发它认得的字段；
 * 新增的端点在那一版上是显式的 404。说明见 api.ts 里 api 对象上方的注释；每个请求都要在下面三张表里选一边，新增的请求不登记就会红。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 路由与请求体里的每个字段，更早的服务都认得。 */
const UNCHANGED = ["state", "harnesses", "setAllowedModels", "session", "git", "events", "send", "cancel", "stop", "remove"];

/**
 * 更早的服务没有这条路由：显式的 404。界面靠快照里缺少对应字段（concurrency / profiles / archivedCount）不给入口，
 * 提问则是那一版根本不会产生（回答与放弃的地址与请求体由 api.questions.test.ts 钉住）。
 */
const NEW_ROUTE = [
  "setConcurrency",
  "putProfile",
  "removeProfile",
  "renameProfile",
  "answerQuestion",
  "declineQuestion",
  "archive",
  "unarchive",
  "retention",
  "setRetention",
  "report",
];

/** 路由是旧的，但多了一个旧服务会悄悄忽略的参数。 */
const NEW_PARAM = ["sessions"];

/** 更早的服务对这两个已有端点的请求体认得的字段（当时 schemas.ts 里的 setModelsBody 与 sendBody）。 */
const LEGACY_FIELDS = {
  models: ["allowed", "efforts", "userDefaultModel"],
  messages: ["text", "mode", "originKey"],
};

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  /** 请求体解析成的对象；没有请求体就是 undefined。 */
  body: unknown;
}

/** 假的服务：什么请求都回 200 与一个空对象，记下收到的请求。 */
function serve(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const raw = init?.body;
      sent.push({
        url,
        method: init?.method,
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: typeof raw === "string" ? JSON.parse(raw) : undefined,
      });
      return new Response("{}", { status: 200 });
    }),
  );
  return sent;
}

/** 只留方法、地址与请求体：断言时不被令牌等头部干扰。 */
function shape(sent: Sent[]): unknown[][] {
  return sent.map(({ method, url, body }) => [method, url, body]);
}

describe("每个请求都归了类", () => {
  it("api 上的每个请求都在三张表里恰好登记一次：新增一个请求，先想清楚旧服务会怎样再登记", () => {
    const registered = [...UNCHANGED, ...NEW_ROUTE, ...NEW_PARAM];
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual(Object.keys(api).sort());
  });
});

describe("与更早的服务一致的请求", () => {
  it("设置允许的模型：请求体只有 allowed / efforts / userDefaultModel，没给的不写进去（null 是有意义的值，照写）", async () => {
    const sent = serve();
    await api.setAllowedModels("codex", ["m-a"], { "m-a": ["low"] }, "m-a");
    await api.setAllowedModels("codex", null);
    await api.setAllowedModels("codex", ["m-a"], undefined, null);

    expect(shape(sent)).toEqual([
      ["PUT", "/api/harnesses/codex/models", { allowed: ["m-a"], efforts: { "m-a": ["low"] }, userDefaultModel: "m-a" }],
      ["PUT", "/api/harnesses/codex/models", { allowed: null }],
      ["PUT", "/api/harnesses/codex/models", { allowed: ["m-a"], userDefaultModel: null }],
    ]);
    for (const { body } of sent) {
      for (const key of Object.keys(body as object)) expect(LEGACY_FIELDS.models).toContain(key);
    }
  });

  it("补充消息：请求体是 text 与 mode，原样交出，不夹带别的字段", async () => {
    const sent = serve();
    await api.send("ses_a", { text: "改用 B 方案", mode: "steer" });
    await api.send("ses_a", { text: "再看一眼" });

    expect(shape(sent)).toEqual([
      ["POST", "/api/sessions/ses_a/messages", { text: "改用 B 方案", mode: "steer" }],
      ["POST", "/api/sessions/ses_a/messages", { text: "再看一眼" }],
    ]);
    for (const { body } of sent) {
      for (const key of Object.keys(body as object)) expect(LEGACY_FIELDS.messages).toContain(key);
    }
  });

  it("取消、停止、删除与读取：方法与地址照旧；取消与停止带空对象，删除与读取没有请求体；标识做百分号编码", async () => {
    const sent = serve();
    await api.cancel("ses_a");
    await api.stop("ses_a");
    await api.remove("ses_a");
    await api.state();
    await api.harnesses();
    await api.harnesses(true);
    await api.session("ses_a");
    await api.events("ses_a", 7);
    await api.git("C:\\work dir");
    await api.cancel("ses/../x");

    expect(shape(sent)).toEqual([
      ["POST", "/api/sessions/ses_a/cancel", {}],
      ["POST", "/api/sessions/ses_a/stop", {}],
      ["DELETE", "/api/sessions/ses_a", undefined],
      ["GET", "/api/state", undefined],
      ["GET", "/api/harnesses", undefined],
      ["GET", "/api/harnesses?refresh=1", undefined],
      ["GET", "/api/sessions/ses_a", undefined],
      ["GET", "/api/sessions/ses_a/events?after=7", undefined],
      ["GET", "/api/git?path=C%3A%5Cwork%20dir", undefined],
      ["POST", "/api/sessions/ses%2F..%2Fx/cancel", {}],
    ]);
  });
});

describe("新路由：更早的服务回 404，这里留一份地址与请求体", () => {
  it("并发上限：max 这个键必须出现，清掉指定写成 null（省略不等于清掉）", async () => {
    const sent = serve();
    await api.setConcurrency(5);
    await api.setConcurrency("unlimited");
    await api.setConcurrency(null);

    expect(shape(sent)).toEqual([
      ["PUT", "/api/settings/concurrency", { max: 5 }],
      ["PUT", "/api/settings/concurrency", { max: "unlimited" }],
      ["PUT", "/api/settings/concurrency", { max: null }],
    ]);
  });

  it("角色：名字做百分号编码放进地址；新增带 create，改名只带 to", async () => {
    const sent = serve();
    await api.putProfile("verify", { harness: "codex", model: "m-a", effort: "low", access: "read_only", create: true });
    await api.putProfile("a b/c", { harness: "pi" });
    await api.removeProfile("verify");
    await api.renameProfile("a b", "c");

    expect(shape(sent)).toEqual([
      ["PUT", "/api/profiles/verify", { harness: "codex", model: "m-a", effort: "low", access: "read_only", create: true }],
      ["PUT", "/api/profiles/a%20b%2Fc", { harness: "pi" }],
      ["DELETE", "/api/profiles/verify", undefined],
      ["POST", "/api/profiles/a%20b/rename", { to: "c" }],
    ]);
  });

  it("归档与取消归档：请求体是 ids；exact 只有为真才写进去，直接取消归档的请求体只有 ids", async () => {
    const sent = serve();
    await api.archive(["a", "b"]);
    await api.unarchive(["a"]);
    await api.unarchive(["a"], {});
    await api.unarchive(["a"], { exact: false });
    await api.unarchive(["a", "b"], { exact: true });

    expect(shape(sent)).toEqual([
      ["POST", "/api/sessions/archive", { ids: ["a", "b"] }],
      ["POST", "/api/sessions/unarchive", { ids: ["a"] }],
      ["POST", "/api/sessions/unarchive", { ids: ["a"] }],
      ["POST", "/api/sessions/unarchive", { ids: ["a"] }],
      ["POST", "/api/sessions/unarchive", { ids: ["a", "b"], exact: true }],
    ]);
  });

  it("留存策略与导出报告：读留存策略、整份替换，导出带范围 / 详略 / 语言三个查询参数", async () => {
    const sent = serve();
    await api.retention();
    await api.setRetention({ keepDays: 30, keepCount: null });
    await api.report("ses_a", { scope: "tree", detail: "full", lang: "zh" });

    expect(shape(sent)).toEqual([
      ["GET", "/api/retention", undefined],
      ["PUT", "/api/retention", { keepDays: 30, keepCount: null }],
      ["GET", "/api/sessions/ses_a/report?scope=tree&detail=full&lang=zh", undefined],
    ]);
  });
});

describe("已有路由上的新参数", () => {
  it("会话列表：不传 archived 就是原来的地址，传了才带查询参数（旧服务会忽略它，所以归档界面只在服务认得归档时才去读）", async () => {
    const sent = serve();
    await api.sessions();
    await api.sessions({ archived: "only" });
    await api.sessions({ archived: "include" });

    expect(sent.map((request) => request.url)).toEqual(["/api/sessions", "/api/sessions?archived=only", "/api/sessions?archived=include"]);
  });
});

describe("令牌", () => {
  it("每个请求都带着访问令牌，放在请求头里、不进地址", async () => {
    const sent = serve();
    await api.state();
    await api.setConcurrency(1);
    await api.removeProfile("verify");
    await api.archive(["a"]);
    await api.report("ses_a", { scope: "session", detail: "brief", lang: "en" });

    expect(sent).toHaveLength(5);
    for (const request of sent) {
      expect(Object.keys(request.headers)).toContain(TOKEN_HEADER);
      expect(request.headers[TOKEN_HEADER]).toBe(token);
      expect(request.url).not.toContain("token=");
    }
  });
});
