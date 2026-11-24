import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV, LIMITS, SERVICE_FEATURES, type ServiceFeature } from "@shared/constants";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import type { ContextItem, Origin, SessionMeta, SessionSummary } from "@shared/types";
import { ServiceError } from "./client";
import { markFollowsFailure, prepareDelegateRequest, type DelegateArgs, type DelegateEnvironment, type PreparedDelegation } from "./delegate-request";
import type { HostRecord } from "./host-title";
import { BridgeInputError } from "./tool-call";

/**
 * 委派请求的构造（prepareDelegateRequest）：什么时候拒绝、请求体里写了什么、回执要说的事实是什么。
 * 环境全是假的：不碰服务、不读宿主的文件；“老服务”就是一项功能也没声明。
 * 回执的文字见 delegate-output.test.ts；真实服务与 MCP 往返的端到端行为见 bridge.*.test.ts。
 */

const ROOT = join(tmpdir(), "ensemble-delegate-request");
const PROJECT = join(ROOT, "project");
const HOME = join(ROOT, "home");
const ROOTS = join(ROOT, "roots");
const RECORDED = join(ROOT, "recorded");
const ARGUMENT = join(ROOT, "argument");

interface Setup {
  features?: readonly ServiceFeature[];
  sessions?: SessionSummary[];
  roots?: string;
  record?: HostRecord;
  env?: NodeJS.ProcessEnv;
  bridgeDirectory?: string;
}

/** `calls` 按先后记下每一次向外界的询问（取会话、读 roots、读宿主记录、问服务有没有某项功能）。 */
function fake(setup: Setup = {}): { environment: DelegateEnvironment; calls: string[] } {
  const calls: string[] = [];
  const features = new Set<ServiceFeature>(setup.features ?? SERVICE_FEATURES);
  const environment: DelegateEnvironment = {
    env: setup.env ?? {},
    bridgeDirectory: setup.bridgeDirectory ?? PROJECT,
    homeDirectory: HOME,
    sessions: async () => {
      calls.push("sessions");
      return setup.sessions ?? [];
    },
    supports: (feature) => {
      calls.push(`supports:${feature}`);
      return features.has(feature);
    },
    hostRoots: async () => {
      calls.push("roots");
      return setup.roots ? { path: setup.roots } : undefined;
    },
    readHostRecord: async (_origin, workspace) => {
      calls.push(`record:${workspace ?? "-"}`);
      return setup.record ?? {};
    },
  };
  return { environment, calls };
}

const task = (extra: Partial<DelegateArgs> = {}): DelegateArgs => ({ harness: "pi", task: "Do the thing", ...extra });

function prepare(args: DelegateArgs, setup: Setup = {}, origin: Origin = testOrigin()): Promise<PreparedDelegation> {
  return prepareDelegateRequest(args, origin, fake(setup).environment);
}

/** 期望被桥拒绝（BridgeInputError，消息直接写给主模型看），返回消息。 */
async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BridgeInputError);
  return (error as BridgeInputError).message;
}

function summaryOf(id: string, meta: Partial<SessionMeta> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created(meta);
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return toSummary(state);
}

const A = summaryOf("ses_a");
const B = summaryOf("ses_b");
const withoutFeature = (feature: ServiceFeature): ServiceFeature[] => SERVICE_FEATURES.filter((candidate) => candidate !== feature);

