import { errorMessage } from "@shared/format";
import { ServiceError } from "./client";
import { BridgeInputError } from "./tool-call";

/** 把服务返回的业务错误翻译成对主模型有用的下一步提示。 */
export function explainError(error: unknown): string {
  if (error instanceof BridgeInputError) return error.message;
  if (error instanceof ServiceError) {
    const setup = error.details?.["setup"] as { command?: string; message?: string } | undefined;
    switch (error.code) {
      case "harness_needs_setup":
        return `${error.message}${setup?.command ? ` The user can fix this by running: ${setup.command}.` : ""} Tell the user; retrying will not help until they have set it up.`;
      case "harness_unavailable":
        return `${error.message} Call \`harnesses\` to see which harnesses can be used right now.`;
      case "access_unsupported":
        return `${error.message} Choose an access level that harness supports.`;
      case "model_settings_unavailable":
        return `${error.message} Tell the user; retrying will not help until the settings have been repaired.`;
      case "model_not_allowed":
        // 默认模型不明、或名字无从核对时，省略 model 并不是出路：必须点名目录里确实报告的模型。
        return error.details?.["reason"] === "model_unverified"
          ? `${error.message} Pass \`model\` as one of the known models, or tell the user if none is known; do not try to work around the restriction.`
          : `${error.message} Pick one of the allowed models (or omit \`model\`), or tell the user if none is allowed; do not try to work around the restriction.`;
      case "effort_not_allowed":
        return `${error.message} Pick one of the allowed efforts (or omit \`effort\`), or tell the user if none is allowed; do not try to work around the restriction.`;
      case "profile_not_found": {
        // 服务端的消息已经列出用户定义过的角色名；有角色可选时点明两条出路。
        const available = error.details?.["available"];
        return Array.isArray(available) && available.length > 0 ? `${error.message} Use one of those names as \`profile\`, or pass \`harness\` instead.` : error.message;
      }
      case "profile_unusable":
        // 服务端的消息已经写明角色名、原因与出路（用户去设置里改、显式传参数覆盖、或不传 profile），不再叠加别的建议。
        return error.message;
      case "depth_exceeded": {
        // `via: "follows"` 由 delegate 在显式传了 follows 时加上（delegate-request.ts 的 markFollowsFailure）：这条链上的会话已经太深。
        if (error.details?.["via"] !== "follows") return `${error.message} Do the work yourself or hand it back instead of delegating further.`;
        // 汇聚时服务端点名了是哪一个上级让链过长（层数取最长链）：把它指给主模型，免得整组 follows 都被怀疑。
        const deepest = error.details?.["deepestParentId"];
        return typeof deepest === "string"
          ? `${error.message} Session ${deepest}, one of the sessions passed as \`follows\`, sits at the end of the longest chain of follow-ups and decides this depth. Follow an earlier session in that chain instead of it, drop it from \`follows\`, or omit \`follows\` to start a standalone session.`
          : `${error.message} The session passed as \`follows\` sits at the end of a long chain of follow-ups. Follow an earlier session in that chain instead, or omit \`follows\` to start a standalone session.`;
      }
      case "not_found":
        // 服务对没有处理器的请求也回 not_found，消息是固定前缀 “No route for ”（http/server.ts 路由表末尾的兜底；别处的 not_found 写的都是具体哪样东西不存在：
        // 会话、提问、角色、执行端、目录）。那不是编号写错，而是服务比这个插件旧、没有这个端点：核对会话编号没有用，要用户把服务重启到与插件相同的版本。
        if (error.message.startsWith("No route for ")) {
          return `${error.message} The running Ensemble service is probably older than this plugin and has no such endpoint. Tell the user; retrying will not help until it has been restarted onto the current version.`;
        }
        // 引用的会话不存在（`context` 里的 session 条目，服务端在 details.via 里标明）：出路是改正或去掉那一项。
        return error.details?.["via"] === "context"
          ? `${error.message} Call \`status\` with scope "all" to list valid session ids, then correct that \`context\` item or remove it.`
          : `${error.message} Call \`status\` to list valid session ids.`;
      case "context_session_active": {
        // 服务端的消息已经点名了还在进行的会话与阶段；出路是等它们结束再派，而不是立刻重试。
        const sessions = error.details?.["sessions"];
        const ids = Array.isArray(sessions)
          ? sessions.map((entry: { sessionId?: unknown }) => entry.sessionId).filter((id): id is string => typeof id === "string")
          : [];
        return `${error.message} Call \`wait\`${ids.length > 0 ? ` with \`sessionIds\` ${JSON.stringify(ids)}` : ""} until ${ids.length === 1 ? "it has" : "they have"} finished, then call \`delegate\` again with the same \`context\`.`;
      }
      case "context_too_large":
        // 服务端的消息已经写明各部分的大小和怎么改小。
        return error.message;
      case "question_unsupported":
        return `${error.message} The session cannot receive an answer from here; tell the user — they can see the question in the panel.`;
      default:
        return `${error.message} [${error.code}]`;
    }
  }
  if (error instanceof Error && error.name === "AbortError") return "The call was cancelled.";
  const message = errorMessage(error);
  if (/did not become ready|Cannot determine the Ensemble entry/.test(message)) return `Could not start the Ensemble service. ${message}`;
  return `Ensemble bridge error: ${message}`;
}
