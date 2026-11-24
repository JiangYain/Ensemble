import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURSOR_SDK_VERSION } from "@shared/constants";
import type { CaptureResult } from "../server/executors/process";
import {
  INSTALL_MARKER,
  codexMarketplaceFile,
  codexPluginDir,
  cursorPluginDir,
  installCodex,
  installCursor,
  installSdk,
  locatePluginRoot,
  marketplaceEntry,
  runInstall,
  sdkPackageDir,
  uninstallCodex,
  uninstallCursor,
  verifySource,
  type InstallDeps,
  type InstallIo,
} from "./install";

const OK: CaptureResult = { code: 0, stdout: "ok", stderr: "", timedOut: false };

interface World {
  root: string;
  pluginRoot: string;
  userHome: string;
  runtimeDir: string;
}

async function put(file: string, text = ""): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

async function makeWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-install-"));
  const pluginRoot = join(root, "source");
  await put(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "ensemble" }));
  await put(join(pluginRoot, "mcp.json"), "{}");
  await put(join(pluginRoot, ".mcp.json"), "{}");
  await put(join(pluginRoot, ".cursor-plugin", "plugin.json"), "{}");
  await put(join(pluginRoot, "skills", "ensemble-delegate", "SKILL.md"), "---\nname: ensemble-delegate\n---\n");
  await put(join(pluginRoot, "assets", "logo.svg"), "<svg/>");
  await put(join(pluginRoot, "dist", "ensemble.mjs"), "// bundle");
  await put(join(pluginRoot, "dist", "web", "index.html"), "<html/>");
  await put(join(pluginRoot, "dist", "web", "assets", "app.js"), "// app");
  await put(join(pluginRoot, "dist", "web", "assets", "app.js.map"), "{}");
  await put(join(pluginRoot, "README.md"), "# Ensemble");
  // 以下内容不属于分发内容，不应被复制。
  await put(join(pluginRoot, "src", "secret.ts"), "export {}");
  await put(join(pluginRoot, "node_modules", "dep", "index.js"), "// dep");
  return { root, pluginRoot, userHome: join(root, "home"), runtimeDir: join(root, "ensemble-home", "runtime") };
}

interface Calls {
  codex: string[][];
  npm: string[][];
}

function makeDeps(world: World, overrides: Partial<InstallDeps> = {}): { deps: InstallDeps; calls: Calls } {
  const calls: Calls = { codex: [], npm: [] };
  const deps: InstallDeps = {
    pluginRoot: world.pluginRoot,
    userHome: world.userHome,
    runtimeDir: world.runtimeDir,
    version: "9.9.9",
    now: () => new Date("2026-11-07T08:09:10.000Z"),
    runCodex: async (args) => {
      calls.codex.push([...args]);
      return OK;
    },
    runNpm: async (args) => {
      calls.npm.push([...args]);
      const prefix = args[args.indexOf("--prefix") + 1];
      if (prefix) await put(join(sdkPackageDir(prefix), "package.json"), JSON.stringify({ name: "@cursor/sdk" }));
      return OK;
    },
    ...overrides,
  };
  return { deps, calls };
}

function makeIo(interactive = false, answer = true): { io: InstallIo; out: string[]; err: string[]; asked: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    io: {
      out: (text = "") => void out.push(text),
      err: (text = "") => void err.push(text),
      interactive,
      confirm: async (question) => {
        asked.push(question);
        return answer;
      },
    },
    out,
    err,
    asked,
  };
}

async function listAll(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listAll(full, base)));
    else found.push(full.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return found.sort();
}

let world: World;
beforeEach(async () => {
  world = await makeWorld();
});
afterEach(async () => {
  await rm(world.root, { recursive: true, force: true });
});

describe("locatePluginRoot / verifySource", () => {
  it("finds the plugin root from a nested file and nowhere else", async () => {
    const nested = pathToFileURL(join(world.pluginRoot, "dist", "web", "assets", "app.js")).href;
    expect(locatePluginRoot(nested)).toBe(world.pluginRoot);
    expect(locatePluginRoot(pathToFileURL(join(world.root, "home", "x.js")).href)).toBeUndefined();
  });

  it("reports what is missing before anything is copied", async () => {
    const { deps } = makeDeps(world);
    expect(verifySource(deps)).toBeUndefined();
    await rm(join(world.pluginRoot, "dist", "web"), { recursive: true });
    expect(verifySource(deps)).toMatch(/dist[\\/]web[\\/]index\.html.*npm run build/s);
    await rm(join(world.pluginRoot, "mcp.json"));
    expect(verifySource(deps)).toMatch(/mcp\.json/);
  });
});