describe("prepareDelegateRequest：请求之前的拒绝，以及它们的先后", () => {
  it("没有 harness 也没有 profile：连服务都不碰就拒绝", async () => {
    const { environment, calls } = fake();

    const message = await refusal(prepareDelegateRequest(task({ harness: undefined }), testOrigin(), environment));

    expect(message).toContain("Give `harness`, or `profile`");
    expect(calls).toEqual([]);
  });

  it("老服务不认识 profile：先取会话（桥在这一步连上服务），再问功能、拒绝；还没读 roots 与宿主记录", async () => {
    const { environment, calls } = fake({ features: [] });

    const message = await refusal(prepareDelegateRequest(task({ harness: undefined, profile: "verify" }), testOrigin(), environment));

    expect(message).toContain("does not know roles");
    expect(calls).toEqual(["sessions", "supports:delegation-profiles"]);
  });

  it("同时给了 harness 也一样：老服务会丢掉 profile，等于悄悄忽略了角色", async () => {
    const message = await refusal(prepare(task({ profile: "verify" }), { features: [] }));

    expect(message).toContain("does not know roles");
  });

  it("老服务不认识 session 上下文引用：在请求之前拒绝；其余种类的上下文照常通过", async () => {
    const { environment, calls } = fake({ features: [] });
    const withSession: ContextItem[] = [{ kind: "text", text: "a" }, { kind: "session", sessionId: "ses_a" }];

    const message = await refusal(prepareDelegateRequest(task({ context: withSession }), testOrigin(), environment));

    expect(message).toContain("does not know `session` references in `context`");
    expect(calls).toEqual(["sessions", "supports:context-session-ref"]);

    const plain: ContextItem[] = [{ kind: "text", text: "a" }, { kind: "file", path: join(ROOT, "x.txt") }];
    const prepared = await prepare(task({ context: plain }), { features: [] });
    expect(prepared.body.context).toEqual(plain);
  });

  it("没有 cwd、宿主也没报 roots，桥又是从主目录起的：读过 roots 之后拒绝，不碰宿主记录", async () => {
    const atHome = fake({ bridgeDirectory: HOME });

    const message = await refusal(prepareDelegateRequest(task(), testOrigin(), atHome.environment));

    expect(message).toContain("started from the user's home directory");
    expect(atHome.calls).toEqual(["sessions", "roots"]);
  });

  it("传了 cwd，或宿主报了 roots，同样的桥目录就不拒绝", async () => {
    const withCwd = await prepare(task({ cwd: ARGUMENT }), { bridgeDirectory: HOME });
    expect(withCwd.body.cwd).toBe(ARGUMENT);

    const withRoots = await prepare(task(), { bridgeDirectory: HOME, roots: ROOTS });
    expect(withRoots.body.cwd).toBe(ROOTS);
  });

  it("follows 超过个数上限：说明上限就拒绝，不读宿主记录", async () => {
    const ids = Array.from({ length: LIMITS.maxParents + 1 }, (_, index) => `ses_${index}`);
    const { environment, calls } = fake();

    const message = await refusal(prepareDelegateRequest(task({ follows: ids }), testOrigin(), environment));

    expect(message).toContain(`\`follows\` names ${ids.length} sessions, but one session can follow at most ${LIMITS.maxParents}.`);
    expect(calls).toEqual(["sessions", "roots"]);
  });

  it("follows 点名的会话不存在：一次全部说出来，不读宿主记录", async () => {
    const many = fake({ sessions: [A] });
    const message = await refusal(prepareDelegateRequest(task({ follows: ["ses_a", "ses_x", "ses_y"] }), testOrigin(), many.environment));
    expect(message).toContain("Sessions ses_x, ses_y (passed as `follows`) do not exist.");
    expect(many.calls).toEqual(["sessions", "roots"]);

    const single = await refusal(prepare(task({ follows: "ses_x" }), { sessions: [A] }));
    expect(single).toContain("Session ses_x (passed as `follows`) does not exist.");
  });

  it("没有被拒绝时的次序：先取会话，再读 roots，最后读宿主记录；找宿主记录用的目录取 roots、其次桥的目录，不取这次的 cwd", async () => {
    const withoutRoots = fake();
    await prepareDelegateRequest(task({ cwd: ARGUMENT }), testOrigin(), withoutRoots.environment);
    expect(withoutRoots.calls).toEqual(["sessions", "roots", `record:${PROJECT}`]);

    const withRoots = fake({ roots: ROOTS });
    await prepareDelegateRequest(task({ cwd: ARGUMENT }), testOrigin(), withRoots.environment);
    expect(withRoots.calls).toEqual(["sessions", "roots", `record:${ROOTS}`]);
  });
});

