import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Origin } from "@shared/types";
import { SESSION_ID_MAX_CHARS } from "./origin";

/**
 * 工具处理器共用的几样东西：一次调用的上下文、处理器的返回值、“参数本身不够”的错误，以及每个工具都带的 `conversationId`。
 * 单独放一个文件，是为了让拆到别处的工具（delegate-tool.ts）只依赖这些，而不是反过来依赖整个桥类。
 */

/** MCP SDK 交给工具处理器的第二个参数（请求上下文）。 */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** 一次工具调用的上下文：这次调用来自谁，以及随这次 MCP 请求一起被取消的信号。 */
export interface Call {
  origin: Origin;
  signal: AbortSignal;
}

/** 工具处理器的结果：`guard` 在它后面拼上用户干预的通知与 footer，再变成 MCP 回复。 */
export interface Output {
  text: string;
  data?: Record<string, unknown>;
  /** 附在整条输出最后（排在用户干预通知之后）的一行提示。 */
  footer?: string;
}

/** 调用参数本身不足以安全地继续（桥在请求服务之前就拒绝），消息直接写给主模型看。 */
export class BridgeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeInputError";
  }
}

/** 桥的统一外壳（guard.ts 的 `createGuard`）：认出调用者、跑处理器、把业务错误翻译成对主模型有用的话。 */
export type Guard = (
  name: string,
  extra: ToolExtra,
  args: { conversationId?: string | undefined },
  run: (call: Call) => Promise<Output>,
) => Promise<CallToolResult>;

/**
 * 每个工具都带的可选参数。宿主不告诉桥“这次调用来自哪个对话”时（Cursor IDE 里所有对话共用一个桥进程），只有 Agent 自己知道；
 * 它自报的标识让来源按对话区分。宿主给了标识就以宿主的为准，这个参数被忽略。校验标准与 `detectOrigin` 一致（见 origin.ts 的 validId）。
 */
export const conversationIdField = z
  .string()
  .min(1)
  .max(SESSION_ID_MAX_CHARS)
  .regex(/^\S+$/, "conversationId must not contain whitespace")
  .optional()
  .describe(
    "Optional. The id of THIS conversation — for hosts that do not tell Ensemble which conversation a call comes from (in Cursor IDE: the conversation/agent UUID shown in your context). " +
      "Pass the same id on every Ensemble call from this conversation: it keeps this conversation's sessions, `status`/`wait` results and the user's interventions apart from other conversations that share the same plugin process. " +
      "Copy it exactly; never invent or guess one — leave it out if you do not have it (calls without it are grouped per plugin process, as before). Ignored when the host already identifies the conversation.",
  );

/** 桥的诊断日志（`BridgeOptions.log`）：没有提供时是空操作；桥进程绝不能写 stdout。认出调用者（call-context.ts）与统一外壳（guard.ts）都要用它。 */
export type BridgeLog = (message: string, fields?: Record<string, unknown>) => void;
