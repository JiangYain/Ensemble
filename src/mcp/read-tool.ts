import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { replay } from "@shared/projection";
import type { SessionDetail } from "@shared/protocol";
import { REPORT_DETAILS, REPORT_LIMITS, REPORT_SCOPES } from "@shared/report-options";
import { ServiceError, type ServiceClient } from "./client";
import {
  BATCH_LIMIT,
  parseReadArgs,
  READ_VIEWS,
  ReadInputError,
  readBatch,
  readOne,
  type BatchOutcome,
  type ManyRequest,
  type ReportRequest,
} from "./read";
import { compactSession } from "./session-view";
import { BridgeInputError, conversationIdField, type Call, type Guard, type Output } from "./tool-call";

/** `read` 工具要从桥那里借的东西：统一外壳，以及服务客户端（取会话详情、导出报告；报告要先问服务有没有这项功能，所以还要 `connect` 与 `supports`）。 */
export interface ReadToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "request" | "connect" | "supports">;
}

/** `read` 的参数或范围错误（runIndex 越界、afterSeq 对不上……）按 BridgeInputError 处理：消息已经是写给主模型的话，其他错误原样抛出。 */
function asInputError<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw error instanceof ReadInputError ? new BridgeInputError(error.message) : error;
  }
}

/**
 * 批量读取：有界并发地取各个会话的详情，取到一个就压成事实（不同时攥着全部详情），再排成每个会话一块（排版与预算分配见 read-batch.ts）。
 * 服务对某个会话回了业务错误（没有这个会话……）只算它自己读不到，写在它那一块里；连不上服务、协议不兼容、令牌被拒这类
 * 对所有会话都一样的问题照常让整个调用失败。和单个读取一样，这里不核对会话属于谁（`read` 本来就不核对）。
 */
async function readMany(client: ReadToolDeps["client"], request: ManyRequest, call: Call): Promise<Output> {
  const batch = await readBatch(request, async (id): Promise<BatchOutcome> => {
    try {
      return { id, detail: await client.request<SessionDetail>("GET", `/api/sessions/${encodeURIComponent(id)}`, { signal: call.signal }) };
    } catch (error) {
      if (error instanceof ServiceError && error.status >= 400 && error.status !== 403) return { id, reason: error.message };
      throw error;
    }
  });
  return {
    text: batch.text,
    data: {
      view: "batch",
      sessions: batch.readable.map(compactSession),
      ...(batch.unreadable.length > 0 ? { unreadable: batch.unreadable } : {}),
    },
  };
}

/**
 * `read` 的 report 视角：整份 Markdown 报告由服务端按事件日志渲染（GET /api/sessions/:id/report），桥原样转交，不改写、不添叙述；
 * 被字数上限截短时，说明已经写在报告里（用的就是这个工具的参数名：`maxChars`、`detail`），桥不再重复。MCP 的输出一律是英文，语言固定为 en。
 * 老服务没有这条路由：先看 `session-report` 这一项，没有就如实说明，而不是把请求发过去撞上 404。
 * 和别的 `read` 一样不核对会话属于谁；只读，不会改动任何会话记录。
 */
async function readReport(client: ReadToolDeps["client"], request: ReportRequest, call: Call): Promise<Output> {
  await client.connect();
  if (!client.supports("session-report")) {
    throw new BridgeInputError(
      'The running Ensemble service is older than this plugin and cannot export reports (`view="report"`). ' +
        "Read the session with another view (`result`, `transcript`, `files`, `errors` or `commands`), or tell the user to restart Ensemble onto the current version.",
    );
  }
  const query = new URLSearchParams({ scope: request.scope, detail: request.detail, lang: "en", maxChars: String(request.maxChars) });
  const markdown = await client.request<string>("GET", `/api/sessions/${encodeURIComponent(request.sessionId)}/report?${query.toString()}`, {
    as: "text",
    // 整棵任务树要逐个会话读事件日志：比默认的 30 秒从容一些。
    timeoutMs: 60_000,
    signal: call.signal,
  });
  const raised =
    request.raisedFrom === undefined
      ? undefined
      : `Note: \`maxChars\` ${request.raisedFrom} is below the ${REPORT_LIMITS.minChars} characters a report needs, so the report was produced with maxChars=${request.maxChars}.`;
  return {
    text: markdown.trimEnd(),
    ...(raised ? { footer: raised } : {}),
    data: { view: "report", sessionId: request.sessionId, scope: request.scope, detail: request.detail, chars: markdown.length },
  };
}