describe("prepareDelegateRequest：会话的工作目录与来源的工作目录是两回事", () => {
  it("会话去哪干活：显式 cwd，其次宿主的 roots，最后才是桥的目录；回执据此写出处", async () => {
    const explicit = await prepare(task({ cwd: ARGUMENT }), { roots: ROOTS });
    expect(explicit.body.cwd).toBe(ARGUMENT);
    expect(explicit.cwdSource).toBe("argument");

    const reported = await prepare(task(), { roots: ROOTS });
    expect(reported.body.cwd).toBe(ROOTS);
    expect(reported.cwdSource).toBe("host-roots");

    const fallback = await prepare(task());
    expect(fallback.body.cwd).toBe(PROJECT);
    expect(fallback.cwdSource).toBe("bridge-directory");
  });

  it("来源的工作目录按可信度取：宿主记录 > 宿主 roots > 显式 cwd；都没有就不写，不拿桥的目录凑数", async () => {
    const recorded = await prepare(task({ cwd: ARGUMENT }), { roots: ROOTS, record: { workspace: RECORDED } });
    expect(recorded.body.origin).toMatchObject({ workspace: RECORDED, workspaceSource: "host-record" });
    // 来源在哪个项目与会话去哪干活可以不同：委派目录不会被写成来源目录。
    expect(recorded.body.cwd).toBe(ARGUMENT);

    const reported = await prepare(task({ cwd: ARGUMENT }), { roots: ROOTS });
    expect(reported.body.origin).toMatchObject({ workspace: ROOTS, workspaceSource: "mcp-roots" });

    const explicit = await prepare(task({ cwd: ARGUMENT }));
    expect(explicit.body.origin).toMatchObject({ workspace: ARGUMENT, workspaceSource: "delegate-cwd" });

    const none = await prepare(task());
    expect(none.body.origin?.workspace).toBeUndefined();
    expect(none.body.origin?.workspaceSource).toBeUndefined();
    expect(none.body.cwd).toBe(PROJECT);
  });

  it("老服务不认识 host-record：目录照发，只是不带来历；另外两种出处老服务本来就认", async () => {
    const recorded = await prepare(task({ cwd: ARGUMENT }), { features: withoutFeature("host-record-workspace"), record: { workspace: RECORDED } });
    expect(recorded.body.origin?.workspace).toBe(RECORDED);
    expect(recorded.body.origin).not.toHaveProperty("workspaceSource");

    const reported = await prepare(task(), { features: [], roots: ROOTS });
    expect(reported.body.origin).toMatchObject({ workspace: ROOTS, workspaceSource: "mcp-roots" });
  });

  it("宿主记录里的标题原样带上，没有就不写", async () => {
    const titled = await prepare(task(), { record: { title: "Fix the parser" } });
    expect(titled.body.origin?.hostTitle).toBe("Fix the parser");

    const untitled = await prepare(task());
    expect(untitled.body.origin).not.toHaveProperty("hostTitle");
  });
});

describe("prepareDelegateRequest：自报的对话标识", () => {
  const declared = (): Origin =>
    testOrigin({ key: "cursor:conv-1", host: "cursor", hostLabel: "Cursor", sessionRef: { id: "conv-1", kind: "conversation", source: "declared" } });

  it("老服务存不了 declared：不发 sessionRef，来源 key 仍在，回执要说明；传进来的来源对象不被改动", async () => {
    const origin = declared();

    const prepared = await prepare(task(), { features: withoutFeature("declared-session-ref") }, origin);

    expect(prepared.body.origin).not.toHaveProperty("sessionRef");
    expect(prepared.body.origin?.key).toBe("cursor:conv-1");
    expect(prepared.declaredNotRecorded).toBe(true);
    expect(origin.sessionRef?.id).toBe("conv-1");
  });

  it("服务声明了 declared-session-ref：原样发出，没有要说明的", async () => {
    const prepared = await prepare(task(), {}, declared());

    expect(prepared.body.origin?.sessionRef).toEqual({ id: "conv-1", kind: "conversation", source: "declared" });
    expect(prepared.declaredNotRecorded).toBe(false);
  });

  it("宿主给的标识（不是自报的）老服务本来就认：照发，没有要说明的", async () => {
    const origin = testOrigin();

    const prepared = await prepare(task(), { features: [] }, origin);

    expect(prepared.body.origin?.sessionRef).toEqual(origin.sessionRef);
    expect(prepared.declaredNotRecorded).toBe(false);
  });
});

