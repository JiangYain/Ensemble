import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV } from "@shared/constants";
import {
  acpArgs,
  nodeSatisfies,
  permissionMode,
  probePatchYaml,
  readEnginesNode,
  resolveDshLaunch,
  sessionEnv,
  versionArgs,
} from "./dsh-launch";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-dsh-launch-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 在 `prefixDir` 下铺出 npm 全局安装 dsh 的目录结构（Windows：.cmd 垫片；POSIX：符号链接），返回命令目录与入口。 */
function installDsh(prefixDir: string, engines = ">=24.9.0"): { binDir: string; entry: string; packageDir: string } {
  const packageDir = join(prefixDir, "node_modules", "@deepseek-ai", "dsh");
  const entry = join(packageDir, "lib", "bin.js");
  mkdirSync(join(packageDir, "lib"), { recursive: true });
  writeFileSync(entry, "// fake dsh entry\n");
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.1", engines: { node: engines } }));
  if (process.platform === "win32") {
    writeFileSync(
      join(prefixDir, "dsh.cmd"),
      `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n`,
    );
    return { binDir: prefixDir, entry, packageDir };
  }
  const binDir = join(prefixDir, "bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(entry, join(binDir, "dsh"));
  return { binDir, entry, packageDir };
}

describe("resolveDshLaunch", () => {
  it("用 node 运行显式指定的 JS 入口，并把入口放进前缀参数", () => {
    const dir = tempDir();
    const script = join(dir, "fake-dsh.mjs");
    writeFileSync(script, "");
    const launch = resolveDshLaunch({ bin: script, env: {} });
    expect(launch).toMatchObject({ command: process.execPath, prefix: [script] });
    // 入口不在 dsh 包里（测试用的假 dsh）：没有包目录，也就读不到 engines。
    expect(launch?.packageDir).toBeUndefined();
    expect(readEnginesNode(launch!)).toBeUndefined();
  });

  it("可执行文件直接运行；环境变量与选项等价", () => {
    const dir = tempDir();
    const exe = join(dir, process.platform === "win32" ? "dsh.exe" : "dsh");
    writeFileSync(exe, "");
    expect(resolveDshLaunch({ bin: exe, env: {} })).toMatchObject({ command: exe, prefix: [] });
    expect(resolveDshLaunch({ env: { [ENV.dshBin]: exe } })).toMatchObject({ command: exe, prefix: [] });
  });

  it("显式指定了却不存在：不回退到 PATH 上的别的 dsh", () => {
    const prefix = tempDir();
    const { binDir } = installDsh(prefix);
    const env = { PATH: binDir };
    expect(resolveDshLaunch({ env })).toBeDefined();
    expect(resolveDshLaunch({ bin: join(prefix, "missing-dsh.mjs"), env })).toBeUndefined();
    expect(resolveDshLaunch({ env: { ...env, [ENV.dshBin]: join(prefix, "missing-dsh.mjs") } })).toBeUndefined();
  });

  it("沿 PATH 找到 npm 全局安装的 dsh，解析到 JS 入口并带出包目录与 engines", () => {
    const prefix = tempDir();
    const { binDir, entry, packageDir } = installDsh(prefix);
    const launch = resolveDshLaunch({ env: { PATH: binDir } });
    expect(launch).toMatchObject({ command: process.execPath, prefix: [entry], packageDir });
    expect(readEnginesNode(launch!)).toBe(">=24.9.0");
  });

  it.skipIf(process.platform !== "win32")("PATH 里没有 npm 目录时，回退到 %APPDATA%\\npm（从 GUI 宿主启动的常见情况）", () => {
    const appData = tempDir();
    const npmDir = join(appData, "npm");
    mkdirSync(npmDir, { recursive: true });
    const { entry } = installDsh(npmDir);
    const empty = tempDir();
    const launch = resolveDshLaunch({ env: { PATH: empty, APPDATA: appData } });
    expect(launch).toMatchObject({ command: process.execPath, prefix: [entry] });
  });

  it("哪里都没有 dsh 时返回 undefined", () => {
    expect(resolveDshLaunch({ env: { PATH: tempDir() } })).toBeUndefined();
  });
});

describe("启动参数与环境", () => {
  const launch = { command: "node", prefix: ["/x/bin.js"], source: "/x/bin.js" };

  it("acp profile 的参数；探测时多一个 --patch", () => {
    expect(acpArgs(launch)).toEqual(["/x/bin.js", "--profile", "acp"]);
    expect(acpArgs(launch, "/tmp/p.yml")).toEqual(["/x/bin.js", "--profile", "acp", "--patch", "/tmp/p.yml"]);
    expect(versionArgs(launch)).toEqual(["/x/bin.js", "--version"]);
  });

  it("委派默认 Full Access；只读才用 read-only", () => {
    expect(permissionMode("full")).toBe("danger-full-access");
    expect(permissionMode("read_only")).toBe("read-only");
  });

  it("会话环境覆盖用户已设置的权限模式，并写入父会话信息供嵌套委派", () => {
    const env = sessionEnv({ DSH_PERMISSION_MODE: "workspace-write", KEEP: "1" }, { id: "ses_parent" as never, depth: 2, access: "read_only" });
    expect(env).toMatchObject({
      KEEP: "1",
      DSH_PERMISSION_MODE: "read-only",
      [ENV.parentSession]: "ses_parent",
      [ENV.parentDepth]: "2",
    });
  });

  it("探测用的 patch：会话存储与会话索引都改到临时目录；路径按字面写进单引号字符串，单引号翻倍", () => {
    const root = join("base", "probe");
    expect(probePatchYaml(root)).toBe(
      [
        "- id: session-persistence-jsonl",
        "  config:",
        `    root: '${join(root, "sessions")}'`,
        "- id: storage-json",
        "  config:",
        `    root: '${join(root, "storages")}'`,
        "",
      ].join("\n"),
    );
    const quoted = probePatchYaml(join("C:", "Users", "O'Brien"));
    expect(quoted).toContain(`root: '${join("C:", "Users", "O''Brien", "sessions")}'`);
    expect(quoted).toContain(`root: '${join("C:", "Users", "O''Brien", "storages")}'`);
  });
});

describe("nodeSatisfies", () => {
  it("只判断 >=X.Y.Z；别的写法不猜", () => {
    expect(nodeSatisfies("22.22.2", ">=24.9.0")).toBe(false);
    expect(nodeSatisfies("24.8.9", ">=24.9.0")).toBe(false);
    expect(nodeSatisfies("24.9.0", ">=24.9.0")).toBe(true);
    expect(nodeSatisfies("v24.10.1", ">=24.9.0")).toBe(true);
    expect(nodeSatisfies("25.0.0", ">= 24.9.0")).toBe(true);
    expect(nodeSatisfies("22.22.2", "^24.9.0")).toBeUndefined();
    expect(nodeSatisfies("22.22.2", ">=24.9.0 <27")).toBeUndefined();
    expect(nodeSatisfies("not-a-version", ">=24.9.0")).toBeUndefined();
  });
});
