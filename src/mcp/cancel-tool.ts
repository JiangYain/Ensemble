import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CancelResponse } from "@shared/protocol";
import type { SessionSummary } from "@shared/types";
import { ServiceError, type ServiceClient } from "./client";
import { renderSessionLine } from "./format";
import { conversationIdField, type Guard } from "./tool-call";

/** `cancel` 工具要从桥那里借的东西：统一外壳，以及服务客户端。 */
export interface CancelToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "request">;
}

export function registerCancelTool(server: McpServer, deps: CancelToolDeps): void {
  server.registerTool(
    "cancel",
    {
      title: "Interrupt or stop a session",
      description:
        "Interrupt the session's current run (it stays open and can take a follow-up via `send`). Set stop=true to close the session entirely. Queued messages are cancelled too.",
      inputSchema: {
        sessionId: z.string().min(1).max(100),
        stop: z.boolean().optional().describe("Close the session instead of just interrupting the run."),
        conversationId: conversationIdField,
      },
      // 只中断运行或关闭会话：历史记录都保留，也不删除任何文件，所以不是破坏性操作；
      // 否则批准策略为 never 的宿主会直接拒绝这个调用。
      annotations: { title: "Cancel session", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      deps.guard("cancel", extra, args, async (call) => {
        const id = encodeURIComponent(args.sessionId);
        if (args.stop) {
          const response = await deps.client.request<{ summary: SessionSummary }>("POST", `/api/sessions/${id}/stop`, { signal: call.signal, timeoutMs: 30_000 });
          return { text: `Session closed.\n${renderSessionLine(response.summary)}`, data: { phase: response.summary.phase } };
        }
        let response: CancelResponse;
        try {
          response = await deps.client.request<CancelResponse>("POST", `/api/sessions/${id}/cancel`, { signal: call.signal, timeoutMs: 30_000 });
        } catch (error) {
          // 没有在运行的内容并不是故障，让主 Agent 知道即可。
          if (error instanceof ServiceError && error.code === "conflict" && /no active or queued run/i.test(error.message)) {
            return { text: "Nothing was running, so there was nothing to interrupt. The session is still open; use `send` to continue it or `cancel` with stop=true to close it.", data: { interrupted: false } };
          }
          throw error;
        }
        const parts = [
          response.interrupted ? "Requested interruption of the current run; the session stays open and can take a follow-up via `send`." : "Nothing was running, so there was nothing to interrupt.",
          ...(response.cancelledQueued > 0 ? [`Cancelled ${response.cancelledQueued} queued message${response.cancelledQueued === 1 ? "" : "s"}.`] : []),
        ];
        return { text: `${parts.join(" ")}\n${renderSessionLine(response.summary)}`, data: { interrupted: response.interrupted, phase: response.summary.phase } };
      }),
  );
}
