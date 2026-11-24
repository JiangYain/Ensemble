import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServiceClient } from "./client";
import { renderSessions, renderSharedOriginHint } from "./format";
import { compactSession, fetchAllSessions, sessionsOfOrigin } from "./session-view";
import { conversationIdField, type Guard } from "./tool-call";

/** `status` 工具要从桥那里借的东西：统一外壳，以及服务客户端（取会话清单、面板地址）。 */
export interface StatusToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "request" | "panelUrl">;
}

export function registerStatusTool(server: McpServer, deps: StatusToolDeps): void {
  server.registerTool(
    "status",
    {
      title: "Show delegated sessions",
      description:
        "List delegated sessions with their state, current activity and progress, plus `attention:` lines for anything worth a look (no events for minutes, a tool with no news for a long time, a very long run, two sessions writing one file, an unconfirmed message), and a `question` block for each question a session is waiting on (answer it with `send`). Defaults to the sessions you started in this conversation. Prefer `wait` over polling this. " +
        "Archived sessions (finished ones the user or a retention policy moved out of the default view; their history is kept and `read` still works on them) are left out unless you pass `includeArchived` or name them in `sessionIds`; the reply says how many were left out.",
      inputSchema: {
        sessionIds: z.array(z.string().max(100)).max(50).optional().describe("Only these sessions (archived ones are returned too, marked archived)."),
        scope: z.enum(["mine", "all"]).optional().describe("mine (default): sessions started from this conversation. all: every session in Ensemble."),
        includeArchived: z.boolean().optional().describe("Also list archived sessions. Default false: they are left out and the reply states how many."),
        detail: z.boolean().optional().describe("Include model, access, workspace and latest output for each session."),
        conversationId: conversationIdField,
      },
      annotations: { title: "Session status", readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      deps.guard("status", extra, args, async (call) => {
        const all = await fetchAllSessions(deps.client);
        const scope = args.scope ?? "mine";
        const inScope = scope === "mine" ? sessionsOfOrigin(all, call) : all;
        // 已归档的会话默认不列（点名的 sessionIds、或要求 includeArchived 的除外）；被略去的数量如实说出来，免得主 Agent 以为它们不存在。
        const listArchived = (args.sessionIds?.length ?? 0) > 0 || args.includeArchived === true;
        const mine = listArchived ? inScope : inScope.filter((session) => !session.archivedAt);
        const omitted = inScope.length - mine.length;
        let list = args.sessionIds?.length ? all.filter((session) => args.sessionIds?.includes(session.id)) : mine;
        const missing = (args.sessionIds ?? []).filter((id) => !all.some((session) => session.id === id));
        list = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const shown = list.slice(0, 30);
        const panel = await deps.client.panelUrl();
        const header = `${list.length} session${list.length === 1 ? "" : "s"}${args.sessionIds?.length ? "" : ` (${scope})`}${list.length > shown.length ? `, showing the 30 most recently active` : ""}:`;
        const empty =
          omitted > 0
            ? scope === "mine" ? "None of your sessions in this conversation is unarchived." : "No unarchived sessions."
            : scope === "mine" ? "You have not delegated anything in this conversation yet." : "No sessions yet.";
        const text = [
          list.length === 0 ? empty : `${header}\n${renderSessions(shown, { detail: args.detail === true })}`,
          ...(missing.length > 0 ? [`Not found: ${missing.join(", ")}`] : []),
          `Panel: ${panel}`,
          ...(omitted > 0
            ? [`Not listed: ${omitted} archived session${omitted === 1 ? "" : "s"} (finished sessions moved out of the default view; their history is kept and \`read\` still works on them). Pass \`includeArchived: true\` to list them.`]
            : []),
        ].join("\n");
        // 来源只有桥进程级别的身份、名下在跑的会话又分散在不同目录时，提醒这个来源可能被多个对话共用（见 renderSharedOriginHint）。
        const footer = scope === "mine" && !args.sessionIds?.length ? renderSharedOriginHint(call.origin, mine) : undefined;
        return {
          text,
          data: { sessions: shown.map(compactSession), panelUrl: panel, ...(omitted > 0 ? { archivedOmitted: omitted } : {}), ...(footer ? { originMaybeShared: true } : {}) },
          ...(footer ? { footer } : {}),
        };
      }),
  );
}
