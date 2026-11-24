import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ACCEPTS_HEADER, INVALID_TOKEN, PROTOCOL_VERSION, SERVICE_FEATURES, TOKEN_HEADER, type ServiceFeature } from "@shared/constants";
import { isoNow } from "@shared/format";
import { defaultModelFault } from "@shared/models";
import { reportProfiles } from "@shared/profiles";
import type {
  ArchiveResponse,
  CancelResponse,
  CollectNoticesResponse,
  DelegateResponse,
  ErrorBody,
  EventsResponse,
  GitResponse,
  HarnessesResponse,
  HealthBody,
  ProfilesResponse,
  QuestionResolvedResponse,
  RelinkResponse,
  RetentionResponse,
  SendResponse,
  SessionDetail,
  SetAllowedModelsResponse,
  SetConcurrencyResponse,
  StateSnapshot,
} from "@shared/protocol";
import type { Actor, HarnessId, Origin, SessionSummary } from "@shared/types";
import { archiveSessions, unarchiveSessions } from "../archive";
import type { ConcurrencyControl } from "../concurrency";
import { EnsembleError } from "../errors";
import type { ExecutorRegistry } from "../executors/registry";
import type { GitInspector } from "../git";
import type { ArchivedFilter, EventHub } from "../hub";
import { reconcileLegacyWorkspace } from "../legacy-origin";
import type { Logger } from "../logger";
import type { SessionManager } from "../manager";
import type { NoticeCenter } from "../notices";
import { normalizeParents } from "../parents";
import { buildSessionReport, reportDisposition, reportFilename } from "../report";
import type { RetentionSweeper } from "../retention";
import { waitForSessions } from "../wait";
import { resolveDelegationFields } from "../profiles";
import { Broadcaster } from "./broadcaster";
import type { SettingsStore } from "../settings";
import { answerQuestionBody, archiveBody, collectBody, declineQuestionBody, delegateBody, formatZodError, putProfileBody, relinkBody, renameProfileBody, reportQuery, retentionBody, sendBody, setConcurrencyBody, setModelsBody, unarchiveBody, waitBody } from "./schemas";

