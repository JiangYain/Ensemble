import { ENV } from "@shared/constants";
import type { HarnessId } from "@shared/types";
import type { Logger } from "../logger";
import type { EnsemblePaths } from "../paths";
import { CodexExecutor } from "./codex";
import { ClaudeExecutor } from "./claude";
import { CursorExecutor } from "./cursor";
import { DshExecutor } from "./dsh";
import { FixtureExecutor } from "./fixture";
import { OpenCodeExecutor } from "./opencode";
import { PiExecutor } from "./pi";
import type { Executor } from "./types";

export interface ExecutorFactoryOptions {
  env: NodeJS.ProcessEnv;
  paths: EnsemblePaths;
  log: Logger;
}

const FIXTURE_LABELS: Partial<Record<HarnessId, string>> = {
  cursor: "Cursor",
  codex: "Codex",
  pi: "Pi",
  claude: "Claude Code",
  opencode: "OpenCode",
  dsh: "DSH",
};

/** 解析 ENSEMBLE_FIXTURE（逗号分隔的 Harness id，或 all），仅用于开发与测试。 */
function fixtureIds(env: NodeJS.ProcessEnv): HarnessId[] {
  const raw = env[ENV.fixture]?.trim();
  if (!raw) return [];
  if (raw === "all") return ["cursor", "codex", "pi", "claude", "opencode", "dsh"];
  const known = new Set<string>(["cursor", "codex", "pi", "claude", "opencode", "dsh", "fixture"]);
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is HarnessId => known.has(part));
}

/**
 * 创建所有启用的执行端：真实适配器为默认；ENSEMBLE_FIXTURE 里列出的 Harness 改用模拟器
 * （界面会标注“模拟”，绝不冒充真实执行）。
 */
export function createExecutors(options: ExecutorFactoryOptions): Executor[] {
  const mocked = new Set(fixtureIds(options.env));
  const speed = Number(options.env[ENV.fixtureSpeed] ?? 1);
  const executors: Executor[] = [];

  const real: Partial<Record<HarnessId, () => Executor>> = {
    cursor: () => new CursorExecutor({ env: options.env, runtimeDir: options.paths.runtime }),
    codex: () => new CodexExecutor({ env: options.env }),
    pi: () => new PiExecutor({ env: options.env }),
    claude: () => new ClaudeExecutor({ env: options.env }),
    opencode: () => new OpenCodeExecutor({ env: options.env }),
    dsh: () => new DshExecutor({ env: options.env }),
  };

  for (const id of ["cursor", "codex", "pi", "claude", "opencode", "dsh"] as const) {
    if (mocked.has(id)) continue;
    const make = real[id];
    if (make) executors.push(make());
  }
  for (const id of mocked) {
    const label = FIXTURE_LABELS[id] ?? id;
    executors.push(new FixtureExecutor(id, { speed: Number.isFinite(speed) ? speed : 1, displayName: `${label} · 模拟` }));
  }
  return executors;
}
