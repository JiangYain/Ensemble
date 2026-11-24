import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { EnsemblePaths } from "../server/paths";
import { CallContext } from "./call-context";
import { registerCancelTool } from "./cancel-tool";
import { ServiceClient } from "./client";
import { registerDelegateTool } from "./delegate-tool";
import { createGuard } from "./guard";
import { registerHarnessesTool } from "./harnesses-tool";
import { readHostRecord } from "./host-title";
import { INSTRUCTIONS } from "./instructions";
import { PanelOpener } from "./panel-opener";
import { registerPanelTool } from "./panel-tool";
import { registerReadTool } from "./read-tool";
import { registerSendTool } from "./send-tool";
import { fetchAllSessions } from "./session-view";
import { registerStatusTool } from "./status-tool";
import type { BridgeLog } from "./tool-call";
import { registerWaitTool } from "./wait-tool";

/**
 * MCP 桥的入口与接线：建 `McpServer`，把每个桥实例各一份的状态（识别调用者的 call-context.ts、自动打开面板的 panel-opener.ts）
 * 与统一外壳（guard.ts）接给八个工具；每个工具的 schema 与处理器在自己的 `<名字>-tool.ts` 里，再提供 stdio 入口。
 * `explainError` 的实现在 explain-error.ts，这里转出，原来的导入路径不变。
 */
export { explainError } from "./explain-error";

export interface BridgeOptions {
  paths: EnsemblePaths;
  version: string;
  env?: NodeJS.ProcessEnv;
  /**
   * 桥进程的启动目录。宿主没有报告工作区、委派也没有传 `cwd` 时，它是会话最后的退路；Pi 也靠它定位自己的会话文件。
   * 但它是插件安装目录、或用户主目录 / 磁盘根目录时（Cursor 就是从主目录拉起桥的）不会被当作退路：那只是插件被启动的地方，
   * 不是这段对话在做的项目，这时委派必须显式传 `cwd`。它也不会被当作“来源的工作目录”记录下来。
   */
  cwd?: string;
  /** 测试用：覆盖“用户主目录”（默认是当前用户的主目录），用来判断 `cwd` 是不是启动在主目录里。 */
  homeDirectory?: string;
  /** 测试用：覆盖 Cursor 的 state.vscdb 路径（读对话标题与对话所在的工作区）。 */
  cursorDb?: string;
  client?: ServiceClient;
  /** 在系统浏览器里打开地址（测试注入）。 */
  openExternal?: (url: string) => Promise<void> | void;
  /** 向 stderr 以外的诊断通道记录（默认空操作；桥进程绝不能写 stdout）。 */
  log?: BridgeLog;
}

export class EnsembleBridge {
  readonly server: McpServer;
  readonly client: ServiceClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly context: CallContext;
  private readonly panel: PanelOpener;

  constructor(private readonly options: BridgeOptions) {
    this.env = options.env ?? process.env;
    this.client = options.client ?? new ServiceClient({ paths: options.paths });
    this.server = new McpServer({ name: "ensemble", version: options.version }, { instructions: INSTRUCTIONS });
    this.context = new CallContext({ server: this.server.server, env: this.env, paths: options.paths, log: (message, fields) => this.log(message, fields) });
    this.panel = new PanelOpener({ env: this.env, openExternal: options.openExternal });
    this.registerTools();
  }

  private log(message: string, fields?: Record<string, unknown>): void {
    this.options.log?.(message, fields);
  }

  private registerTools(): void {
    const { server, client } = this;
    const guard = createGuard({
      callContext: (name, extra, declaredConversationId) => this.context.forCall(name, extra, declaredConversationId),
      client,
      log: (message, fields) => this.log(message, fields),
    });

    // 八个工具各有一个文件，桥只把统一外壳、服务客户端与宿主那几件事递过去。注册的先后就是 `tools/list` 里的先后。
    // delegate 的 schema、请求构造与回执在 delegate-tool.ts / delegate-request.ts / delegate-output.ts，其余七个在各自的 `<名字>-tool.ts`。
    registerDelegateTool(server, {
      guard,
      client,
      environment: {
        env: this.env,
        bridgeDirectory: this.options.cwd,
        homeDirectory: this.options.homeDirectory,
        sessions: () => fetchAllSessions(client),
        supports: (feature) => client.supports(feature),
        hostRoots: (host) => this.context.workspace(host),
        readHostRecord: (origin, workspace) =>
          readHostRecord(origin, {
            env: this.env,
            ...(workspace ? { workspace } : {}),
            ...(this.options.cursorDb ? { cursorDb: this.options.cursorDb } : {}),
          }),
      },
      openPanelOnce: (url) => this.panel.openPanelOnce(url),
    });
    registerStatusTool(server, { guard, client });
    registerWaitTool(server, { guard, client });
    registerReadTool(server, { guard, client });
    registerSendTool(server, { guard, client });
    registerCancelTool(server, { guard, client });
    registerPanelTool(server, { guard, client, openInSystemBrowser: (url) => this.panel.openInSystemBrowser(url) });
    registerHarnessesTool(server, { guard, client });
  }

  async connectStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
  }
}

/** 以 stdio 方式运行桥；stdout 只用于 MCP 协议。 */
export async function runBridge(options: BridgeOptions): Promise<void> {
  const bridge = new EnsembleBridge(options);
  await bridge.connectStdio();
  // 宿主关闭管道即退出。桥退出不会主动停止本地服务（服务能否活过宿主取决于宿主清理子进程的方式，见 discovery.ts）。
  process.stdin.on("close", () => process.exit(0));
}