export interface HttpDeps {
  hub: EventHub;
  manager: SessionManager;
  notices: NoticeCenter;
  registry: ExecutorRegistry;
  /** 用户在配置页里做的取舍（持久化）。 */
  settings: SettingsStore;
  /** 全局并发上限这项设置：来源与存值、运行中改写（改写立即作用到 manager），以及变化通知。 */
  concurrency: ConcurrencyControl;
  /** 留存策略的执行者：用户改了策略后立刻清扫一次，并报告最近一次清扫的结果（只归档，不删除）。 */
  retention: RetentionSweeper;
  /** 读取来源工作目录的 Git 状态（画布上来源节点左边的 Git 节点）。 */
  git: GitInspector;
  log: Logger;
  token: string;
  version: string;
  startedAt: string;
  webRoot: string | undefined;
  dev: boolean;
  /** 按操作系统语言得出的界面语言提示，写进页面供前端参考；未知时为空。 */
  lang?: "zh" | "en" | undefined;
  /** 有来自用户或 MCP 桥的实际访问时调用（用于空闲退出判断）。 */
  onActivity: () => void;
  onShutdownRequest: () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const CONSOLE_ORIGIN: Origin = {
  key: "console:ensemble",
  kind: "user",
  host: "console",
  hostLabel: "Ensemble",
  evidence: ["console"],
};

const USER_ACTOR: Actor = { kind: "user", label: "You" };

export function createHttpServer(deps: HttpDeps): { server: Server; broadcaster: Broadcaster } {
  const broadcaster = new Broadcaster(deps.hub, deps.log);
  broadcaster.start();
  // 名额的占用、等待与并发上限的设置：服务端自己的账目与设置，经 SSE 的 capacity 消息推给所有页面（多个标签页、设置窗口里的改动保持一致）。
  broadcaster.watchCapacity(() => ({ capacity: deps.manager.capacity(), concurrency: deps.concurrency.view() }));
  const stopWatchingCapacity = [
    deps.manager.onCapacityChange(() => broadcaster.capacityChanged()),
    deps.concurrency.onChange(() => broadcaster.capacityChanged()),
  ];

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => fail(res, error));
  });
  server.on("close", () => {
    for (const stop of stopWatchingCapacity) stop();
    broadcaster.stop();
  });
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 0;
  server.headersTimeout = 20_000;

  const listeningPort = (): number => (server.address() as AddressInfo | null)?.port ?? 0;

  function snapshot(): StateSnapshot {
    // 不等待探测：首屏要立刻出来，尚未探测完的 Harness 以 "checking" 占位，探测完成后经 SSE 的 harness 消息更新。
    const harnesses = deps.registry.snapshot();
    return {
      rev: broadcaster.currentRev(),
      serverTime: isoNow(),
      version: deps.version,
      protocol: PROTOCOL_VERSION,
      // 快照里的会话不含已归档的（它们按需经 GET /api/sessions?archived=… 取）；archivedCount 让页面知道还有多少。
      sessions: deps.hub.allSummaries("exclude"),
      archivedCount: deps.hub.counts().archived,
      retention: deps.settings.retention(),
      harnesses,
      capacity: deps.manager.capacity(),
      concurrency: deps.concurrency.view(),
      dev: deps.dev || harnesses.some((h) => h.runtime === "fixture"),
      profiles: deps.settings.profilesView(),
    };
  }

  function summaryOf(sessionId: string): SessionSummary {
    const summary = deps.hub.summary(sessionId);
    if (!summary) throw new EnsembleError("not_found", `Session ${sessionId} does not exist.`);
    return summary;
  }

  function retentionResponse(): RetentionResponse {
    const lastSweep = deps.retention.lastSweep();
    return { retention: deps.settings.retention(), ...(lastSweep ? { lastSweep } : {}) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = listeningPort();
    checkHost(req, port);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const method = req.method ?? "GET";

    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");

    if (!url.pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw new EnsembleError("invalid_request", "Method not allowed.");
      await serveStatic(url.pathname, res, deps, method === "HEAD");
      return;
    }

    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const route = `${method} /${parts.join("/")}`;

    if (route === "GET /health") {
      const counts = deps.hub.counts();
      const body: HealthBody = {
        ok: true,
        service: "ensemble",
        version: deps.version,
        protocol: PROTOCOL_VERSION,
        pid: process.pid,
        startedAt: deps.startedAt,
        capacity: deps.manager.capacity(),
        // sessions 是所有已知的会话（含冷的与已归档的）；热的、已归档的另报，一眼看出懒加载有没有在起作用。
        sessions: counts.total,
        sessionsHot: counts.hot,
        sessionsArchived: counts.archived,
        features: [...SERVICE_FEATURES],
      };
      sendJson(res, 200, body);
      return;
    }

    authorize(req, url, deps.token);
    if (method !== "GET") checkOrigin(req, port, deps.dev);
    deps.onActivity();
    // 老桥读不懂“提问”这种值得留意的事项（见 ACCEPTS_HEADER）：发给它的响应里把它去掉，也不为它唤醒它的 wait。
    const legacyBridge = isLegacyBridge(req);
    if (legacyBridge) legacyResponses.add(res);

    const sessionId = parts[0] === "sessions" ? parts[1] : undefined;

    if (route === "GET /state") return sendJson(res, 200, snapshot());

    if (route === "GET /stream") {
      const lastHeader = req.headers["last-event-id"];
      const raw = (Array.isArray(lastHeader) ? lastHeader[0] : lastHeader) ?? url.searchParams.get("lastEventId") ?? undefined;
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      broadcaster.add(res, raw, snapshot, deps.version);
      return;
    }

    if (route === "GET /harnesses") {
      const refresh = url.searchParams.get("refresh") === "1";
      const harnesses = await deps.registry.all({ force: refresh });
      // 角色对照刚探测到的执行端评估一遍（MCP 的 harnesses 工具据此告诉主 Agent 哪些角色此刻能用）；网页自己用快照里的定义本地评估。
      const response: HarnessesResponse = { harnesses, profiles: reportProfiles(deps.settings.profilesView(), harnesses) };
      return sendJson(res, 200, response);
    }

    if (parts[0] === "profiles" && parts.length === 2 && (method === "PUT" || method === "DELETE")) {
      const name = decodeSegment(parts[1]);
      if (method === "DELETE") {
        await deps.settings.setProfile(name, null);
      } else {
        const { create, ...spec } = parseBody(putProfileBody, await readJson(req));
        // 只拦手误：执行端 id 拼错、或指向一个这台服务没有启用的执行端。这一版不认识的执行端只会出现在手改的文件里，不是从这里写进去的。
        if (!deps.registry.ids().some((id) => id === spec.harness)) throw new EnsembleError("not_found", `Harness "${spec.harness}" is not enabled.`);
        await deps.settings.setProfile(name, spec, { create: create === true });
      }
      const response: ProfilesResponse = { profiles: deps.settings.profilesView() };
      return sendJson(res, 200, response);
    }

    if (parts[0] === "profiles" && parts[2] === "rename" && parts.length === 3 && method === "POST") {
      const body = parseBody(renameProfileBody, await readJson(req));
      await deps.settings.renameProfile(decodeSegment(parts[1]), body.to);
      const response: ProfilesResponse = { profiles: deps.settings.profilesView() };
      return sendJson(res, 200, response);
    }

    if (parts[0] === "harnesses" && parts[2] === "models" && parts.length === 3 && method === "PUT") {
      const id = parts[1] as HarnessId;
      const executor = deps.registry.get(id);
      if (!executor) throw new EnsembleError("not_found", `Harness "${id}" is not enabled.`);
      const body = parseBody(setModelsBody, await readJson(req));
      const chosen = body.userDefaultModel;
      // 有限制时“必须在名单里”由 settings 在写入时核对；不设限时要对照执行端目录，只有这里拿得到。
      if (typeof chosen === "string" && body.allowed === null) {
        const catalog = (await deps.registry.info(id))?.models.map((model) => model.id) ?? [];
        if (defaultModelFault(catalog, null, chosen) !== undefined) {
          throw new EnsembleError("model_not_allowed", `Model "${chosen}" cannot be the default: harness "${id}" does not report it.`, { harness: id, requested: chosen });
        }
      }
      await deps.settings.setAllowedModels(id, body.allowed, body.efforts, chosen);
      const response: SetAllowedModelsResponse = { harness: deps.registry.current(executor) };
      return sendJson(res, 200, response);
    }

    // 只有网页的设置窗口会调（MCP 没有对应的工具：并发上限是用户定的，不是主 Agent 能改的）。
    // 与其他写入口一样要过上面的 Origin 检查：别的网页不能借浏览器替用户改。落盘成功之后新上限已在 manager 里生效，回执给的是生效后的样子。
    if (route === "PUT /settings/concurrency") {
      const body = parseBody(setConcurrencyBody, await readJson(req));
      await deps.concurrency.set(body.max);
      const response: SetConcurrencyResponse = { capacity: deps.manager.capacity(), concurrency: deps.concurrency.view() };
      return sendJson(res, 200, response);
    }

    // archived：exclude（缺省，已归档的不出现）｜include｜only。老的调用方不带这个参数，看到的就是“没被归档的会话”。
    if (route === "GET /sessions") return sendJson(res, 200, { sessions: deps.hub.allSummaries(archivedFilterOf(url)) });

    // 归档 / 取消归档只改“默认视图里看不看得见”，不动会话的状态与记录（规则见 shared/archive.ts）。
    // 请求里的 id 各有各的结局（changed / skipped 带原因）；整个请求只在格式不对时才失败。过上面的 Origin 检查，别的网页不能借浏览器替用户整理。
    if (route === "POST /sessions/archive") {
      const body = parseBody(archiveBody, await readJson(req));
      const response: ArchiveResponse = await archiveSessions(deps.hub, body.ids, "user");
      return sendJson(res, 200, response);
    }
    if (route === "POST /sessions/unarchive") {
      const body = parseBody(unarchiveBody, await readJson(req));
      const response: ArchiveResponse = await unarchiveSessions(deps.hub, body.ids, { exact: body.exact === true });
      return sendJson(res, 200, response);
    }

    if (route === "GET /retention") {
      const response: RetentionResponse = retentionResponse();
      return sendJson(res, 200, response);
    }

    // 保存之后立刻清扫一次再回答：用户点“保存”想马上看到结果（lastSweep.archived 是这次归档的会话数，含随根一起归档的后代）。
    // 清扫本身失败（比如磁盘写不进归档标记）时这次请求也报错，但设置已经存下了：下一次清扫（每小时一次）会用它。
    if (route === "PUT /retention") {
      const body = parseBody(retentionBody, await readJson(req));
      await deps.settings.setRetention(body);
      await deps.retention.sweep();
      const response: RetentionResponse = retentionResponse();
      return sendJson(res, 200, response);
    }

    if (route === "GET /git") {
      // 只回答 Ensemble 已经知道的工作目录（来源的工作目录、会话的运行目录），不做任意目录的探测。
      const path = url.searchParams.get("path") ?? "";
      if (!path) throw new EnsembleError("invalid_request", "Missing path.");
      if (!isKnownWorkspace(deps.hub.allSummaries(), path)) throw new EnsembleError("not_found", "That directory is not a known workspace.");
      const response: GitResponse = await deps.git.inspect(path);
      return sendJson(res, 200, response);
    }

    if (route === "POST /sessions") {
      const body = parseBody(delegateBody, await readJson(req));
      const fromBridge = req.headers["x-ensemble-client"] === "mcp";
      // 老版本的桥把自己的启动目录（Cursor 里是用户主目录）记成来源的工作目录：这里按显式传入的 cwd 改正，见 legacy-origin.ts。
      const origin = fromBridge && body.origin ? reconcileLegacyWorkspace(body.origin, body.cwd) : CONSOLE_ORIGIN;
      // 带 profile 时先按角色解析出实际的执行端 / 模型 / 强度 / 访问权限，再交给 manager：它的校验与判重看到的都是实际取值。
      const resolved = await resolveDelegationFields({ settings: deps.settings, registry: deps.registry }, body);
      const result = await deps.manager.delegate({
        harness: resolved.harness,
        task: body.task,
        cwd: body.cwd,
        origin,
        ...(body.title ? { title: body.title } : {}),
        ...(resolved.model ? { model: resolved.model } : {}),
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(resolved.access ? { access: resolved.access } : {}),
        ...(body.context ? { context: body.context } : {}),
        ...(body.parentSessionId ? { parentSessionId: body.parentSessionId } : {}),
        // 汇聚：上级的两种写法在 manager.delegate 里归一化与核对（对不上就是 400）。
        ...(body.parentSessionIds ? { parentSessionIds: body.parentSessionIds } : {}),
        ...(body.allowDuplicate ? { allowDuplicate: true } : {}),
      });
      const response: DelegateResponse = { ...result, summary: summaryOf(result.sessionId), ...(resolved.profile ? { profile: resolved.profile } : {}) };
      // 命中重复时没有创建任何东西：200（要的会话已经在那里），而不是 201，也不是 409——对调用方这不是失败。
      return sendJson(res, result.duplicate ? 200 : 201, response);
    }

    if (sessionId && parts.length === 2 && method === "GET") {
      // 先取摘要、再读事件：期间若有新事件，事件只会比摘要新、不会比它旧（客户端按 seq 去重，重复无害，缺口才有害）。
      // 冷的 / 已归档的会话读的是事件日志文件，不会因为被看一眼就整个载入内存。
      deps.hub.flushStaged(sessionId);
      const summary = summaryOf(sessionId);
      const detail: SessionDetail = { summary, events: await deps.hub.readEvents(sessionId) };
      return sendJson(res, 200, detail);
    }

    if (sessionId && parts[2] === "events" && parts.length === 3 && method === "GET") {
      deps.hub.flushStaged(sessionId);
      const summary = summaryOf(sessionId);
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const limitParam = Number(url.searchParams.get("limit") ?? 0) || undefined;
      const events = await deps.hub.readEvents(sessionId, { afterSeq: after, ...(limitParam ? { limit: limitParam } : {}) });
      const response: EventsResponse = {
        sessionId,
        events,
        // 摘要里的 seq 对热的与冷的会话都是同一个口径；读取期间若又来了新事件，以读到的为准，lastSeq 不能比自己返回的事件还旧。
        lastSeq: Math.max(summary.seq, events.at(-1)?.seq ?? 0),
      };
      return sendJson(res, 200, response);
    }

    // 导出会话报告（只读）：把这个会话或它名下的整棵任务树渲染成一份 Markdown 附件，版式与取舍见 shared/report.ts。
    // 先查会话（404）再校验参数（400）；冷的 / 已归档的会话与热的内容一致：读的是同一份事件，不解冻，也不改动任何记录。
    if (sessionId && parts[2] === "report" && parts.length === 3 && method === "GET") {
      deps.hub.flushStaged(sessionId);
      const summary = summaryOf(sessionId);
      const query = parseQuery(reportQuery, url);
      const markdown = await buildSessionReport(deps.hub, sessionId, {
        scope: query.scope,
        detail: query.detail,
        lang: query.lang,
        maxChars: query.maxChars,
        exportedAt: isoNow(),
        version: deps.version,
      });
      const body = Buffer.from(markdown, "utf8");
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": body.length,
        "content-disposition": reportDisposition(reportFilename(summary, query)),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    if (sessionId && parts[2] === "messages" && parts.length === 3 && method === "POST") {
      const body = parseBody(sendBody, await readJson(req));
      // 署名取自摘要：对冷的 / 已归档的会话不必为此把它载入内存（manager.send 会按需载入、并在发送后取消归档）。
      const summary = summaryOf(sessionId);
      const fromBridge = req.headers["x-ensemble-client"] === "mcp" && body.originKey !== undefined;
      const author: Actor = fromBridge
        ? { kind: "agent", label: summary.origin.hostLabel, originKey: body.originKey as string }
        : USER_ACTOR;
      const result = await deps.manager.send(sessionId, {
        text: body.text,
        author,
        ...(body.mode ? { mode: body.mode } : {}),
      });
      const response: SendResponse = { ...result, summary: summaryOf(sessionId) };
      return sendJson(res, 200, response);
    }

    // 回答 / 不回答执行端的提问（业务提问，不是授权；见 shared/questions.ts）。不是 messages：那是对会话说话，这是对一个具体的提问作答。
    // 署名规则同 messages：MCP 桥带 originKey 才算主 Agent，否则是用户。先到先得——已有结局或执行端已不再等待时是 409，带着当前的结局。
    if (sessionId && parts[2] === "questions" && parts.length === 5 && method === "POST" && (parts[4] === "answer" || parts[4] === "decline")) {
      const questionId = decodeSegment(parts[3]);
      const summary = summaryOf(sessionId);
      if (parts[4] === "answer") {
        const body = parseBody(answerQuestionBody, await readJson(req));
        const resolved = await deps.manager.answerQuestion(
          sessionId,
          questionId,
          { answer: body.answer, answers: body.answers },
          questionActor(req, summary, body.originKey),
        );
        const response: QuestionResolvedResponse = { ...resolved, summary: summaryOf(sessionId) };
        return sendJson(res, 200, response);
      }
      const body = parseBody(declineQuestionBody, await readJson(req));
      const resolved = await deps.manager.declineQuestion(sessionId, questionId, body.note, questionActor(req, summary, body.originKey));
      const response: QuestionResolvedResponse = { ...resolved, summary: summaryOf(sessionId) };
      return sendJson(res, 200, response);
    }

    if (sessionId && parts[2] === "parent" && parts.length === 3 && method === "POST") {
      const body = parseBody(relinkBody, await readJson(req));
      // 两种写法归一成一个有序列表；空列表只会来自 `parentSessionId: null`（给了空的 parentSessionIds 已经被拒绝），意思是去掉上级。
      const parents = normalizeParents(body);
      const result = await deps.manager.relink(sessionId, parents.length > 0 ? parents : null, requestActor(req));
      const response: RelinkResponse = { ...result, summary: summaryOf(sessionId) };
      return sendJson(res, 200, response);
    }

    if (sessionId && parts[2] === "cancel" && parts.length === 3 && method === "POST") {
      const result = await deps.manager.cancel(sessionId, requestActor(req));
      const response: CancelResponse = { ...result, summary: summaryOf(sessionId) };
      return sendJson(res, 200, response);
    }

    if (sessionId && parts[2] === "stop" && parts.length === 3 && method === "POST") {
      await deps.manager.stop(sessionId, requestActor(req));
      return sendJson(res, 200, { summary: summaryOf(sessionId) });
    }

    if (sessionId && parts.length === 2 && method === "DELETE") {
      await deps.manager.remove(sessionId);
      return sendJson(res, 200, { removed: sessionId });
    }

    if (route === "POST /wait") {
      const body = parseBody(waitBody, await readJson(req));
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const result = await waitForSessions(
        { hub: deps.hub, notices: deps.notices, questions: !legacyBridge },
        {
          sessionIds: body.sessionIds,
          ...(body.mode ? { mode: body.mode } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
          ...(body.originKey ? { originKey: body.originKey } : {}),
          ...(body.attention !== undefined ? { attention: body.attention } : {}),
        },
        controller.signal,
      );
      if (!res.writableEnded && !res.destroyed) sendJson(res, 200, result);
      return;
    }

    if (route === "POST /notices/collect") {
      const body = parseBody(collectBody, await readJson(req));
      const response: CollectNoticesResponse = { notices: deps.notices.collect(body.originKey) };
      return sendJson(res, 200, response);
    }

    if (route === "POST /shutdown") {
      sendJson(res, 200, { ok: true });
      setImmediate(deps.onShutdownRequest);
      return;
    }

    throw new EnsembleError("not_found", `No route for ${method} ${url.pathname}.`);
  }

  function fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof EnsembleError) {
      const body: ErrorBody = {
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      };
      sendJson(res, error.status, body);
      return;
    }
    deps.log.error("unhandled request error", { error });
    const body: ErrorBody = { error: { code: "internal", message: "Internal server error." } };
    sendJson(res, 500, body);
  }

  return { server, broadcaster };
}

