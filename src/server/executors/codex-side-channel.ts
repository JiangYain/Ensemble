import type { AccessLevel } from "@shared/types";
import { unwrapShellCommand } from "./codex-items";
import { isSecretEntry } from "./codex-questions";
import type { CodexRpc, RpcId } from "./codex-rpc";
import { arr, asRecord, num, oneLine, str, type Json } from "./common";
import { redact } from "./redact";

/**
 * 回合与条目之外的“旁路”消息：只需要变成诊断条目的通知，以及 Codex 发给我们的请求（授权、提问、征询）。
 * 都与会话的运行状态无关，所以放在会话之外，可以单独验证。
 */

export type DiagnosticLevel = "info" | "warn" | "error";

export interface Notice {
  level: DiagnosticLevel;
  code: string;
  message: string;
}

/** 摘要与详情拼成一句话。 */
function summaryLine(params: Json): string {
  return oneLine([str(params["summary"]), str(params["details"])].filter(Boolean).join(" — "), 400);
}

/**
 * 只需要变成一条诊断的通知；不认识（或不值得记录）的返回 undefined。
 * `reportedMcpFailures` 用来去重：Codex 会重复上报同一个失败，每个服务器只记一次。
 */
export function noticeOf(method: string, params: Json, reportedMcpFailures: Set<string>): Notice | undefined {
  switch (method) {
    case "warning": {
      const message = str(params["message"]);
      if (!message) return undefined;
      // 用户自己 Codex 配置里的“开启了试验功能”提醒每次都会出现，降级为普通信息。
      const level = /under-development features enabled/i.test(message) ? "info" : "warn";
      return { level, code: "codex.warning", message: oneLine(message, 400) };
    }
    case "configWarning":
      return { level: "warn", code: "codex.config_warning", message: summaryLine(params) };
    case "deprecationNotice":
      return { level: "info", code: "codex.deprecation", message: summaryLine(params) };
    case "guardianWarning":
      return { level: "warn", code: "codex.guardian_warning", message: oneLine(str(params["message"]) ?? "", 400) };
    case "thread/compacted":
      return { level: "info", code: "codex.compacted", message: "Codex compacted the conversation context to stay within the model's window." };
    case "model/rerouted": {
      const from = str(params["fromModel"]);
      const to = str(params["toModel"]);
      return {
        level: "warn",
        code: "codex.model_rerouted",
        message: `Codex rerouted the request from "${from ?? "?"}" to "${to ?? "?"}" (${str(params["reason"]) ?? "unspecified reason"}).`,
      };
    }
    case "windows/worldWritableWarning": {
      const samples = (arr(params["samplePaths"]) ?? []).map(String).slice(0, 3).join(", ");
      const extra = num(params["extraCount"]) ?? 0;
      return {
        level: "warn",
        code: "codex.world_writable",
        message: `Codex's Windows sandbox cannot fully protect world-writable directories${samples ? ` (e.g. ${samples}${extra > 0 ? `, +${extra} more` : ""})` : ""}; writes there may not be blocked.`,
      };
    }
    case "mcpServer/startupStatus/updated": {
      if (str(params["status"]) !== "failed") return undefined;
      const name = str(params["name"]) ?? "?";
      if (reportedMcpFailures.has(name)) return undefined;
      reportedMcpFailures.add(name);
      // 原文是“MCP client for `x` failed to start: MCP startup failed: …”，与我们的前缀重复。
      const detail = str(params["error"])?.replace(/^MCP client for `[^`]*` failed to start:\s*/i, "");
      return { level: "info", code: "codex.mcp_failed", message: `MCP server "${name}" failed to start${detail ? `: ${oneLine(detail, 200)}` : "."}` };
    }
    default:
      return undefined;
  }
}

// ───────────────────────── 服务端请求 ─────────────────────────

export interface ServerRequestContext {
  rpc: Pick<CodexRpc, "respond" | "respondError">;
  access: AccessLevel;
  diagnostic(level: DiagnosticLevel, code: string, message: string): void;
  /** 某个工具调用正在显示的标题，用来说明“批准的是什么”。 */
  titleOf(itemId: string): string | undefined;
  /**
   * 业务提问的转交（见 codex-questions.ts）。没有它（或它没有接手）时，提问按原来的办法处理：告诉 Codex 无法中继。
   * 它只管 `item/tool/requestUserInput`；授权类请求从不经过它。
   */
  questions?: { relay(id: RpcId, params: Json): boolean };
}

/**
 * 授权请求不会停下来等人：每个都当场应答，并在时间线上留下一条诊断。
 * 线程以 approvalPolicy=never 启动，Codex 理应不再发出授权请求；万一仍然收到（企业策略强制、
 * 个别内置功能等）：Full Access 会话一律放行，只读会话一律拒绝——绝不把它变成“等待授权”，也绝不进入提问的流程。
 * 提问（`item/tool/requestUserInput`）是另一回事：它是子会话遇到需求歧义、向发起方要一个答案，转给发起方（codex-questions.ts）；
 * 转不了的（没有接入、涉及密钥、没有谁在等）如实告知 Codex 走不通。MCP 征询仍然没有人可以回答，同样告知走不通。
 */
export function answerServerRequest(ctx: ServerRequestContext, id: RpcId, method: string, params: Json): void {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
      return answerApproval(ctx, id, method, params);
    case "item/tool/requestUserInput": {
      // 接手了就是转给发起方回答（或因为涉及密钥当场拒绝），回应由 codex-questions.ts 负责。
      if (ctx.questions?.relay(id, params)) return;
      // 以错误回应，而不是回答“空”：模型会知道这条路走不通，转而做合理假设继续，而不是误以为用户没有意见。
      ctx.rpc.respondError(id, -32000, "Ensemble cannot relay questions to a person. Make a reasonable assumption, state it in your answer, and continue.");
      ctx.diagnostic("warn", "codex.question_unanswered", `Codex asked a question that Ensemble cannot relay: ${describeUnrelayed(params)}`);
      return;
    }
    case "mcpServer/elicitation/request": {
      ctx.rpc.respond(id, { action: "cancel", content: null, _meta: null });
      ctx.diagnostic(
        "warn",
        "codex.elicitation_cancelled",
        `MCP server "${str(params["serverName"]) ?? "?"}" asked for input ("${oneLine(str(params["message"]) ?? "", 160)}"). Ensemble cannot answer, so it was cancelled.`,
      );
      return;
    }
    default:
      ctx.rpc.respondError(id, -32601, `Ensemble does not handle "${method}".`);
      ctx.diagnostic("info", "codex.unsupported_request", `Codex sent a request Ensemble does not handle ("${method}"); it was rejected.`);
  }
}

function answerApproval(ctx: ServerRequestContext, id: RpcId, method: string, params: Json): void {
  const allow = ctx.access === "full";
  const subject = describeApproval(ctx, method, params);
  let sent: boolean;
  if (method === "item/permissions/requestApproval") {
    const requested = asRecord(params["permissions"]) ?? {};
    const granted: Json = {};
    if (allow) {
      if (requested["network"]) granted["network"] = requested["network"];
      if (requested["fileSystem"]) granted["fileSystem"] = requested["fileSystem"];
    }
    sent = ctx.rpc.respond(id, { permissions: granted, scope: "turn" });
  } else {
    sent = ctx.rpc.respond(id, { decision: allow ? "accept" : "decline" });
  }
  if (!sent) return;
  ctx.diagnostic(
    allow ? "info" : "warn",
    allow ? "codex.approval_granted" : "codex.approval_declined",
    allow
      ? `Codex asked for approval ("${subject}"). Delegated sessions run with Full Access, so it was granted automatically.`
      : `Codex asked for approval ("${subject}"). This session is read-only, so it was declined automatically.`,
  );
}

function describeApproval(ctx: ServerRequestContext, method: string, params: Json): string {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = unwrapShellCommand(str(params["command"]) ?? "");
      return oneLine(str(params["kind"]) === "writeStdin" ? `stdin → ${command || "process"}` : command || "command", 140);
    }
    case "item/fileChange/requestApproval": {
      const itemId = str(params["itemId"]);
      const known = itemId ? ctx.titleOf(itemId) : undefined;
      return oneLine(known || str(params["reason"]) || "file change", 140);
    }
    default:
      return oneLine(str(params["reason"]) || "additional permissions", 140);
  }
}

/**
 * 没能转交的提问，诊断里怎么写它。走到这里的情形有：没有接入转交（`codex.ts` 总会接上，这一种出现在测试或将来的调用方）；
 * 转交没有接手（没有进行中的运行、isBlocking=false，条数、长度超出上限、选项标签经整理后与原文对不上，
 * 或请求里没有一条它读得出的条目——它只认带 `id` 与问题正文的条目）。
 * 这里不借用转交的解析结果（没接转交时根本没有，转交读不出的条目也不在里面），直接读原始请求。
 * - 机密类条目（`isSecretEntry`，与 codex-questions.ts 判断整个请求时共用同一个谓词）一律不引用任何文字：问题、标题、选项都是模型写的，
 *   可能就是要问的那个机密，也可能带着 `redact` 认不出的内容（它只认得出少数密钥形状）。只陈述“有几个机密类提问”这个事实。
 *   接上转交时这一支到不了：转交在解析条目之前就把含机密条目的整个请求拒绝了（诊断码 `codex.question_secret`），所以它是纵深防御，
 *   留给没有接转交的调用方（测试、将来的代码）：它们走到这里时，机密条目的文字照样不会写进诊断。
 * - 其余条目只引用问题原文：先脱敏、再压成一行并截断到 300 字。次序不能反，否则密钥被截在半截，就认不出来了。
 */
function describeUnrelayed(params: Json): string {
  const texts: string[] = [];
  let secrets = 0;
  for (const raw of arr(params["questions"]) ?? []) {
    if (isSecretEntry(raw)) {
      secrets += 1;
      continue;
    }
    const text = str(asRecord(raw)?.["question"]);
    if (text) texts.push(redact(text));
  }
  const secretNote = secrets > 0 ? `${secrets} ${secrets === 1 ? "question" : "questions"} asked for a secret value (text not recorded)` : "";
  return [oneLine(texts.join(" / "), 300), secretNote].filter(Boolean).join(" / ") || "(no text)";
}
