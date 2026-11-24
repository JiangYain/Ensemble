import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "@shared/format";
import type { CollectNoticesResponse } from "@shared/protocol";
import type { Notice } from "@shared/types";
import { ServiceError, type ServiceClient } from "./client";
import { explainError } from "./explain-error";
import { renderNotices } from "./format";
import type { BridgeLog, Call, Guard, ToolExtra } from "./tool-call";

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** 统一外壳要借的东西：怎样认出调用者（`CallContext.forCall`）、取用户干预通知用的服务客户端，以及诊断日志。 */
export interface GuardDeps {
  callContext: (name: string, extra: ToolExtra, declaredConversationId: string | undefined) => Call;
  client: Pick<ServiceClient, "request">;
  log: BridgeLog;
}

/**
 * 每个工具处理器外面的统一外壳：先认出调用者，再跑处理器，把用户在页面上对这个来源直接做过的干预（通知）拼进输出，
 * 出错时把业务错误翻译成对主模型有用的话（explain-error.ts）。步骤的先后与日志的措辞是行为的一部分，各工具共用，不要各写各的。
 */
export function createGuard({ callContext, client, log }: GuardDeps): Guard {
  async function collectNotices({ origin }: Call): Promise<Notice[]> {
    try {
      const result = await client.request<CollectNoticesResponse>("POST", "/api/notices/collect", {
        body: { originKey: origin.key }, timeoutMs: 5_000,
      });
      return result.notices;
    } catch (error) {
      log("collecting notices failed", { error: errorMessage(error) });
      return [];
    }
  }

  return async (name, extra, args, run) => {
    const call = callContext(name, extra, args.conversationId);
    try {
      const output = await run(call);
      const notices = await collectNotices(call);
      const text = [output.text, ...(notices.length > 0 ? [renderNotices(notices)] : []), ...(output.footer ? [output.footer] : [])].join("\n\n");
      const data = output.data || notices.length > 0 ? { ...output.data, ...(notices.length > 0 ? { notices } : {}) } : undefined;
      return { content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) };
    } catch (error) {
      log("tool failed", { tool: name, error: errorMessage(error) });
      // 服务可达时（收到的是业务错误），仍然把用户的干预带回去；服务不可达时不要再尝试拉起它。
      const notices = error instanceof ServiceError ? await collectNotices(call) : [];
      const text = explainError(error);
      return toolError(notices.length > 0 ? `${text}\n\n${renderNotices(notices)}` : text);
    }
  };
}