describe("prepareDelegateRequest：上级", () => {
  it("点名一个上级：请求只带 parentSessionId；回执事实里点名的、想挂的、记录的都是它", async () => {
    const prepared = await prepare(task({ follows: "ses_a" }), { sessions: [A, B] });

    expect(prepared.body.parentSessionId).toBe("ses_a");
    expect(prepared.body).not.toHaveProperty("parentSessionIds");
    expect(prepared.parents.followed.map((session) => session.id)).toEqual(["ses_a"]);
    expect(prepared.parents.wanted).toEqual(["ses_a"]);
    expect(prepared.parents.recorded).toEqual(["ses_a"]);
  });

  it("点名几个、服务懂得汇聚：请求带完整的集合，第一个是主上级", async () => {
    const prepared = await prepare(task({ follows: ["ses_a", "ses_b"] }), { sessions: [A, B] });

    expect(prepared.body.parentSessionId).toBe("ses_a");
    expect(prepared.body.parentSessionIds).toEqual(["ses_a", "ses_b"]);
    expect(prepared.parents.wanted).toEqual(["ses_a", "ses_b"]);
    expect(prepared.parents.recorded).toEqual(["ses_a", "ses_b"]);
  });

  it("点名几个、老服务不认识 parentSessionIds：只发第一个；想挂的仍是全部，记录的只有第一个，回执据此说明", async () => {
    const prepared = await prepare(task({ follows: ["ses_a", "ses_b"] }), { sessions: [A, B], features: withoutFeature("multi-parent") });

    expect(prepared.body.parentSessionId).toBe("ses_a");
    expect(prepared.body).not.toHaveProperty("parentSessionIds");
    expect(prepared.parents.wanted).toEqual(["ses_a", "ses_b"]);
    expect(prepared.parents.recorded).toEqual(["ses_a"]);
  });

  it("去掉空白与重复，保留写的先后", async () => {
    const prepared = await prepare(task({ follows: [" ses_b ", "ses_a", "ses_b", "  "] }), { sessions: [A, B] });

    expect(prepared.parents.followed.map((session) => session.id)).toEqual(["ses_b", "ses_a"]);
    expect(prepared.parents.wanted).toEqual(["ses_b", "ses_a"]);
    expect(prepared.body.parentSessionId).toBe("ses_b");
  });

  it("没点名时，环境变量指向已知会话就接在它后面；点名了就以点名的为准，推断只留在事实里", async () => {
    const env = { [ENV.parentSession]: "ses_a" };

    const inferred = await prepare(task(), { sessions: [A, B], env });
    expect(inferred.parents.followed).toEqual([]);
    expect(inferred.parents.inferred).toBe("ses_a");
    expect(inferred.parents.wanted).toEqual(["ses_a"]);
    expect(inferred.body.parentSessionId).toBe("ses_a");

    const explicit = await prepare(task({ follows: "ses_b" }), { sessions: [A, B], env });
    expect(explicit.parents.inferred).toBe("ses_a");
    expect(explicit.parents.wanted).toEqual(["ses_b"]);
    expect(explicit.body.parentSessionId).toBe("ses_b");

    const stale = await prepare(task(), { sessions: [B], env });
    expect(stale.parents.inferred).toBeUndefined();
    expect(stale.body).not.toHaveProperty("parentSessionId");
  });

  it("宿主会话标识对得上某个会话的原生标识就接在它后面；自报的标识没法核对，不用来推断", async () => {
    const native = summaryOf("ses_native", { nativeRef: { kind: "codex-thread", id: "thr_test" } });

    const hostGiven = await prepare(task(), { sessions: [native] }, testOrigin());
    expect(hostGiven.parents.inferred).toBe("ses_native");
    expect(hostGiven.body.parentSessionId).toBe("ses_native");

    const selfReported = testOrigin({ sessionRef: { id: "thr_test", kind: "thread", source: "declared" } });
    const declared = await prepare(task(), { sessions: [native] }, selfReported);
    expect(declared.parents.inferred).toBeUndefined();
    expect(declared.body).not.toHaveProperty("parentSessionId");
  });
});

describe("prepareDelegateRequest：请求体", () => {
  it("只带真正传了的字段（空字符串、false 不带）", async () => {
    const minimal = await prepare(task({ title: "", model: undefined, allowDuplicate: false }));
    expect(Object.keys(minimal.body).sort()).toEqual(["cwd", "harness", "origin", "task"]);

    const full = await prepare(
      task({
        profile: "verify",
        title: "T",
        model: "m",
        effort: "high",
        access: "read_only",
        context: [{ kind: "text", text: "x" }],
        allowDuplicate: true,
      }),
    );
    expect(Object.keys(full.body).sort()).toEqual(["access", "allowDuplicate", "context", "cwd", "effort", "harness", "model", "origin", "profile", "task", "title"]);
  });
});

describe("markFollowsFailure：层数超限由 follows 引起时换一套建议", () => {
  const depth = (): ServiceError => new ServiceError("depth_exceeded", "too deep", 409, { deepestParentId: "ses_a" });
  const parents = (followed: SessionSummary[]): PreparedDelegation["parents"] => ({ followed, inferred: undefined, wanted: followed.map((session) => session.id), recorded: [] });

  it("点名了上级：在服务回的错误上标明 via: follows，其余字段原样", () => {
    const original = depth();

    const marked = markFollowsFailure(parents([A]), original);

    expect(marked).toBeInstanceOf(ServiceError);
    expect(marked).not.toBe(original);
    const error = marked as ServiceError;
    expect(error.code).toBe("depth_exceeded");
    expect(error.message).toBe("too deep");
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ deepestParentId: "ses_a", via: "follows" });
  });

  it("没点名上级、别的错误码、不是服务错误：原样交回", () => {
    const original = depth();
    expect(markFollowsFailure(parents([]), original)).toBe(original);

    const other = new ServiceError("not_found", "nope", 404);
    expect(markFollowsFailure(parents([A]), other)).toBe(other);

    const plain = new Error("boom");
    expect(markFollowsFailure(parents([A]), plain)).toBe(plain);
  });
});
