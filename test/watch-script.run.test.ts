/**
 * 看门狗脚本（skills/ensemble-delegate/scripts/watch.mjs）当作脚本跑，以及它随插件分发的方式。
 *
 * 前一组起一个隔离的真实服务（临时 ENSEMBLE_HOME、系统分配端口、模拟执行端），把脚本当子进程跑一遍；
 * 每个用例结束后由 `afterEach(cleanup)` 结束还活着的子进程、关掉起过的服务。
 * 后一组读脚本源码做静态断言（只读、独立、放在 skills 目录里、SKILL.md 里有说明），再把它经安装器复制一遍，确认装好的那一份自己能跑。
 *
 * 脚本其余部分的测试在同目录：watch-script.test.ts（判断逻辑）、watch-script.copies.test.ts（与应用同口径的拷贝）、
 * watch-script.pass.test.ts（巡检流程与输出格式）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cursorPluginDir, defaultDeps, installCursor, PLUGIN_PAYLOAD } from "../src/cli/install";
import { until } from "../src/server/testing";
import { cleanup, delegate, examplePath, root, run, scriptPath, serve, skillDir, USER } from "./watch-script.fixtures";

// ───────────────────────── 当作脚本跑（真实服务，真实子进程） ─────────────────────────

afterEach(cleanup);

describe("run as a script against a real service", () => {
  it("reports a finished session with [DONE] and exits with 0", async () => {
    const service = await serve();
    const { sessionId } = await delegate(service, "[fixture:quick] say hello");
    await until(() => service.hub.summary(sessionId)?.phase === "done", 8000, "the run to finish");
    const result = await run([sessionId, "--interval", "0.2"], service.paths.home).done;
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`\\[DONE\\] ".*" \\(${sessionId}\\): finished \\(\\d+ tool calls?.*\\) — use the \`read\` tool for its result`));
    expect(result.stdout).toMatch(/\[INFO\] all 1 watched session has finished; the watcher is exiting/);
  });

  it("reports a failed session with [ALERT] and the recorded error", async () => {
    const service = await serve();
    const { sessionId } = await delegate(service, "[fixture:fail] break it");
    await until(() => service.hub.summary(sessionId)?.phase === "failed", 8000, "the run to fail");
    const result = await run([sessionId, "--interval", "0.2"], service.paths.home).done;
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`\\[ALERT\\] ".*" \\(${sessionId}\\): ended as failed — \\[fixture_failure\\]`));
  });

  it("checks the project rules it is given against what the session really did", async () => {
    const service = await serve();
    const { sessionId } = await delegate(service, "Fix the parser");
    await until(() => service.hub.summary(sessionId)?.phase === "done", 12_000, "the run to finish");
    const rules = join(mkdtempSync(join(tmpdir(), "ensemble-watch-rules-")), "rules.json");
    writeFileSync(rules, JSON.stringify({ commands: [{ match: "\\bnpm\\s+test\\b", message: "ran the test suite" }], paths: [{ match: "^src/parser/", message: "touched the parser" }] }));
    const result = await run([sessionId, "--rules", rules, "--interval", "0.2"], service.paths.home).done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 project rules loaded");
    expect(result.stdout).toMatch(/\[ALERT\] .*: ran the test suite: npm test/);
    expect(result.stdout).toMatch(/\[ALERT\] .*: touched the parser: src\/parser\/tokenizer\.ts/);
    expect(result.stdout).toMatch(/\[DONE\]/);
  });

  it("without session ids picks up what is running, and leaves by itself once it has ended, touching nothing", async () => {
    const service = await serve();
    const { sessionId } = await delegate(service, "Wait for guidance [fixture:hold]");
    await until(() => service.hub.summary(sessionId)?.phase === "running", 8000, "the run to start");
    const watcher = run(["--interval", "0.2"], service.paths.home);
    await watcher.waitFor(/watching 1 session:/);
    await service.manager.cancel(sessionId, USER);
    const result = await watcher.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`\\[INFO\\] ".*" \\(${sessionId}\\): ended as cancelled`));
    expect(result.stdout).toMatch(/the watcher is exiting/);
    // 只读：它没有给这个会话发过任何消息（除了最初的委派原文）。
    expect(service.hub.state(sessionId)?.messages).toHaveLength(1);
  });

  it("exits with 0 and says so when nothing is in progress", async () => {
    const service = await serve();
    const result = await run(["--interval", "0.2"], service.paths.home).done;
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\[INFO\] no unfinished sessions to watch/);
  });

  it("exits with 2 for a session id the service does not know", async () => {
    const service = await serve();
    const result = await run(["ses_does_not_exist"], service.paths.home).done;
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/\[ALERT\] unknown session ses_does_not_exist — not watching it/);
  });

  it("exits with 3 when there is no service to ask", async () => {
    const result = await run(["--once"], mkdtempSync(join(tmpdir(), "ensemble-watch-empty-"))).done;
    expect(result.code).toBe(3);
    expect(result.stdout).toMatch(/\[ALERT\] cannot reach the Ensemble service \(no service\.json under .*\)/);
  });

  it("prints its usage for --help and refuses unknown options or unusable rules", () => {
    const launch = (args: string[]) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, ENSEMBLE_HOME: join(tmpdir(), "ensemble-watch-none") } });
    const help = launch(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: node watch.mjs [session-id ...] [options]");
    expect(help.stdout).toContain("it never cancels or messages a session");

    const unknown = launch(["--bogus"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown option --bogus");

    const broken = join(mkdtempSync(join(tmpdir(), "ensemble-watch-rules-")), "rules.json");
    writeFileSync(broken, JSON.stringify({ commands: [{ match: "(", message: "m" }] }));
    const rules = launch(["--rules", broken]);
    expect(rules.status).toBe(2);
    expect(rules.stderr).toContain("Cannot use --rules");
    expect(rules.stderr).toContain("commands[0].match is not a valid regular expression");

    const missing = launch(["--rules", join(tmpdir(), "ensemble-watch-no-such-rules.json")]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("Cannot use --rules");
  });
});

// ───────────────────────── 随插件分发 ─────────────────────────

describe("shipping with the plugin", () => {
  const source = readFileSync(scriptPath, "utf8");

  it("only reads from the service: the one file it may write is the --state file", () => {
    // 对服务与会话只读：没有写类的 HTTP 方法，不起子进程、不结束任何进程。
    expect(source).not.toMatch(/method\s*:|\b(POST|PUT|PATCH|DELETE)\b/);
    // 下面这张名单只拦得住“字面写出来”的写盘函数。--state 用的是 openSync / writeSync / renameSync，不在其中，所以另有后半段的限定。
    expect(source).not.toMatch(/writeFile|appendFile|unlink|rmSync|mkdirSync|child_process|\.kill\(/);
    expect([...source.matchAll(/from "(node:[a-z/]+)"/g)].map((match) => match[1]).sort()).toEqual(["node:fs", "node:os", "node:path", "node:url"]);
    // 动态 import / require 能绕开上面的静态导入清单。
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);

    const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;
    /** 顶层函数的源码：从声明行到下一个顶格的 `}`（不依赖行号；函数体内的花括号都有缩进）。 */
    const functionSource = (name: string): string => {
      const found = new RegExp(`^(?:export )?function ${name}\\([^)]*\\) \\{\\r?\\n[\\s\\S]*?\\r?\\n\\}$`, "m").exec(source);
      if (!found) throw new Error(`watch.mjs has no top-level function ${name}`);
      return found[0];
    };

    // 写盘：脚本唯一会写的是 --state 点名的状态文件，而且只经 writeStateFile（写同目录下的临时文件，再改名）。
    // node:fs 的导入是一张白名单：新增任何名字都要有意为之（并确认它不会写别处）；能写盘的原语只许出现在 writeStateFile 里。
    const readPrimitives = ["readFileSync", "realpathSync", "statSync"];
    const writePrimitives = ["closeSync", "openSync", "renameSync", "writeSync"];
    const nodeFs = /^import \{([^}]*)\} from "node:fs";$/m.exec(source);
    const fsNames = (nodeFs?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .sort();
    expect(fsNames, "node:fs has to be imported by name, and only these names").toEqual([...readPrimitives, ...writePrimitives].sort());

    const writer = functionSource("writeStateFile");
    const outside = source.replace(writer, "").replace(/^import .*$/gm, "");
    for (const name of writePrimitives) expect(outside, `${name} outside writeStateFile`).not.toMatch(new RegExp(`\\b${name}\\b`));
    // writeStateFile 自己：只打开一个文件——临时文件，写模式——写完改名到目标，再没有别的。
    expect(count(writer, /\bopenSync\(/g)).toBe(1);
    expect(count(writer, /\brenameSync\(/g)).toBe(1);
    expect(writer).toMatch(/const temporary = `\$\{file\}[^`]*`;/);
    expect(writer).toMatch(/openSync\(temporary, "w"\)/);
    expect(writer).toMatch(/renameSync\(temporary, file\)/);

    // 只有一处调用，且路径来自 --state：saveState 在没有 --state 时直接返回，options.state 只有 parseArgs 给它赋值。
    expect(count(source, /\bwriteStateFile\b/g), "the declaration and the one call").toBe(2);
    expect(count(source, /(?<!function )\bwriteStateFile\(/g)).toBe(1);
    const saver = functionSource("saveState");
    expect(saver).toMatch(/const file = watcher\.options\.state;\s*if \(!file\) return;/);
    expect(saver).toMatch(/\bwriteStateFile\(resolve\(file\), /);
    expect(count(source, /\boptions\.state\s*=(?!=)/g), "options.state is assigned in one place").toBe(1);
    expect(functionSource("parseArgs")).toMatch(/case "state":[\s\S]*?\boptions\.state = value;/);
  });

  it("is a standalone script: it imports nothing from the repository or from node_modules", () => {
    for (const match of source.matchAll(/^import .* from "([^"]+)";?$/gm)) expect(match[1], match[0]).toMatch(/^node:/);
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(source).not.toContain("\r");
  });

  it("lives in the skill folder, which is part of what gets installed", () => {
    expect(PLUGIN_PAYLOAD).toContain("skills");
    expect(existsSync(scriptPath)).toBe(true);
    expect(existsSync(examplePath)).toBe(true);
  });

  it("is named, with how to run it, in SKILL.md", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("scripts/watch.mjs");
    expect(skill).toContain("scripts/watch.rules.example.json");
    expect(skill).toMatch(/\\\[\(ALERT\|DONE\)\\\]/);
  });

  it("is copied by the installer along with the rest of the skill", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ensemble-watch-install-"));
    const pluginRoot = join(sandbox, "source");
    const put = (relative: string, text: string): void => {
      const target = join(pluginRoot, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    };
    // 与真实插件同构的最小副本：skills 用仓库里的真实内容，其余只放安装器要求存在的文件。
    cpSync(join(root, "skills"), join(pluginRoot, "skills"), { recursive: true });
    put("plugin.json", JSON.stringify({ name: "ensemble" }));
    put("mcp.json", "{}");
    put(".mcp.json", "{}");
    put(join(".cursor-plugin", "plugin.json"), "{}");
    put(join("assets", "logo.svg"), "<svg/>");
    put(join("dist", "ensemble.mjs"), "// bundle");
    put(join("dist", "web", "index.html"), "<html/>");
    put("README.md", "# Ensemble");

    const userHome = join(sandbox, "home");
    const result = await installCursor(defaultDeps({ pluginRoot, userHome, runtimeDir: join(sandbox, "runtime"), version: "0.0.0-test" }), { force: false });
    expect(result.ok, result.lines.join("\n")).toBe(true);

    const installed = join(cursorPluginDir(userHome), "skills", "ensemble-delegate", "scripts");
    expect(readFileSync(join(installed, "watch.mjs"), "utf8")).toBe(source);
    expect(readFileSync(join(installed, "watch.rules.example.json"), "utf8")).toBe(readFileSync(examplePath, "utf8"));
    // 装好的那一份自己能跑。
    const help = spawnSync(process.execPath, [join(installed, "watch.mjs"), "--help"], { encoding: "utf8", windowsHide: true });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: node watch.mjs");
  });
});
