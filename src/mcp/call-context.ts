import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clip, collapseWhitespace, errorMessage, isoNow } from "@shared/format";
import type { Origin, OriginHost } from "@shared/types";
import type { EnsemblePaths } from "../server/paths";
import { describeClues, detectOrigin, type StickyClues } from "./origin";
import type { BridgeLog, Call, ToolExtra } from "./tool-call";
import { describeRootsFailure, hostRootsIdentifyConversation } from "./workspace";

export interface CallContextOptions {
  /** 与 MCP 客户端的连接（`McpServer.server`）：只用来问客户端的名字与版本、声明的能力与 roots。 */
  server: Pick<McpServer["server"], "getClientCapabilities" | "getClientVersion" | "listRoots">;
  /** 桥进程的环境变量：宿主有时把会话标识放在里面（见 origin.ts 的 ENV_HINTS）。 */
  env: NodeJS.ProcessEnv;
  /** 只用到排查日志的位置，而且写第一条记录时才读。 */
  paths: Pick<EnsemblePaths, "originDebugLog">;
  log: BridgeLog;
}

/**
 * 认出“这次调用来自谁、宿主报告了哪个工作区”，以及为此要跨调用记住的几样东西。它们都是**每个桥实例各一份**的状态：
 * - `bridgeId`：宿主没有给出任何会话标识时，来源 key 退到“一个桥进程 = 一个发起端”，靠它区分；
 * - `sticky` / `sharedByMultipleSessions`：宿主有时只在部分请求里带标识，后面没带的调用可以沿用——但桥被多个会话共用时不能（见 `forCall`）；
 * - `roots`：宿主的 roots/list 只问一次；
 * - `debugSeen` / `debugCount`：排查日志只在线索变化时写，总条数有上限。
 * 这些状态不能放在模块级：同一个进程里可以同时有多个桥（测试里就是），它们互不相干。
 */
export class CallContext {
  private readonly bridgeId = randomBytes(4).toString("hex");
  private sticky: StickyClues = {};
  private sharedByMultipleSessions = false;
  private roots: string[] | null | undefined;
  private readonly debugSeen = new Set<string>();
  private debugCount = 0;

  constructor(private readonly options: CallContextOptions) {}

  /**
   * 宿主通过 MCP roots 报告的工作区（第一项）。只在“这些 roots 认得出调用者这段对话”的宿主上采信：
   * Cursor 的桥被所有窗口共用，roots/list 回的是所有窗口目录的并集（见 hostRootsIdentifyConversation），读得到也不用。
   */
  async workspace(host: OriginHost): Promise<{ path: string; source: "mcp-roots" } | undefined> {
    if (this.roots === undefined) {
      this.roots = null;
      try {
        if (this.options.server.getClientCapabilities()?.roots) {
          const result = await Promise.race([
            this.options.server.listRoots(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("roots/list timed out")), 2_000).unref()),
          ]);
          const paths = result.roots.flatMap((root) => {
            try {
              return root.uri.startsWith("file:") ? [fileURLToPath(root.uri)] : [];
            } catch {
              return [];
            }
          });
          if (paths.length > 0) {
            this.roots = paths;
            // 读得到却不用：留一条记录（只记条数），日后才知道宿主改了 roots 的存法。
            if (!hostRootsIdentifyConversation(host)) this.options.log("host workspace roots are readable but not used", { host, entries: paths.length });
          }
        }
      } catch (error) {
        // 只记条数与失败原因的种类，不记路径内容；完整的校验错误很长（每个条目一大段），截短。
        this.options.log("roots unavailable", { error: clip(collapseWhitespace(errorMessage(error)), 300), ...describeRootsFailure(error) });
      }
    }
    const first = hostRootsIdentifyConversation(host) ? this.roots?.[0] : undefined;
    return first ? { path: first, source: "mcp-roots" } : undefined;
  }

  /** 这次工具调用的上下文：来自谁（来源）与随请求一起被取消的信号；顺带更新沿用用的线索，并写排查日志。 */
  forCall(name: string, extra: ToolExtra, declaredConversationId: string | undefined): Call {
    const clientInfo = this.options.server.getClientVersion();
    const meta = extra._meta as Record<string, unknown> | undefined;
    const client = clientInfo ? { name: clientInfo.name, version: clientInfo.version } : undefined;
    // 来源的工作目录不在这里定：只有委派才会把来源交给服务，由 delegate 在知道宿主对这段对话的记录、宿主的 roots 与显式传入的 cwd 之后补上。
    const { origin, clues } = detectOrigin({
      clientInfo: client,
      meta,
      env: this.options.env,
      bridgeId: this.bridgeId,
      sticky: this.sharedByMultipleSessions ? undefined : this.sticky,
      declaredConversationId,
    });
    // clues 只含宿主真实给出的线索：Agent 自报的 conversationId 不会让这里误判成“多个会话共用”，也不会被记进 sticky——
    // 桥被多个对话共用时，上一次见到的标识属于别人，每次调用的自报各自决定。
    if (this.sticky.sessionRef && clues.sessionRef && this.sticky.sessionRef.id !== clues.sessionRef.id) {
      this.sharedByMultipleSessions = true;
    }
    // A call without an ID can inherit it only while the bridge has served a single known session.
    if (!this.sharedByMultipleSessions) this.sticky = { ...this.sticky, ...clues };
    this.recordClues(name, { clientInfo: client, meta, env: this.options.env, declaredConversationId }, origin);
    return { origin, signal: extra.signal };
  }

  /** 把宿主给出的线索写到排查日志（只在线索变化时写，且数量有上限）。 */
  private recordClues(tool: string, input: Parameters<typeof describeClues>[0], origin: Origin): void {
    if (this.debugCount >= 20) return;
    const clues = describeClues(input);
    const signature = JSON.stringify([clues, origin.key]);
    if (this.debugSeen.has(signature)) return;
    this.debugSeen.add(signature);
    this.debugCount += 1;
    try {
      const file = this.options.paths.originDebugLog;
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: isoNow(), tool, bridge: this.bridgeId, clues, detected: { key: origin.key, host: origin.host, evidence: origin.evidence } })}\n`);
    } catch {
      // 排查日志写失败不影响调用。
    }
  }
}
