import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 状态目录与宿主无关：Codex、Cursor 等不同宿主拉起的 MCP 桥必须连到同一个本地服务，
 * 所以不使用某个宿主私有的插件数据目录。
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ENSEMBLE_HOME"];
  if (override && override.trim().length > 0) return override;
  if (process.platform === "win32") {
    return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Ensemble");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Ensemble");
  }
  return join(env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "ensemble");
}

export interface EnsemblePaths {
  home: string;
  sessions: string;
  run: string;
  serviceFile: string;
  lockFile: string;
  logs: string;
  serviceLog: string;
  originDebugLog: string;
  runtime: string;
  settings: string;
}

export function pathsFor(home: string): EnsemblePaths {
  return {
    home,
    sessions: join(home, "data", "sessions"),
    run: join(home, "run"),
    serviceFile: join(home, "run", "service.json"),
    lockFile: join(home, "run", "service.lock"),
    logs: join(home, "logs"),
    serviceLog: join(home, "logs", "service.log"),
    originDebugLog: join(home, "logs", "origin-debug.jsonl"),
    runtime: join(home, "runtime"),
    settings: join(home, "settings.json"),
  };
}
