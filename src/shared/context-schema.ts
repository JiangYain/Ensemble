import { z } from "zod";
import { HANDOFF_PARTS } from "./handoff";
import type { ContextItem } from "./types";

/**
 * 随任务带上的上下文条目：HTTP 的委派请求体（server/http/schemas.ts）与 MCP 的 `delegate` 工具入参（mcp/delegate-tool.ts）共用这一份，
 * 说明文字会出现在工具的 JSON Schema 里。放在 shared 而不是 server：桥不该为了一个 zod 形状去依赖 HTTP 层的校验文件。
 */
export const contextItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), title: z.string().max(200).optional(), text: z.string().min(1).max(100_000) }),
  z.object({ kind: z.literal("file"), path: z.string().min(1).max(2_000).describe("Absolute path to a file the session should read."), note: z.string().max(2_000).optional() }),
  z.object({
    kind: z.literal("snippet"),
    text: z.string().min(1).max(100_000),
    path: z.string().max(2_000).optional(),
    language: z.string().max(40).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal("url"), url: z.string().url().max(2_000), title: z.string().max(200).optional() }),
  // 第五种：按引用交接上游会话的产出（server/context-refs.ts）。请求里只有 sessionId / include / note；取样事实 `sample` 由服务端在派发时写入，
  // 这里不声明它，Zod 对象会把请求里夹带的 sample 丢掉，调用方伪造不了“当时交出去了什么”。
  // 老服务没有这一支：它的判别校验对 "session" 只会回 “Invalid discriminator value”，桥靠 features 里的 context-session-ref 判断，见 src/mcp/delegate-request.ts。
  z.object({
    kind: z.literal("session"),
    sessionId: z.string().min(1).max(100).describe("Id of an existing session whose output is handed over verbatim. It must not be starting, queued or running."),
    include: z.array(z.enum(HANDOFF_PARTS)).min(1).max(HANDOFF_PARTS.length).optional()
      .describe("Which parts to hand over: result (its final answer), files (the files it changed), error (its last failure). Omit for result only."),
    note: z.string().max(2_000).optional().describe("Why this is included; shown above the handed-over text."),
  }),
]) satisfies z.ZodType<ContextItem>;
