import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WaitResponse } from "@shared/protocol";
import { isSessionSettled } from "@shared/session-end";
import type { ServiceClient } from "./client";
import { renderSessions, renderSharedOriginHint } from "./format";
import { BATCH_LIMIT, BATCH_READ_HINT } from "./read";
import { compactSession, fetchAllSessions, sessionsOfOrigin } from "./session-view";
import { conversationIdField, type Guard } from "./tool-call";

/** `wait` 工具要从桥那里借的东西：统一外壳，以及服务客户端（取会话清单、发起等待）。 */
export interface WaitToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "request">;
}

/** 多个会话都结束之后，提示可以一次取回全部结论：只是文字里多一段，`wait` 的结构化结果不变。 */
function batchReadHint(count: number): string {
  return count >= 2 && count <= BATCH_LIMIT ? `\n\n${BATCH_READ_HINT}` : "";
}

export function registerWaitTool(server: McpServer, deps: WaitToolDeps): void {
  server.registerTool(
    "wait",
    {
      title: "Wait for sessions to finish",
      description:
        "Block (up to about 45 seconds) until delegated sessions finish, the user intervenes, a session newly shows something worth a look, or a session asks a question. Returns the moment something worth acting on happens, so call it instead of polling. " +
        "Things worth a look are facts with evidence, not verdicts: no events for minutes, a tool call with no news for a long time, a run that has gone on very long, two running sessions writing the same file, a message the harness has not confirmed. They appear as `attention:` lines under the session; ones that already existed when you called do not end the wait. " +
        "A question a session is waiting on is different: it always ends the wait the first time you are told about it (even with `attention: false`), and appears as a `question` block with its id, the question and the options — reply with `send`. You are told once; `status` and `read` keep showing it while it is open. " +
        "If it times out, the remaining sessions have not finished yet — wait again or do other work. Defaults to every unfinished session you started.",
      inputSchema: {
        sessionIds: z.array(z.string().max(100)).max(50).optional().describe("Sessions to wait for. Defaults to all your unfinished sessions."),
        mode: z.enum(["all_settled", "any_settled"]).optional().describe("Return when all of them are done (default) or as soon as any one is."),
        timeoutSeconds: z.number().int().min(1).max(45).optional().describe("How long to wait; default 30."),
        attention: z.boolean().optional().describe("Also return early when a session newly shows something worth a look (default true). Pass false to wait strictly for completion — a question a session asks still ends the wait, because the session is waiting for the answer."),
        conversationId: conversationIdField,
      },
      annotations: { title: "Wait for sessions", readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      deps.guard("wait", extra, args, async (call) => {
        const everyone = args.sessionIds?.length ? [] : sessionsOfOrigin(await fetchAllSessions(deps.client), call);
        // 默认的等待范围不含已归档的会话：归档的都是已结束的，既不用等，也不该把下面“都已结束”的清单撑大；点名的 sessionIds 不受影响。
        const mine = everyone.filter((session) => !session.archivedAt);
        const ids = args.sessionIds?.length ? args.sessionIds : mine.filter((session) => !isSessionSettled(session)).map((session) => session.id);
        if (ids.length === 0) {
          if (mine.length === 0) {
            return {
              text:
                everyone.length > 0
                  ? "Nothing to wait for — all of your sessions in this conversation are archived (finished). `status` with `includeArchived: true` lists them, and `read` still works on them."
                  : "Nothing to wait for — you have no delegated sessions in this conversation.",
            };
          }
          // 都已结束：直接把结果摘要交给主 Agent，而不是让它再追问一次。
          return {
            text: `All of your sessions have already finished:\n${renderSessions(mine, { detail: true })}${batchReadHint(mine.length)}`,
            data: { reason: "settled", sessions: mine.map(compactSession) },
          };
        }

        const timeoutMs = Math.min(args.timeoutSeconds ?? 30, 45) * 1000;
        const response = await deps.client.request<WaitResponse>("POST", "/api/wait", {
          body: { sessionIds: ids, ...(args.mode ? { mode: args.mode } : {}), ...(args.attention !== undefined ? { attention: args.attention } : {}), timeoutMs, originKey: call.origin.key },
          timeoutMs: timeoutMs + 10_000,
          signal: call.signal,
        });

        const settled = response.sessions.filter(isSessionSettled).length;
        // 提问与别的“值得留意”分开说：前者是在等一个答案，后者只是一条事实。
        const raised = response.raised ?? [];
        const askingIds = [...new Set(raised.filter((entry) => entry.item.kind === "question").map((entry) => entry.sessionId))];
        const raisedIds = [...new Set(raised.filter((entry) => entry.item.kind !== "question").map((entry) => entry.sessionId))];
        const sessionList = (ids: readonly string[]): string => (ids.length === 1 ? `Session ${ids[0]}` : `Sessions ${ids.join(", ")}`);
        const headline = {
          // 没结束的会话可能在排队、启动、运行或待命，所以这里与下面两处都只说“还没结束”，不说“在运行”。
          settled: settled === response.sessions.length ? "All sessions have finished." : `${settled} of ${response.sessions.length} sessions have finished; the rest have not finished yet.`,
          notice: "The user intervened directly on a session (details below).",
          attention: [
            ...(askingIds.length > 0
              ? [`${sessionList(askingIds)} ${askingIds.length === 1 ? "is" : "are"} asking a question and waiting for an answer (the \`question\` blocks below). Reply with \`send\`: \`questionId\` plus \`answer\`/\`answers\`, or \`decline: true\` to let the session use its own judgment.`]
              : []),
            ...(raisedIds.length > 0
              ? [`${sessionList(raisedIds)} newly show${raisedIds.length === 1 ? "s" : ""} something worth a look (the \`attention:\` lines below). ${raisedIds.length === 1 ? "It has" : "They have"} not finished yet; this is a fact to check, not a verdict.`]
              : []),
          ].join(" "),
          timeout: `Timed out after ${Math.round(timeoutMs / 1000)}s — ${settled === 0 ? "nothing has finished yet" : `only ${settled} of ${response.sessions.length} sessions have finished`}. Wait again or do other work.`,
        }[response.reason];
        // 没有显式给 sessionIds 时，等的是“你名下所有没结束的会话”：把实际等的会话列出来，免得主 Agent 以为等的是别的。
        const waitedOn = args.sessionIds?.length ? undefined : `Waited on ${ids.length} unfinished session${ids.length === 1 ? "" : "s"} of yours (no \`sessionIds\` given): ${ids.join(", ")}.`;
        const text =
          [headline, ...(waitedOn ? [waitedOn] : []), "", renderSessions(response.sessions, { detail: response.reason === "settled" })].join("\n") +
          (settled === response.sessions.length ? batchReadHint(response.sessions.length) : "");
        const footer = args.sessionIds?.length ? undefined : renderSharedOriginHint(call.origin, mine);
        return {
          text,
          ...(footer ? { footer } : {}),
          data: {
            reason: response.reason,
            waitedOn: ids,
            sessions: response.sessions.map(compactSession),
            ...(footer ? { originMaybeShared: true } : {}),
            ...(response.raised?.length
              ? { raised: response.raised.map((entry) => ({ sessionId: entry.sessionId, kind: entry.item.kind, since: entry.item.since, ...(entry.item.kind === "question" ? { questionId: entry.item.questionId } : {}) })) }
              : {}),
          },
        };
      }),
  );
}