// ───────────────────────── 安全检查 ─────────────────────────

function checkHost(req: IncomingMessage, port: number): void {
  const host = req.headers.host ?? "";
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowed.includes(host)) {
    throw new EnsembleError("forbidden", "Unexpected Host header; Ensemble only serves local requests.");
  }
}

function checkOrigin(req: IncomingMessage, port: number, dev: boolean): void {
  const origin = req.headers.origin;
  if (!origin) return; // 非浏览器客户端（MCP 桥、脚本）不带 Origin。
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (dev) allowed.push("http://localhost:5173", "http://127.0.0.1:5173");
  if (!allowed.includes(origin)) {
    throw new EnsembleError("forbidden", "Cross-origin requests are not allowed.");
  }
}

function authorize(req: IncomingMessage, url: URL, token: string): void {
  const header = req.headers[TOKEN_HEADER];
  const provided = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new EnsembleError(INVALID_TOKEN, "Missing or invalid Ensemble token.");
  }
}

function requestActor(req: IncomingMessage): Actor {
  return req.headers["x-ensemble-client"] === "mcp" ? { kind: "agent", label: "Agent" } : USER_ACTOR;
}

/** 回答提问的署名：与 messages 一致，MCP 桥带了 originKey 才算主 Agent（标签取自来源宿主），否则是用户。 */
function questionActor(req: IncomingMessage, summary: SessionSummary, originKey: string | undefined): Actor {
  return req.headers["x-ensemble-client"] === "mcp" && originKey !== undefined
    ? { kind: "agent", label: summary.origin.hostLabel, originKey }
    : USER_ACTOR;
}