describe("installCursor", () => {
  it("copies only the distributable payload and writes an install marker", async () => {
    const { deps } = makeDeps(world);
    const result = await installCursor(deps, { force: false });
    expect(result.ok).toBe(true);
    const target = cursorPluginDir(world.userHome);
    expect(await listAll(target)).toEqual([
      ".cursor-plugin/plugin.json",
      ".ensemble-install.json",
      ".mcp.json",
      "README.md",
      "assets/logo.svg",
      "dist/ensemble.mjs",
      "dist/web/assets/app.js",
      "dist/web/index.html",
      "mcp.json",
      "plugin.json",
      "skills/ensemble-delegate/SKILL.md",
    ]);
    const marker = JSON.parse(await readFile(join(target, INSTALL_MARKER), "utf8")) as Record<string, unknown>;
    expect(marker).toMatchObject({ name: "ensemble", version: "9.9.9", installedAt: "2026-11-07T08:09:10.000Z", source: world.pluginRoot });
    expect(result.lines.join("\n")).toMatch(/Reload Window/);
  });

  it("replaces an earlier install completely, dropping files that no longer exist", async () => {
    const { deps } = makeDeps(world);
    await installCursor(deps, { force: false });
    const target = cursorPluginDir(world.userHome);
    await rm(join(world.pluginRoot, "dist", "web", "assets", "app.js"));
    await put(join(world.pluginRoot, "dist", "web", "assets", "app2.js"), "// next");
    await put(join(world.pluginRoot, "dist", "ensemble.mjs"), "// bundle v2");
    expect((await installCursor(deps, { force: false })).ok).toBe(true);
    expect(existsSync(join(target, "dist", "web", "assets", "app.js"))).toBe(false);
    expect(await readFile(join(target, "dist", "web", "assets", "app2.js"), "utf8")).toBe("// next");
    expect(await readFile(join(target, "dist", "ensemble.mjs"), "utf8")).toBe("// bundle v2");
  });

  it("refuses to overwrite a directory it did not create, unless forced", async () => {
    const { deps } = makeDeps(world);
    const target = cursorPluginDir(world.userHome);
    await put(join(target, "someone-elses.txt"), "keep me");
    const refused = await installCursor(deps, { force: false });
    expect(refused.ok).toBe(false);
    expect(refused.lines.join("\n")).toMatch(/不是由 Ensemble 安装的.*--force/s);
    expect(await listAll(target)).toEqual(["someone-elses.txt"]);

    const forced = await installCursor(deps, { force: true });
    expect(forced.ok).toBe(true);
    expect(existsSync(join(target, "plugin.json"))).toBe(true);
    expect(existsSync(join(target, "someone-elses.txt"))).toBe(true);
  });

  it("accepts an existing empty directory", async () => {
    const { deps } = makeDeps(world);
    await mkdir(cursorPluginDir(world.userHome), { recursive: true });
    expect((await installCursor(deps, { force: false })).ok).toBe(true);
  });
});

