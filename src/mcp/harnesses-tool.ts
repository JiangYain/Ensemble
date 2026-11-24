import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { effortsLimited, resolveModelChoices } from "@shared/models";
import type { HarnessesResponse } from "@shared/protocol";
import type { ServiceClient } from "./client";
import { renderHarness } from "./format";
import { profilesData, renderProfiles } from "./format-profiles";
import { conversationIdField, type Guard } from "./tool-call";

/** `harnesses` 工具要从桥那里借的东西：统一外壳，以及服务客户端。 */
export interface HarnessesToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "request">;
}

export function registerHarnessesTool(server: McpServer, deps: HarnessesToolDeps): void {
  server.registerTool(
    "harnesses",
    {
      title: "List available harnesses",
      description: "Show which harnesses (Cursor, Codex, Pi, Claude Code, OpenCode, DSH) are ready, the models you may choose (the user can restrict these per harness), which abilities are verified, and which access levels are really enforced, plus any roles the user defined (usable as `profile` in `delegate`). Call this before delegating if unsure.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Re-check instead of using the cached result."),
        conversationId: conversationIdField,
      },
      annotations: { title: "Harnesses", readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      deps.guard("harnesses", extra, args, async (call) => {
        const response = await deps.client.request<HarnessesResponse>("GET", `/api/harnesses${args.refresh ? "?refresh=1" : ""}`, { timeoutMs: 60_000, signal: call.signal });
        const entries = response.harnesses.map((harness) => {
          const choices = resolveModelChoices(harness);
          return {
            text: renderHarness(harness, choices),
            data: {
              id: harness.id,
              status: harness.status,
              runtime: harness.runtime,
              // 能否把这个执行端遇到的业务提问转给你：没有这一项的不转交。
              questionRelay: harness.capabilities.question?.support ?? "no",
              defaultModel: choices.defaultModel,
              // 默认从哪来：user＝用户在设置里指定的，harness＝执行端自己的，first_open＝执行端的默认没被开放、退到第一个被开放的。
              ...("defaultSource" in choices && choices.defaultSource ? { defaultSource: choices.defaultSource } : {}),
              // 用户指定过默认、现在用不了（已退回上面的 defaultModel）：不带模型名，原因见 missing / not_allowed。
              ...("staleDefault" in choices && choices.staleDefault ? { userDefaultUnavailable: choices.staleDefault.why } : {}),
              models: choices.models.map((model) => model.id),
              // 只列报告了档位的模型；这里的档位已经是用户允许的那些，defaultEffort 是不指定 effort 时实际用到的。
              modelEfforts: Object.fromEntries(
                choices.models
                  .filter((model) => (model.efforts?.length ?? 0) > 0)
                  .map((model) => [model.id, {
                    efforts: model.efforts,
                    ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
                    ...(effortsLimited(harness, model.id) ? { limitedByUser: true } : {}),
                  }]),
              ),
              ...(choices.kind === "blocked" ? { modelSettingsIssue: choices.issue } : {}),
            },
          };
        });
        // 用户定义的角色（老服务不带 profiles 字段；没有角色时不输出任何东西）。
        const roles = response.profiles ? renderProfiles(response.profiles) : undefined;
        const rolesData = response.profiles ? profilesData(response.profiles) : undefined;
        const harnessText = entries.length > 0 ? entries.map((entry) => entry.text).join("\n") : "No harnesses are enabled.";
        return {
          text: roles ? `${harnessText}\n\n${roles}` : harnessText,
          data: { harnesses: entries.map((entry) => entry.data), ...rolesData },
        };
      }),
  );
}