const QUESTIONS_FEATURE = "session-questions" satisfies ServiceFeature;

/**
 * 老桥：自称 MCP 桥，却没有声明认识“提问”（见 ACCEPTS_HEADER）。
 * 网页不带 `x-ensemble-client`，永远不算老桥——它和服务同一版本。
 */
function isLegacyBridge(req: IncomingMessage): boolean {
  if (req.headers["x-ensemble-client"] !== "mcp") return false;
  const header = req.headers[ACCEPTS_HEADER];
  const accepted = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((name) => name.trim());
  return !accepted.includes(QUESTIONS_FEATURE);
}

/** 发给老桥的响应：见 `withoutQuestionItems`。 */
const legacyResponses = new WeakSet<ServerResponse>();

/**
 * 老桥遇到没见过的“值得留意”种类，会把整行渲染成 `attention: undefined`：
 * 给它的摘要（`attention`）与 wait 的 `raised` 里不带提问，其余原样。提问仍在事件日志里，老桥读事件时按“不认识的事件”忽略。
 */
function withoutQuestionItems(key: string, value: unknown): unknown {
  if ((key !== "attention" && key !== "raised") || !Array.isArray(value)) return value;
  const kept = value.filter((entry: unknown) => {
    const record = entry as { kind?: unknown; item?: { kind?: unknown } } | null;
    return record?.kind !== "question" && record?.item?.kind !== "question";
  });
  if (kept.length === value.length) return value;
  // 空了就整个省略：与服务端“没有则省略”的约定一致。
  return kept.length > 0 ? kept : undefined;
}