describe("installCodex", () => {
  const marketplacePath = (): string => codexMarketplaceFile(world.userHome);

  it("creates a personal marketplace, registers the plugin and runs `codex plugin add`", async () => {
    const { deps, calls } = makeDeps(world);
    const result = await installCodex(deps, { force: false });
    expect(result.ok).toBe(true);
    expect(calls.codex).toEqual([["plugin", "add", "ensemble@personal"]]);
    expect(existsSync(join(codexPluginDir(world.userHome), "plugin.json"))).toBe(true);
    const market = JSON.parse(await readFile(marketplacePath(), "utf8")) as { name: string; interface: unknown; plugins: unknown[] };
    expect(market.name).toBe("personal");
    expect(market.plugins).toEqual([
      { name: "ensemble", source: { source: "local", path: "./plugins/ensemble" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" },
    ]);
    expect(result.lines.join("\n")).toMatch(/重启 Codex/);
  });

  it("adds to an existing marketplace without disturbing it, backs it up, and is idempotent", async () => {
    const original = {
      name: "mine",
      interface: { displayName: "Mine" },
      custom: { keep: true },
      plugins: [{ name: "gsap", source: { source: "local", path: "./plugins/gsap" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }],
    };
    const text = `\uFEFF${JSON.stringify(original, null, 4)}`; // PowerShell 常写出带 BOM 的 JSON
    await put(marketplacePath(), text);
    const { deps, calls } = makeDeps(world);

    const first = await installCodex(deps, { force: false });
    expect(first.ok).toBe(true);
    expect(calls.codex).toEqual([["plugin", "add", "ensemble@mine"]]);
    const next = JSON.parse(await readFile(marketplacePath(), "utf8")) as typeof original;
    expect(next.name).toBe("mine");
    expect(next.custom).toEqual({ keep: true });
    expect(next.plugins.map((plugin) => plugin.name)).toEqual(["gsap", "ensemble"]);
    expect(next.plugins[0]).toEqual(original.plugins[0]);

    const backups = (await readdir(dirname(marketplacePath()))).filter((name) => name.includes(".ensemble-backup-"));
    expect(backups).toEqual(["marketplace.json.ensemble-backup-20261107-080910"]);
    expect(await readFile(join(dirname(marketplacePath()), backups[0] as string), "utf8")).toBe(text);

    const second = await installCodex(deps, { force: false });
    expect(second.ok).toBe(true);
    expect(second.lines.join("\n")).toMatch(/已有相同的 ensemble 条目/);
    expect((await readdir(dirname(marketplacePath()))).filter((name) => name.includes(".ensemble-backup-"))).toHaveLength(1);
  });

  it("points a stale entry at the managed directory", async () => {
    await put(marketplacePath(), JSON.stringify({ name: "personal", plugins: [{ name: "ensemble", source: { source: "local", path: "./old/place" } }] }));
    const { deps } = makeDeps(world);
    expect((await installCodex(deps, { force: false })).ok).toBe(true);
    const market = JSON.parse(await readFile(marketplacePath(), "utf8")) as { plugins: Array<{ source: { path: string } }> };
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]?.source.path).toBe("./plugins/ensemble");
  });

  it("leaves everything untouched when the marketplace file is not valid JSON", async () => {
    await put(marketplacePath(), "{ not json");
    const { deps, calls } = makeDeps(world);
    const result = await installCodex(deps, { force: false });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(/不是有效的 JSON/);
    expect(await readFile(marketplacePath(), "utf8")).toBe("{ not json");
    expect(existsSync(codexPluginDir(world.userHome))).toBe(false);
    expect(calls.codex).toEqual([]);
  });

  it("rejects a marketplace whose plugins field is not an array", async () => {
    await put(marketplacePath(), JSON.stringify({ name: "personal", plugins: {} }));
    const { deps } = makeDeps(world);
    const result = await installCodex(deps, { force: false });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(/结构不是预期/);
  });

  it("keeps the files and gives the manual command when Codex is not installed", async () => {
    const { deps } = makeDeps(world, { runCodex: async () => undefined });
    const result = await installCodex(deps, { force: false });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(/没有找到 Codex 命令行.*codex plugin add ensemble@personal/s);
    expect(existsSync(join(codexPluginDir(world.userHome), "plugin.json"))).toBe(true);
  });

  it("reports a failing `codex plugin add` with its output", async () => {
    const { deps } = makeDeps(world, { runCodex: async () => ({ code: 1, stdout: "", stderr: "line one\nplugin not found in marketplace", timedOut: false }) });
    const result = await installCodex(deps, { force: false });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(/退出码 1.*plugin not found in marketplace/s);
    expect(result.lines.join("\n")).toMatch(/稍后手动运行/);
  });

  it("reports a timeout of the Codex command", async () => {
    const { deps } = makeDeps(world, { runCodex: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
    const result = await installCodex(deps, { force: false });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(/超时/);
  });
});

describe("uninstall", () => {
  it("removes the Codex install: command, marketplace entry (others kept) and managed directory", async () => {
    await put(
      codexMarketplaceFile(world.userHome),
      JSON.stringify({ name: "personal", plugins: [{ name: "gsap", source: { source: "local", path: "./plugins/gsap" } }] }),
    );
    const { deps, calls } = makeDeps(world);
    await installCodex(deps, { force: false });
    calls.codex.length = 0;

    const result = await uninstallCodex(deps);
    expect(result.ok).toBe(true);
    expect(calls.codex).toEqual([["plugin", "remove", "ensemble@personal"]]);
    expect(existsSync(codexPluginDir(world.userHome))).toBe(false);
    const market = JSON.parse(await readFile(codexMarketplaceFile(world.userHome), "utf8")) as { plugins: Array<{ name: string }> };
    expect(market.plugins.map((plugin) => plugin.name)).toEqual(["gsap"]);
  });

  it("does not delete a directory that Ensemble did not install", async () => {
    const dir = codexPluginDir(world.userHome);
    await put(join(dir, "mine.txt"), "hands off");
    const { deps } = makeDeps(world);
    const result = await uninstallCodex(deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(/不是由 Ensemble 安装的/);
    expect(existsSync(join(dir, "mine.txt"))).toBe(true);
  });

  it("copes with nothing being installed", async () => {
    const { deps } = makeDeps(world);
    expect((await uninstallCodex(deps)).ok).toBe(true);
    expect((await uninstallCursor(deps)).ok).toBe(true);
  });

  it("removes the Cursor install, and only if it is ours", async () => {
    const { deps } = makeDeps(world);
    await installCursor(deps, { force: false });
    expect((await uninstallCursor(deps)).ok).toBe(true);
    expect(existsSync(cursorPluginDir(world.userHome))).toBe(false);

    await put(join(cursorPluginDir(world.userHome), "other.txt"), "x");
    const refused = await uninstallCursor(deps);
    expect(refused.ok).toBe(false);
    expect(existsSync(join(cursorPluginDir(world.userHome), "other.txt"))).toBe(true);
  });
});

describe("installSdk", () => {
  it("installs the pinned SDK version into the runtime directory", async () => {
    const { deps, calls } = makeDeps(world);
    const result = await installSdk(deps);
    expect(result.ok).toBe(true);
    expect(calls.npm).toEqual([["install", "--prefix", world.runtimeDir, "--no-audit", "--no-fund", `@cursor/sdk@${CURSOR_SDK_VERSION}`]]);
    expect(result.lines.join("\n")).toMatch(/cursor-login/);
  });

  it("explains a missing npm, a failing npm and a false success", async () => {
    const missing = await installSdk(makeDeps(world, { runNpm: async () => undefined }).deps);
    expect(missing.ok).toBe(false);
    expect(missing.lines.join("\n")).toMatch(/没有找到 npm/);

    const failing = await installSdk(makeDeps(world, { runNpm: async () => ({ code: 1, stdout: "", stderr: "ENOTFOUND registry", timedOut: false }) }).deps);
    expect(failing.ok).toBe(false);
    expect(failing.lines.join("\n")).toMatch(/退出码 1.*ENOTFOUND/s);

    const hollow = await installSdk(makeDeps(world, { runNpm: async () => OK }).deps);
    expect(hollow.ok).toBe(false);
    expect(hollow.lines.join("\n")).toMatch(/没有.*找到/);
  });
});

describe("marketplaceEntry", () => {
  it("uses a forward-slash path relative to the marketplace root", () => {
    const entry = marketplaceEntry(world.userHome, codexPluginDir(world.userHome));
    expect(entry.source).toEqual({ source: "local", path: "./plugins/ensemble" });
  });
});

describe("runInstall", () => {
  const base = (flags: string[], targets: Array<"codex" | "cursor" | "sdk">, io: InstallIo, extra: Partial<InstallDeps> = {}) => ({
    mode: "install" as const,
    targets,
    flags: new Set(flags),
    deps: makeDeps(world, extra).deps,
    io,
  });

  it("asks which target when none is given", async () => {
    const { io, err } = makeIo();
    expect(await runInstall(base(["yes"], [], io))).toBe(2);
    expect(err.join("\n")).toMatch(/请指明/);
  });

  it("shows the plan and changes nothing with --dry-run", async () => {
    const { io, out } = makeIo();
    expect(await runInstall(base(["dry-run"], ["codex", "cursor", "sdk"], io))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(codexPluginDir(world.userHome));
    expect(text).toContain(cursorPluginDir(world.userHome));
    expect(text).toContain(`@cursor/sdk@${CURSOR_SDK_VERSION}`);
    expect(text).toMatch(/预览/);
    expect(existsSync(world.userHome)).toBe(false);
    expect(existsSync(world.runtimeDir)).toBe(false);
  });

  it("does not touch anything without confirmation when it cannot ask", async () => {
    const { io, err } = makeIo(false);
    expect(await runInstall(base([], ["cursor"], io))).toBe(2);
    expect(err.join("\n")).toMatch(/--yes/);
    expect(existsSync(world.userHome)).toBe(false);
  });

  it("asks interactively, and a refusal changes nothing", async () => {
    const declined = makeIo(true, false);
    expect(await runInstall(base([], ["cursor"], declined.io))).toBe(1);
    expect(declined.asked).toHaveLength(1);
    expect(existsSync(world.userHome)).toBe(false);

    const accepted = makeIo(true, true);
    expect(await runInstall(base([], ["cursor"], accepted.io))).toBe(0);
    expect(existsSync(join(cursorPluginDir(world.userHome), "plugin.json"))).toBe(true);
  });

  it("installs every requested target with --yes, in a fixed order", async () => {
    const { io, out } = makeIo();
    const code = await runInstall(base(["yes"], ["sdk", "cursor", "codex"], io));
    expect(code).toBe(0);
    const steps = out.filter((line) => /^[✓✗] /.test(line));
    expect(steps).toEqual(["✓ Codex", "✓ Cursor", "✓ Cursor SDK"]);
  });

  it("exits 1 when any step fails but still runs the others", async () => {
    const { io, out } = makeIo();
    const code = await runInstall(base(["yes"], ["codex", "cursor"], io, { runCodex: async () => undefined }));
    expect(code).toBe(1);
    expect(out.filter((line) => /^[✓✗] /.test(line))).toEqual(["✗ Codex", "✓ Cursor"]);
    expect(existsSync(join(cursorPluginDir(world.userHome), "plugin.json"))).toBe(true);
  });

  it("refuses to install from an already installed copy", async () => {
    const copy = codexPluginDir(world.userHome);
    await put(join(copy, "plugin.json"), "{}");
    await put(join(copy, "mcp.json"), "{}");
    await put(join(copy, "dist", "ensemble.mjs"), "");
    await put(join(copy, "dist", "web", "index.html"), "");
    const { io, err } = makeIo();
    const code = await runInstall({ ...base(["yes"], ["cursor"], io), deps: makeDeps(world, { pluginRoot: copy }).deps });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/已安装的那份插件/);
    expect(existsSync(cursorPluginDir(world.userHome))).toBe(false);
  });

  it("stops early when the source has not been built", async () => {
    await rm(join(world.pluginRoot, "dist"), { recursive: true });
    const { io, err } = makeIo();
    expect(await runInstall(base(["yes"], ["cursor"], io))).toBe(1);
    expect(err.join("\n")).toMatch(/npm run build/);
  });

  it("mentions a running service that still holds the old version", async () => {
    const { io, out } = makeIo();
    await runInstall({ ...base(["yes"], ["cursor"], io), serviceRunning: true });
    expect(out.join("\n")).toMatch(/正在运行旧版本/);
  });

  it("uninstall skips the SDK target and previews without changes", async () => {
    const { deps } = makeDeps(world);
    await installCursor(deps, { force: false });
    const preview = makeIo();
    expect(await runInstall({ mode: "uninstall", targets: ["cursor", "sdk"], flags: new Set(["dry-run"]), deps, io: preview.io })).toBe(0);
    expect(preview.out.join("\n")).not.toMatch(/SDK/);
    expect(existsSync(cursorPluginDir(world.userHome))).toBe(true);

    const real = makeIo();
    expect(await runInstall({ mode: "uninstall", targets: ["cursor", "sdk"], flags: new Set(["yes"]), deps, io: real.io })).toBe(0);
    expect(existsSync(cursorPluginDir(world.userHome))).toBe(false);
  });
});
