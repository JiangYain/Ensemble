import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIMITS } from "@shared/constants";
import { contextItem } from "@shared/context-schema";
import type { DelegateResponse } from "@shared/protocol";
import type { ServiceClient } from "./client";
import { renderDelegateOutput } from "./delegate-output";
import { markFollowsFailure, prepareDelegateRequest, type DelegateArgs, type DelegateEnvironment } from "./delegate-request";
import { conversationIdField, type Call, type Guard, type Output } from "./tool-call";

/** `delegate` 工具要从桥那里借的东西：统一外壳、服务客户端、构造请求要问的几件事，以及“打开面板”的一次性开关。 */
export interface DelegateToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "request" | "panelUrl">;
  environment: DelegateEnvironment;
  /** 新建了会话之后，环境变量要求时在系统浏览器里打开面板。“整个桥进程只打开一次”的状态由桥实例持有，不在这里。 */
  openPanelOnce: (url: string) => Promise<void>;
}

export function registerDelegateTool(server: McpServer, deps: DelegateToolDeps): void {
  server.registerTool(
    "delegate",
    {
      title: "Delegate a task to an external agent session",
      description:
        "Start a full external agent session (Cursor, Codex, Pi, Claude Code, OpenCode or DSH) on a task. Returns immediately with a session id and a live panel URL; the session keeps working in the background, even if you stop calling tools. " +
        "The session does NOT see this conversation, so write `task` as a complete, self-contained brief and pass concrete files/snippets via `context`. " +
        "The session runs with Full Access by default — it can read, write and run commands, and it never stops to ask anyone for approval. Use `access: \"read_only\"` for research or review that must not change anything. " +
        "After delegating, open the panel URL in your browser tool if you have one so the user can watch and steer, then use `wait` to collect results. " +
        "To build on what another session produced, put `{ kind: \"session\", sessionId }` in `context` instead of reading its output and retelling it: Ensemble copies that session's real final answer from its own record into the new session's prompt, verbatim " +
        "(`include` can add the files it changed and its last error). The referenced session must not be running; the reply says exactly what was taken. " +
        "Calling `delegate` again with the same task within two minutes does not start a second session: Ensemble answers with the session that already exists and says so.",
      inputSchema: {
        harness: z.enum(["cursor", "codex", "pi", "claude", "opencode", "dsh"]).optional().describe("Which harness runs the session. Call `harnesses` to see what is ready. Required unless you pass `profile`."),
        profile: z.string().min(1).max(100).optional().describe(
          "Name of a role the user defined in Ensemble's settings (`harnesses` lists them): a saved harness, model, effort and access. " +
            "Anything you also pass overrides the role's value; a different `harness` also drops the role's model and effort. Give `profile` or `harness`.",
        ),
        task: z.string().min(1).max(LIMITS.maxTaskChars).describe("The complete brief: goal, constraints, what to return."),
        title: z.string().max(120).optional().describe("Short label shown on the node in the panel."),
        cwd: z.string().max(2_000).optional().describe(
          "Absolute path of the project directory the session works in — pass the directory you are working in. If omitted, Ensemble uses the workspace folder the host reports, which not every host provides. " +
            "Some hosts (for example Cursor) run Ensemble as one process shared by all their windows, started from the user's home directory and reporting no workspace, so `cwd` is required there: without it the call is refused instead of starting a session in the home directory.",
        ),
        model: z.string().max(200).optional().describe(
          "Model id. Omit it to get the harness's default model: the one the user chose as default in Ensemble's settings if they chose one, otherwise the harness's own default (the first allowed model when the user does not allow that one). " +
            "`harnesses` shows which model that is (marked *) and lists the others you may name.",
        ),
        effort: z.string().max(40).optional().describe("Reasoning effort, if the model supports levels (for example low, medium, high). Must be one `harnesses` lists for that model — the user may limit them; omit it to get the default shown there."),
        access: z.enum(["read_only", "full"]).optional().describe("full (default): Full Access, no sandbox and no approval prompts. read_only: the session may only read and search."),
        context: z.array(contextItem).max(50).optional().describe(
          "Extra material passed along verbatim with the task: text, files, snippets, links, or `session` references that hand over another session's output without you retelling it " +
            `(at most ${LIMITS.contextSession.maxRefs} different sessions; a long result is cut at ${LIMITS.contextSession.maxResultChars} characters and the reply says so).`,
        ),
        // 个数上限就是服务实际会接受的 LIMITS.maxParents：主模型看到的 JSON schema（maxItems）与实际限制一致。
        // 超过时 MCP SDK 在调到这里之前就按 schema 拒绝（工具错误，说明 follows 最多几项）；delegate-request.ts 里带建议的那句超限说明在不经 schema 的路径上仍然保留。
        follows: z.union([z.string().min(1).max(100), z.array(z.string().min(1).max(100)).min(1).max(LIMITS.maxParents)]).optional().describe(
          "Id (ses_…) of an existing session this work follows up on — for example fixing what a review session found, or continuing from a research session's result. The panel draws the new session after that one. " +
            `Pass several ids (an array, at most ${LIMITS.maxParents}) when the work depends on the results of all of them — a convergence, for example one acceptance or fix pass over two parallel implementations; the panel then draws a line from each. ` +
            "Do not list sessions just to draw lines: only ones this work really builds on. The first id is the primary one the panel nests the session under. " +
            "It does not change who started this delegation, who is told about the user's interventions, or what `status` and `wait` list as yours. Chains of follow-ups count toward the nesting limit (the longest chain counts). Omit it when the work is independent.",
        ),
        allowDuplicate: z.boolean().optional().describe(
          "Only for starting a second session that is identical to one created in the last two minutes on purpose, for example several parallel workers on the same brief. " +
            "Leave it out otherwise: an identical delegation in that window is treated as an accidental repeat and answered with the existing session instead of a new one.",
        ),
        conversationId: conversationIdField,
      },
      // 这个工具本身只和本机的 Ensemble 服务通信；会话里的工作由被委派的 Agent 自己承担。
      annotations: { title: "Delegate to a session", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    // 解析后的参数直接交给 runDelegate：它声明的 DelegateArgs 与上面的 schema 对不上就是编译错误。
    async (args, extra) => deps.guard("delegate", extra, args, (call) => runDelegate(args, call, deps)),
  );
}

async function runDelegate(args: DelegateArgs, call: Call, deps: DelegateToolDeps): Promise<Output> {
  let prepared = await prepareDelegateRequest(args, call.origin, deps.environment);
  const response = await deps.client
    .request<DelegateResponse>("POST", "/api/sessions", {
      body: prepared.body,
      timeoutMs: 45_000,
      signal: call.signal,
      // 请求体是按构造它时连着的那个服务的能力写的。发送时令牌被拒、连接被拒绝，客户端重新发现之后连上的可能是另一个版本（比如更老的）：
      // 老服务会把不认识的 `profile` 静默丢掉，角色里的只读就变成了完全访问。所以重新发现之后功能变了，就按新服务把整个请求重新构造一遍——
      // 沿用上面全部的拒绝与降级规则（老服务遇到 `profile` 照样拒绝，而不是丢掉它）；回执也跟着换成这一份，说的与实际发出的是同一回事。
      rebuildBody: async () => {
        prepared = await prepareDelegateRequest(args, call.origin, deps.environment);
        return prepared.body;
      },
    })
    .catch((error: unknown) => {
      throw markFollowsFailure(prepared.parents, error);
    });
  const panelUrl = await deps.client.panelUrl(response.sessionId);
  // 服务端命中重复委派时没有新建任何东西，也就不自动打开浏览器；回执走另一份文字（见 renderDelegateOutput）。
  if (!response.duplicate) await deps.openPanelOnce(panelUrl);
  return renderDelegateOutput(prepared, response, panelUrl);
}
