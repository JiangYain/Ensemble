/**
 * 仅供测试使用：MCP 桥套件（bridge*.test.ts）共用的夹具。
 *
 * 桥连的是真实的本地服务（临时状态目录、模拟执行端）；MCP 客户端经 SDK 的内存传输连着桥——只有“客户端 ↔ 桥”这一段不走 stdio，
 * “桥 ↔ 服务”仍是真实的本地 HTTP。下面几件事各自独立，各套件按需要组合：
 * - `startTestService`：起服务（与 HTTP 套件用的是同一个 `boot`）；
 * - `connectTestBridge`：给一个服务接一个桥与客户端，同一个服务可以接很多个（例如被委派的会话自己又调用了 Ensemble）；
 * - `simulateOlderService`：把服务写下的 service.json 改成老服务的样子（只是模拟，服务本身还是新的）；
 * - `closeTestBridges`：测试文件里写一次 `afterEach(closeTestBridges)`，MCP 客户端先于服务关闭。
 *
 * 执行端、环境变量、宿主报告的 roots、要不要记请求这些各套件自己的取舍都从参数进来，这里不替它们做主。
 * 需要换掉整个 `EnsembleBridge`（例如配一个桩服务客户端）的套件直接用 `connectBridge`。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SessionSummary } from "@shared/types";
import { FixtureExecutor } from "../server/executors/fixture";
import type { Executor } from "../server/executors/types";
import type { RunningService, StartServiceOptions } from "../server/service";
import { boot, closeServices, type BootOptions } from "../server/service.fixtures";
import { EnsembleBridge, type BridgeOptions } from "./bridge";
import { ServiceClient } from "./client";

export { tempHome } from "../server/service.fixtures";

const clients: Client[] = [];

/** 先关 MCP 客户端，再关服务（经 `startTestService` / `boot` 起的都在内）。 */
export async function closeTestBridges(): Promise<void> {
  while (clients.length > 0) await clients.pop()!.close();
  await closeServices();
}

/** 工具给出的结构化结果。形状由各工具决定，测试按需要的字段缩窄（`as`，或 `call` 的类型参数），这里不假装知道。 */
export type ToolData = Record<string, unknown>;

export interface ToolReply<Data extends object = ToolData> {
  /** 全部文本块用换行接起来。 */
  text: string;
  isError: boolean;
  /** 工具没有给结构化结果时是 undefined。 */
  data: Data | undefined;
}

export interface McpClientOptions {
  /** 客户端自报的名字：桥据此认出宿主（例如 `cursor-vscode` → Cursor）。 */
  clientName?: string;
  /** 宿主按 `file://` 汇报的工作区（MCP roots）。`roots` 与 `rootUris` 都不传，就是客户端不声明 roots 能力。 */
  roots?: readonly string[];
  /** 原样当作 roots 的 uri 回给桥（不转成 `file://`）：Cursor 回的就是普通路径，MCP SDK 的校验会把整份应答挡掉。优先于 `roots`。 */
  rootUris?: readonly string[];
}

export interface McpSession {
  client: Client;
  call<Data extends object = ToolData>(name: string, args?: Record<string, unknown>, meta?: Record<string, unknown>): Promise<ToolReply<Data>>;
}

/** 把一个桥接上 MCP 客户端（内存传输）。客户端登记在案，由 `closeTestBridges` 关闭。 */
export async function connectBridge(bridge: EnsembleBridge, options: McpClientOptions = {}): Promise<McpSession> {
  const rootUris = options.rootUris ?? options.roots?.map((path) => `file:///${path.replace(/\\/g, "/")}`);
  const client = new Client({ name: options.clientName ?? "test-client", version: "1.0.0" }, rootUris ? { capabilities: { roots: {} } } : {});
  if (rootUris) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: rootUris.map((uri) => ({ uri, name: "root" })) }));
  }
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async call<Data extends object = ToolData>(name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<ToolReply<Data>> {
      const result = (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
        structuredContent?: ToolData;
      };
      return {
        text: result.content.map((part) => part.text).join("\n"),
        isError: result.isError === true,
        data: result.structuredContent as unknown as Data | undefined,
      };
    },
  };
}

