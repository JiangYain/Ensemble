import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, errorMessage, isoNow } from "@shared/format";
import type { AccessEnforcement, AccessLevel, Capabilities, HarnessInfo, ModelInfo } from "@shared/types";
import { asRecord, num, str } from "./common";
import { parseCatalog, toModelInfo, type DshCatalog } from "./dsh-events";
import {
  DSH_INSTALL_COMMAND,
  acpArgs,
  nodeSatisfies,
  probePatchYaml,
  readEnginesNode,
  resolveDshLaunch,
  versionArgs,
} from "./dsh-launch";
import { DshRpc } from "./dsh-rpc";
import { runCapture, spawnJsonl, type JsonlProcess } from "./process";

/**
 * live = 已在真实 dsh 上验证（dsh 0.2.2-rc.1 · Windows 11 · Node 22.22.2 · 2026-11-16）：
 * 真实的 dsh 进程 + 脚本化的假模型端点（没有 DeepSeek 凭据，真实的 DeepSeek 模型没有跑过）。
 * 换了 dsh 版本或操作系统后需要重新验证。
 */
export const DSH_CAPABILITIES: Capabilities = {
  // 运行中再发一次 session/prompt 会被拒绝（-32602 a prompt is already in flight），文字不会被注入。
  steer: { support: "no", mode: "none", verification: "live" },
  followUp: { support: "yes", mode: "after_run", verification: "live" },
  // session/cancel 能让这一轮几十毫秒内以 cancelled 结束、会话照常可用；dsh 留下的工具子进程由 Ensemble 清理（见 process-tree.ts；
  // 清理只在 Windows 上验证过，Linux 与 macOS 已实现、未在真实系统上验证）。
  cancel: { support: "yes", verification: "live" },
  resume: { support: "yes", verification: "live" },
  // 推理文本整块提交（不是逐字流），取决于模型是否给出推理内容。
  reasoning: { support: "partial", verification: "live" },
  // 没有独立的计划事件，只有 todo_write 工具带出的待办清单。
  plan: { support: "partial", verification: "live" },
  // 只有上下文占用（已用 / 窗口），没有输入、输出的 token 统计。
  usage: { support: "partial", verification: "live" },
  // 只能从 write / edit 工具得知文件变更；pwsh 里的改动看不到。
  fileEvents: { support: "partial", verification: "live" },
};

/** read_only：DSH_PERMISSION_MODE=read-only（写入工具被拒绝、shell 在系统沙箱里、提权请求被拒绝）；full：danger-full-access，没有沙箱也没有授权闸门。 */
export function dshAccess(verified: boolean, note?: string): Record<AccessLevel, AccessEnforcement | null> {
  return {
    read_only: verified
      ? {
          level: "enforced",
          mechanism: "DSH permission mode read-only: write tools are denied, shell commands run in an OS sandbox, escalation requests are rejected (verified on dsh 0.2.2-rc.1 · Windows 11)",
        }
      : { level: "none", mechanism: `DSH was asked for read-only, but enforcement is unconfirmed (${note ?? "DSH could not be probed"})` },
    full: { level: "none", mechanism: "DSH danger-full-access: no sandbox, no approval prompts" },
  };
}

/** 冷启动（例如电脑刚重启后）实测 28 秒，所以握手的时限要宽。 */
const VERSION_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 90_000;
const NEW_TIMEOUT_MS = 60_000;
const MODEL_TIMEOUT_MS = 15_000;
const MAX_PROBED_MODELS = 24;

class ProbeFailure extends Error {
  constructor(
    readonly code: "dsh_unsupported" | "dsh_probe_failed",
    message: string,
  ) {
    super(message);
  }
}

export interface DshProbeOptions {
  bin?: string | undefined;
  env: NodeJS.ProcessEnv;
  clientVersion: string;
}

function firstLine(text: string): string | undefined {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
}

/** 逐个切到每个模型，读出它自己的推理档位（目录只给当前模型的档位）。单个模型查不出来不影响其它。 */
async function readModels(rpc: DshRpc, sessionId: string, catalog: DshCatalog): Promise<ModelInfo[]> {
  const detail = new Map<string, { efforts: string[]; effort: string | undefined }>();
  if (catalog.current) detail.set(catalog.current, { efforts: catalog.efforts, effort: catalog.effort });
  for (const model of catalog.models.slice(0, MAX_PROBED_MODELS)) {
    if (detail.has(model.value)) continue;
    try {
      const switched = asRecord(await rpc.request("session/set_config_option", { sessionId, configId: "model", value: model.value }, MODEL_TIMEOUT_MS));
      const next = parseCatalog(switched?.["configOptions"]);
      detail.set(model.value, { efforts: next.efforts, effort: next.effort });
    } catch {
      detail.set(model.value, { efforts: [], effort: undefined });
    }
  }
  const empty = { efforts: [], effort: undefined };
  return catalog.models.map((model) => toModelInfo(model, detail.get(model.value) ?? empty, model.value === catalog.current));
}

