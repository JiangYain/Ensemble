import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServiceClient } from "./client";
import { conversationIdField, type Guard } from "./tool-call";

/** `open_panel` 工具要从桥那里借的东西：统一外壳、服务客户端（面板地址），以及在系统浏览器里打开地址（与委派之后的自动打开是同一个，见 panel-opener.ts）。 */
export interface PanelToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "panelUrl">;
  openInSystemBrowser: (url: string) => Promise<void>;
}

export function registerPanelTool(server: McpServer, deps: PanelToolDeps): void {
  server.registerTool(
    "open_panel",
    {
      title: "Open the Ensemble panel",
      description:
        "Get (or open) the localhost panel where the user can watch every delegated session and intervene. By default this returns the URL for you to open in your host's own browser panel or sidebar; set where=\"system_browser\" to launch the default browser instead.",
      inputSchema: {
        sessionId: z.string().max(100).optional().describe("Focus this session's node."),
        where: z.enum(["host_browser", "system_browser"]).optional(),
        conversationId: conversationIdField,
      },
      annotations: { title: "Open panel", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      deps.guard("open_panel", extra, args, async () => {
        const url = await deps.client.panelUrl(args.sessionId);
        if (args.where === "system_browser") {
          await deps.openInSystemBrowser(url);
          return { text: `Opened ${url} in the system browser.`, data: { url, opened: "system_browser" } };
        }
        return {
          text: `Panel: ${url}\nOpen it in your browser tool (side panel or in-app browser) so the user can watch and steer. If you have no browser tool, call this again with where="system_browser".`,
          data: { url },
        };
      }),
  );
}