/** 列表接口的 archived 参数：缺省 = exclude；写错了明确拒绝，不悄悄当成缺省值（误拼的 only 会让调用方以为“没有已归档的”）。 */
function archivedFilterOf(url: URL): ArchivedFilter {
  const value = url.searchParams.get("archived");
  if (value === null || value === "exclude") return "exclude";
  if (value === "include" || value === "only") return value;
  throw new EnsembleError("invalid_request", `archived must be one of exclude, include, only (got "${value}").`);
}

/** 路径段是没解码的原文（`url.pathname` 保持百分号编码）：角色名取用前要解码；格式坏了是调用方的错，不是 500。 */
function decodeSegment(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? "");
  } catch {
    throw new EnsembleError("invalid_request", "The name in the URL is not valid percent-encoding.");
  }
}

/** 目录是否是某个来源的工作目录或某个会话的运行目录；Windows 上不分大小写。 */
function isKnownWorkspace(summaries: readonly SessionSummary[], path: string): boolean {
  const canonical = (value: string): string => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
  const wanted = canonical(path);
  return summaries.some((summary) => (summary.origin.workspace !== undefined && canonical(summary.origin.workspace) === wanted) || canonical(summary.cwd) === wanted);
}

// ───────────────────────── 请求与响应 ─────────────────────────

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new EnsembleError("invalid_request", "The request body is too large.");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EnsembleError("invalid_request", "The request body is not valid JSON.");
  }
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: import("zod").ZodError } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EnsembleError("invalid_request", formatZodError(parsed.error));
  return parsed.data;
}