/**
 * 探测 dsh：找到可执行文件 → `--version` → 起一个临时的 ACP 进程，`initialize` + `session/new` 读出模型目录。
 * 探测进程的会话存储与索引都被 `--patch` 重定向到临时目录，探测完整个目录删掉，不在用户的 DSH_HOME 里留下会话。
 * （唯一留在 DSH_HOME 里的是 dsh 自己首次使用 acp profile 时的一次性初始化，见 `docs/manual.zh-CN.md`。）
 * 无法判断用户有没有配好 DeepSeek 凭据（只能由 dsh 自己去读），所以缺凭据要等第一次运行以 auth_failed 失败才会知道。
 */
export async function probeDsh(options: DshProbeOptions): Promise<HarnessInfo> {
  const base = { id: "dsh" as const, displayName: "DSH", runtime: "native" as const, capabilities: DSH_CAPABILITIES, models: [] as ModelInfo[] };
  const launch = resolveDshLaunch({ bin: options.bin, env: options.env });
  if (!launch) {
    return {
      ...base,
      access: dshAccess(false, "DSH is not installed"),
      status: "unavailable",
      setup: {
        code: "dsh_not_found",
        message: "The DSH (DeepSeek Harness) CLI `dsh` was not found on PATH or in the npm global directory.",
        command: DSH_INSTALL_COMMAND,
      },
      checkedAt: isoNow(),
    };
  }

  const unavailable = (code: string, message: string, version?: string): HarnessInfo => ({
    ...base,
    access: dshAccess(false, "DSH could not be probed"),
    status: "unavailable",
    ...(version ? { version } : {}),
    setup: { code, message },
    checkedAt: isoNow(),
  });

  const versionResult = await runCapture(launch.command, versionArgs(launch), { timeoutMs: VERSION_TIMEOUT_MS, env: options.env });
  const version = /\d+\.\d+\.\d+[\w.+-]*/.exec(versionResult.stdout)?.[0];
  if (!version) {
    const reason =
      versionResult.error?.message ??
      (versionResult.timedOut ? `\`dsh --version\` did not answer within ${VERSION_TIMEOUT_MS / 1000}s` : firstLine(versionResult.stderr) ?? `\`dsh --version\` exited with code ${versionResult.code}`);
    const engines = readEnginesNode(launch);
    const nodeNote = engines && nodeSatisfies(process.version, engines) === false ? ` DSH declares Node ${engines}; this service runs Node ${process.version}.` : "";
    return unavailable("dsh_probe_failed", `${clip(reason, 300)}${nodeNote}`);
  }

  let dir: string | undefined;
  let proc: JsonlProcess | undefined;
  let rpc: DshRpc | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "ensemble-dsh-probe-"));
    const patch = join(dir, "probe.patch.yml");
    await writeFile(patch, probePatchYaml(dir), "utf8");
    proc = spawnJsonl(launch.command, acpArgs(launch, patch), { cwd: dir, env: { ...options.env, DSH_PERMISSION_MODE: "read-only" } });
    const client: DshRpc = new DshRpc(proc, {
      onNotification: () => undefined,
      onServerRequest: (id, method) => client.respondError(id, -32601, `Ensemble probe does not handle "${method}".`),
    });
    rpc = client;

    const init = asRecord(await client.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "ensemble", version: options.clientVersion } }, INIT_TIMEOUT_MS));
    const protocol = num(init?.["protocolVersion"]);
    if (protocol !== 1) throw new ProbeFailure("dsh_unsupported", `DSH answered ACP protocol version ${protocol ?? "unknown"}; Ensemble speaks version 1.`);
    // 声明了 resume 才算支持服务重启后恢复（实测 0.2.2-rc.1 声明了 close / list / resume）。
    const resumable = asRecord(asRecord(init?.["agentCapabilities"])?.["sessionCapabilities"])?.["resume"] !== undefined;

    const created = asRecord(await client.request("session/new", { cwd: dir, mcpServers: [] }, NEW_TIMEOUT_MS));
    const sessionId = str(created?.["sessionId"]);
    if (!sessionId) throw new ProbeFailure("dsh_probe_failed", "DSH did not return a session id for session/new.");
    const catalog = parseCatalog(created?.["configOptions"]);
    const models = await readModels(client, sessionId, catalog);
    const current = catalog.models.find((model) => model.value === catalog.current);

    const info: HarnessInfo = {
      ...base,
      capabilities: resumable ? DSH_CAPABILITIES : { ...DSH_CAPABILITIES, resume: { support: "no", verification: "live" } },
      access: dshAccess(true),
      status: "ready",
      models,
      version,
      ...(current ? { defaultModel: current.id } : {}),
      checkedAt: isoNow(),
    };
    if (models.length === 0) {
      info.status = "needs_setup";
      info.setup = {
        code: "dsh_no_models",
        message: "DSH's acp profile lists no model. Check the profile under your DSH home (profiles/acp), then probe again.",
      };
    }
    return info;
  } catch (error) {
    const stderr = firstLine(proc?.stderrTail() ?? "");
    const message = clip(stderr && !errorMessage(error).includes(stderr) ? `${errorMessage(error)} (${clip(stderr, 200)})` : errorMessage(error), 400);
    return unavailable(error instanceof ProbeFailure ? error.code : "dsh_probe_failed", message, version);
  } finally {
    rpc?.failAll(new Error("probe finished"));
    await proc?.kill();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
