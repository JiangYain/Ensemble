import { existsSync, readFileSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { ENV } from "@shared/constants";
import type { SessionMeta } from "@shared/types";
import { findExecutableOnPath } from "./process";
import { HarnessStartError } from "./common";

export interface ClaudeLaunch {
  command: string;
  prefix: string[];
}

function launchFile(path: string): ClaudeLaunch {
  return /\.(?:m?js|cjs)$/i.test(extname(path)) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] };
}

/** Windows npm shims may point to a native executable rather than a JS entry. */
export function resolveClaudeLaunch(env: NodeJS.ProcessEnv, explicit?: string): ClaudeLaunch | undefined {
  const configured = explicit ?? env[ENV.claudeBin];
  if (configured) return existsSync(configured) ? launchFile(configured) : undefined;
  const native = findExecutableOnPath(process.platform === "win32" ? ["claude.exe"] : ["claude"], env);
  if (native) return launchFile(native);
  if (process.platform !== "win32") return undefined;
  for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter(Boolean)) {
    const shim = join(dir, "claude.cmd");
    if (!existsSync(shim)) continue;
    try {
      const match = /"%dp0%[\\/]+(node_modules[^\"]+?\.(?:exe|m?js|cjs))"/i.exec(readFileSync(shim, "utf8"));
      const target = match?.[1] ? join(dir, match[1]) : undefined;
      if (target && existsSync(target)) return launchFile(target);
    } catch {
      // Keep looking if a shim cannot be read.
    }
  }
  return undefined;
}

export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
export const REQUIRED_FLAGS = ["--input-format", "--output-format", "--replay-user-messages", "--include-partial-messages", "--session-id", "--resume", "--permission-mode"] as const;
export const READ_ONLY_FLAGS = ["--safe-mode", "--strict-mcp-config", "--tools"] as const;

export function supportsFlags(help: string, flags: readonly string[]): boolean {
  return flags.every((flag) => help.includes(flag));
}

export function claudeRunArgs(meta: SessionMeta, sessionId: string, resume: boolean): string[] {
  const args = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--replay-user-messages", "--include-partial-messages", "--permission-mode", "bypassPermissions"];
  if (meta.access === "read_only") args.push("--safe-mode", "--strict-mcp-config", "--tools", READ_ONLY_TOOLS.join(","));
  if (meta.model?.requested) {
    if (meta.model.requested.startsWith("-")) throw new HarnessStartError("invalid_request", "Invalid Claude Code model.");
    args.push("--model", meta.model.requested);
  }
  if (meta.effort) {
    if (!["low", "medium", "high", "xhigh", "max"].includes(meta.effort)) throw new HarnessStartError("invalid_request", "Unsupported Claude Code effort level.");
    args.push("--effort", meta.effort);
  }
  args.push(resume ? "--resume" : "--session-id", sessionId);
  return args;
}