/** 校验查询参数：与请求体同一套规则与错误格式；不认识的参数（比如 `token`）被忽略。 */
function parseQuery<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: import("zod").ZodError } }, url: URL): T {
  return parseBody(schema, Object.fromEntries(url.searchParams));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, legacyResponses.has(res) ? withoutQuestionItems : undefined);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// ───────────────────────── 静态页面 ─────────────────────────

async function serveStatic(pathname: string, res: ServerResponse, deps: HttpDeps, headOnly: boolean): Promise<void> {
  const root = deps.webRoot;
  if (!root) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The Ensemble web UI has not been built. Run `npm run build` first.");
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new EnsembleError("invalid_request", "Malformed path.");
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = join(root, relative);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new EnsembleError("forbidden", "Path escapes the web root.");
  }

  let file = candidate;
  let info = await stat(file).catch(() => undefined);
  if (!info || info.isDirectory()) {
    const hasExtension = extname(relative) !== "";
    if (hasExtension) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    file = join(root, "index.html");
    info = await stat(file).catch(() => undefined);
    if (!info) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("The Ensemble web UI has not been built. Run `npm run build` first.");
      return;
    }
  }

  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const isIndex = file.endsWith(`${sep}index.html`);
  let body: Buffer | string = await readFile(file);
  if (isIndex) {
    body = body
      .toString("utf8")
      .replace('name="ensemble-token" content=""', `name="ensemble-token" content="${deps.token}"`)
      .replace('name="ensemble-lang" content=""', `name="ensemble-lang" content="${deps.lang ?? ""}"`);
  }
  const length = typeof body === "string" ? Buffer.byteLength(body) : body.length;
  res.writeHead(200, {
    "content-type": type,
    "content-length": length,
    "cache-control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
  });
  res.end(headOnly ? undefined : body);
}