export interface TestBridgeOptions extends McpClientOptions {
  /** 桥进程的环境变量（桥只读它，不碰真实的 `process.env`）。缺省是空。 */
  env?: NodeJS.ProcessEnv;
  /** 桥进程的启动目录；缺省是系统临时目录。 */
  cwd?: string;
  /** 把“用户主目录”换成测试目录（真的主目录里不能乱写）。 */
  homeDirectory?: string;
  /** 把 Cursor 的 state.vscdb 换成测试库。 */
  cursorDb?: string;
  /** 收桥的诊断日志。 */
  log?: BridgeOptions["log"];
}

export interface TestBridge extends McpSession {
  /** 桥要求在系统浏览器里打开的地址（`openExternal` 收到的）：只记下，不真的打开。 */
  opened: string[];
  /** 桥发给服务的每个请求的完整地址，按发出的顺序（只是旁观，请求照常发出）。 */
  requested: string[];
}

/**
 * 给一个已经在运行的服务接一个桥与 MCP 客户端。桥的服务客户端不会去拉起服务：服务必须已经在运行。
 * 它读取并缓存 service.json 是在第一次请求时，所以要在此之前模拟老服务（`simulateOlderService`）；之后再接的桥读到的是改过的文件。
 */
export async function connectTestBridge(service: RunningService, options: TestBridgeOptions = {}): Promise<TestBridge> {
  const opened: string[] = [];
  const requested: string[] = [];
  const bridge = new EnsembleBridge({
    paths: service.paths,
    version: "test",
    env: options.env ?? {},
    cwd: options.cwd ?? tmpdir(),
    ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
    ...(options.cursorDb ? { cursorDb: options.cursorDb } : {}),
    ...(options.log ? { log: options.log } : {}),
    client: new ServiceClient({
      paths: service.paths,
      ensure: async () => {
        throw new Error("the service should already be running");
      },
      fetchImpl: ((input, init) => {
        requested.push(String(input));
        return fetch(input, init);
      }) satisfies typeof fetch,
    }),
    openExternal: (url) => {
      opened.push(url);
    },
  });
  const session = await connectBridge(bridge, options);
  return { ...session, opened, requested };
}

/** 起一个桥套件用的真服务：与 HTTP 套件同一个 `boot`，只是临时目录的名字前缀不同。 */
export function startTestService(options: BootOptions = {}): Promise<RunningService> {
  return boot({ homePrefix: "ensemble-mcp-", ...options });
}

/**
 * 模拟老服务：把服务写下的 service.json 里的 `features` 去掉（老服务不写这个字段），返回去掉之前它公布的功能清单，
 * 供套件断言“新服务确实公布了这项功能”。服务本身还是新的，所以这只是模拟。
 * 必须在要测的那个桥发出第一个请求之前调用（桥在第一次请求时读取并缓存 service.json）。
 */
export function simulateOlderService(service: RunningService): readonly string[] | undefined {
  const file = JSON.parse(readFileSync(service.paths.serviceFile, "utf8")) as Record<string, unknown>;
  const advertised = file["features"] as readonly string[] | undefined;
  delete file["features"];
  writeFileSync(service.paths.serviceFile, JSON.stringify(file));
  return advertised;
}

/** 缺省的两个模拟执行端。`pi` 的显示名是固定的：harnesses 的文本输出里会出现它（bridge.test.ts 里有断言）。 */
export function simulatedExecutors(): Executor[] {
  return [new FixtureExecutor("pi", { speed: 0, displayName: "Pi · 模拟" }), new FixtureExecutor("cursor", { speed: 0 })];
}

export interface SetupBridgeOptions extends TestBridgeOptions {
  /** 服务上的执行端；缺省是 `simulatedExecutors()`。 */
  executors?: Executor[];
  /** “值得留意”的判定阈值与复查节奏（测试里缩短）。 */
  attention?: StartServiceOptions["attention"];
}

export interface BridgeHarness extends TestBridge {
  service: RunningService;
  /** 服务里现有的全部会话摘要（直接读 hub，不经桥）。 */
  sessions(): SessionSummary[];
}

/** 起服务并接一个桥与客户端：各桥测试（bridge.*.test.ts 等）的共同起点。 */
export async function setupBridge(options: SetupBridgeOptions = {}): Promise<BridgeHarness> {
  const { executors, attention, ...bridgeOptions } = options;
  const service = await startTestService({
    executors: executors ?? simulatedExecutors(),
    ...(attention ? { attention } : {}),
  });
  const bridge = await connectTestBridge(service, bridgeOptions);
  return { ...bridge, service, sessions: () => service.hub.allSummaries() };
}