export function registerReadTool(server: McpServer, deps: ReadToolDeps): void {
  server.registerTool(
    "read",
    {
      title: "Read what a session produced",
      description:
        "Fetch what a delegated session produced. `view`: \"result\" (default) = state, final answer, changed files, usage; \"transcript\" = ordered messages, tool steps and notes; " +
        "\"errors\" = only what failed (newest first); \"commands\" = the shell commands it ran, with exit codes; \"files\" = the files it changed. " +
        "\"report\" = a clean Markdown write-up of the session (delegation, key steps, changed files, final answer, usage) to archive or paste into a PR description: `scope: \"tree\"` covers the session and every session delegated below it, `detail: \"full\"` adds tool inputs and outputs. A report quotes real events verbatim and redacts nothing, so check it for secrets before sharing it. " +
        "`runIndex` limits any other view to one run. A single-session read (except \"report\") ends with `cursor: #N` — pass `afterSeq=N` next time to get only what is new or changed since (if nothing is, you get one line plus the status line). " +
        `Instead of \`sessionId\`, pass \`sessionIds\` (up to ${BATCH_LIMIT}) to collect several sessions in one call: one compact block each with the start of its answer, changed files, duration and cost. ` +
        "Only real events from the harness are shown; reasoning summaries are omitted unless requested.",
      inputSchema: {
        sessionId: z.string().min(1).max(100).optional().describe("The session to read. To read several at once use `sessionIds` instead."),
        sessionIds: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(BATCH_LIMIT)
          .optional()
          .describe(
            `Several sessions in one call (up to ${BATCH_LIMIT}), instead of \`sessionId\`: a compact block each, in the order given. Works with the default view only — not with another \`view\`, \`runIndex\` or \`afterSeq\`.`,
          ),
        view: z.enum(READ_VIEWS).optional().describe("What to show; default \"result\". \"report\" = a shareable Markdown write-up (see `scope`, `detail`)."),
        runIndex: z.number().int().min(1).optional().describe("Only this run of the session (1 = the first run; every follow-up message after it finished starts the next). Works with every view except \"report\"."),
        afterSeq: z.number().int().min(0).optional().describe("Only what is new or changed after this event number: pass the `cursor: #N` of your previous read of the same session."),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(40_000)
          .optional()
          .describe(
            `Output budget; default 12000. With \`sessionIds\` it is the total for all sessions (default 2000 per session). With view="report" the minimum is ${REPORT_LIMITS.minChars}; a report that does not fit says what was left out (raise this, or use detail="brief").`,
          ),
        includeReasoning: z.boolean().optional().describe("Include the harness's reasoning summaries in the transcript (when it provides them). Not available with view=\"report\", which never contains reasoning."),
        scope: z
          .enum(REPORT_SCOPES)
          .optional()
          .describe("Only with view=\"report\": \"session\" (default) = this session alone; \"tree\" = this session and every session delegated below it, organised as one report."),
        detail: z
          .enum(REPORT_DETAILS)
          .optional()
          .describe("Only with view=\"report\": \"brief\" (default) = key steps without tool output; \"full\" = also each tool's input and (shortened) output. Longer, so it may need a larger `maxChars`."),
        conversationId: conversationIdField,
      },
      annotations: { title: "Read session", readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      deps.guard("read", extra, args, async (call) => {
        const request = asInputError(() => parseReadArgs(args));
        if (request.kind === "many") return readMany(deps.client, request, call);
        if (request.kind === "report") return readReport(deps.client, request, call);

        const detail = await deps.client.request<SessionDetail>("GET", `/api/sessions/${encodeURIComponent(request.sessionId)}`);
        const state = replay(detail.events);
        if (!state) throw new ServiceError("internal", `Session ${request.sessionId} has no readable history.`, 500);
        const result = asInputError(() => readOne(detail, state, request));
        return {
          text: result.text,
          data: {
            session: compactSession(detail.summary),
            view: result.view,
            // 读到的位置：下次当作 afterSeq 传回。分页没读完时它停在这一页末尾的事件上，而不是最新的事件。
            seq: result.seq,
            ...(result.runIndex !== undefined ? { runIndex: result.runIndex } : {}),
            ...(result.remaining !== undefined ? { remaining: result.remaining } : {}),
          },
        };
      }),
  );
}
