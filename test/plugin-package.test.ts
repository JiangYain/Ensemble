/**
 * 校验插件包本身：manifest、MCP 配置、Skill、资源文件与版本一致性。
 *
 * test/fixtures/agent-plugins/ 下的两份 JSON Schema 是 Agent Plugins 1.0.0 官方发布的原文，
 * 取自 https://agent-plugins.org/schemas/1.0.0/{plugin,mcp}.schema.json（2026-11-07）。
 * 校验时不联网（规范同样要求客户端加载插件时不得联网取 schema）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EnsembleBridge } from "../src/mcp/bridge";
import { PLUGIN_PAYLOAD } from "../src/cli/install";
import { pathsFor } from "../src/server/paths";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test", "fixtures", "agent-plugins");

function readJson<T = Record<string, any>>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(root, ...parts), "utf8").replace(/^\uFEFF/, "")) as T;
}

// ajv 是 CommonJS，不同打包器对默认导出的处理不一样。
const AjvClass = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020) as typeof Ajv2020;

function validators() {
  const ajv = new AjvClass({ allErrors: true, strict: true });
  const pluginSchema = JSON.parse(readFileSync(join(fixtures, "plugin.schema.json"), "utf8")) as { $id: string };
  const mcpSchema = JSON.parse(readFileSync(join(fixtures, "mcp.schema.json"), "utf8")) as { $id: string };
  ajv.addSchema(pluginSchema);
  ajv.addSchema(mcpSchema);
  const plugin = ajv.getSchema(pluginSchema.$id);
  const mcp = ajv.getSchema(mcpSchema.$id);
  const server = ajv.getSchema(`${mcpSchema.$id}#/$defs/server`);
  if (!plugin || !mcp || !server) throw new Error("official schemas failed to compile");
  return { plugin, mcp, server, ajv };
}

const pluginManifest = readJson("plugin.json");
const mcpConfig = readJson("mcp.json");
const pkg = readJson("package.json");

function errorsOf(validate: { errors?: unknown }): string {
  return JSON.stringify(validate.errors, null, 2);
}

describe("Agent Plugins manifest (plugin.json)", () => {
  it("is valid against the official 1.0.0 schema", () => {
    const { plugin } = validators();
    expect(plugin(pluginManifest), errorsOf(plugin)).toBe(true);
  });

  it("is not vacuous: the validator rejects unknown fields and bad names", () => {
    const { plugin } = validators();
    expect(plugin({ ...pluginManifest, skills: "./skills/" })).toBe(false);
    expect(plugin({ ...pluginManifest, name: "Ensemble" })).toBe(false);
    expect(plugin({ ...pluginManifest, $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json" })).toBe(false);
  });

  it("keeps the version in step with package.json", () => {
    expect(pluginManifest["version"]).toBe(pkg["version"]);
  });

  it("describes the plugin for Codex with assets that exist", () => {
    const meta = pluginManifest["extensions"]["com.openai"]["interface"] as Record<string, unknown>;
    expect(meta["displayName"]).toBe("Ensemble");
    for (const key of ["composerIcon", "logo"] as const) {
      const rel = meta[key] as string;
      expect(rel.startsWith("./assets/"), key).toBe(true);
      expect(existsSync(join(root, rel)), `${key} → ${rel}`).toBe(true);
    }
    expect(Array.isArray(meta["defaultPrompt"])).toBe(true);
    expect((meta["defaultPrompt"] as string[]).length).toBeGreaterThan(0);
    expect(String(meta["brandColor"])).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("Agent Plugins MCP configuration (mcp.json)", () => {
  it("is valid against the official 1.0.0 schema, as a whole and per server", () => {
    const { mcp, server } = validators();
    expect(mcp(mcpConfig), errorsOf(mcp)).toBe(true);
    for (const [name, entry] of Object.entries(mcpConfig["mcpServers"] as Record<string, unknown>)) {
      expect(server(entry), `${name}: ${errorsOf(server)}`).toBe(true);
    }
  });

  it("is not vacuous: the validator rejects a shell command string and a reserved env name", () => {
    const { server } = validators();
    expect(server({ type: "stdio", command: "node dist/x.mjs" })).toBe(true); // 形状合法；语义由下面的测试约束
    expect(server({ type: "stdio" })).toBe(false);
    expect(server({ type: "stdio", command: "node", env: { PLUGIN_ROOT: "x" } })).toBe(false);
    expect(server({ type: "stdio", command: "node", cwd: "../escape" })).toBe(false);
  });

  it("targets the same Agent Plugins version as plugin.json", () => {
    const version = (schemaId: string): string | undefined => /\/schemas\/([^/]+)\//.exec(schemaId)?.[1];
    expect(version(mcpConfig["$schema"])).toBe(version(pluginManifest["$schema"]));
  });

  it("launches the bundled entry as a single executable token with only the two defined placeholders", () => {
    const servers = mcpConfig["mcpServers"] as Record<string, { type: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }>;
    const ensemble = servers["ensemble"];
    expect(ensemble).toBeDefined();
    expect(ensemble?.type).toBe("stdio");
    expect(ensemble?.command).toMatch(/^[A-Za-z0-9._-]+$|^\.\/[^\s]+$/); // 裸命令名或 ./ 开头的插件内路径，不是 shell 命令串
    const args = ensemble?.args ?? [];
    const placeholders = args.flatMap((arg) => [...arg.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]));
    expect(placeholders.every((name) => name === "PLUGIN_ROOT" || name === "PLUGIN_DATA")).toBe(true);
    // 展开后必须落在插件根内、并且真的存在：宿主不一定以插件根为工作目录，所以入口用占位符定位。
    const entry = args.find((arg) => arg.endsWith(".mjs"));
    expect(entry?.startsWith("${PLUGIN_ROOT}/")).toBe(true);
    const resolved = join(root, (entry ?? "").replace("${PLUGIN_ROOT}/", ""));
    expect(existsSync(resolved), resolved).toBe(true);
    expect(args.at(-1)).toBe("mcp");
  });
});

describe("Cursor-native files", () => {
  const cursorManifest = readJson(".cursor-plugin", "plugin.json");
  const legacyMcp = readJson(".mcp.json");

  it("share name, version and description with the portable manifest", () => {
    expect(cursorManifest["name"]).toBe(pluginManifest["name"]);
    expect(cursorManifest["version"]).toBe(pluginManifest["version"]);
    expect(cursorManifest["description"]).toBe(pluginManifest["description"]);
    expect(String(cursorManifest["name"])).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  });

  it("points at skills and MCP files that exist", () => {
    expect(existsSync(join(root, cursorManifest["skills"]))).toBe(true);
    expect(statSync(join(root, cursorManifest["skills"])).isDirectory()).toBe(true);
    expect(existsSync(join(root, cursorManifest["mcpServers"]))).toBe(true);
    expect(existsSync(join(root, cursorManifest["logo"]))).toBe(true);
  });

  it("defines the same server as mcp.json, differing only in the root variable the host expands", () => {
    const portable = (mcpConfig["mcpServers"] as Record<string, { command: string; args: string[] }>)["ensemble"];
    const legacy = (legacyMcp["mcpServers"] as Record<string, { command: string; args: string[] }>)["ensemble"];
    expect(legacy?.command).toBe(portable?.command);
    expect(legacy?.args.map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}"))).toEqual(portable?.args);
    expect(Object.keys(legacyMcp)).toEqual(["mcpServers"]);
  });
});

describe("Skills", () => {
  const skillsDir = join(root, "skills");
  const skillNames = ["ensemble-delegate"];

  function frontmatter(name: string): { fields: Record<string, string>; body: string } {
    const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) throw new Error(`${name}/SKILL.md has no frontmatter`);
    const fields: Record<string, string> = {};
    for (const line of (match[1] as string).split("\n")) {
      const colon = line.indexOf(": ");
      if (colon < 1) throw new Error(`unsupported frontmatter line: ${line}`);
      fields[line.slice(0, colon)] = line.slice(colon + 2);
    }
    return { fields, body: match[2] as string };
  }

  it.each(skillNames)("%s follows the Agent Skills format", (name) => {
    expect(statSync(join(skillsDir, name, "SKILL.md")).isFile()).toBe(true);
    const { fields } = frontmatter(name);
    expect(fields["name"]).toBe(name);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(fields["description"]?.length ?? 0).toBeGreaterThan(40);
    expect(fields["description"]?.length ?? 0).toBeLessThanOrEqual(1024);
    expect(Object.keys(fields).every((key) => ["name", "description", "license", "compatibility", "metadata", "allowed-tools"].includes(key))).toBe(true);
  });

  it("documents exactly the tools the MCP bridge registers", async () => {
    const bridge = new EnsembleBridge({ paths: pathsFor(join(tmpdir(), "ensemble-package-test-unused")), version: "test" });
    const client = new Client({ name: "package-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
    try {
      const registered = (await client.listTools()).tools.map((tool) => tool.name).sort();
      const { body } = frontmatter("ensemble-delegate");
      const documented = [...body.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1] as string).sort();
      expect(documented).toEqual(registered);
    } finally {
      await client.close();
    }
  });
});

describe("Distributable payload", () => {
  it("contains everything the manifests refer to", () => {
    for (const entry of PLUGIN_PAYLOAD) expect(existsSync(join(root, entry)), entry).toBe(true);
  });

  it("ships a runnable bundle and the built web panel", () => {
    const bundle = readFileSync(join(root, "dist", "ensemble.mjs"), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(existsSync(join(root, "dist", "web", "index.html"))).toBe(true);
  });

  it("keeps the Cursor SDK out of the bundle (its licence forbids redistribution)", () => {
    expect(existsSync(join(root, "dist", "node_modules"))).toBe(false);
    const bundle = readFileSync(join(root, "dist", "ensemble.mjs"), "utf8");
    // 只按包名在运行时加载；真被打进包里的话体积会差一个数量级。
    expect(bundle).toContain('"@cursor/sdk"');
    expect(Buffer.byteLength(bundle)).toBeLessThan(4 * 1024 * 1024);
  });
});

/**
 * npm 包的形状（真正的“打包 → 安装 → 运行”自检在 scripts/check-package.mjs，发布前由 prepublishOnly 运行）。
 * 安装器从“插件根”复制 PLUGIN_PAYLOAD；插件根既可能是仓库，也可能是装在 node_modules 里的这个包，
 * 所以 `files` 必须覆盖安装器要复制的每一项，又不能把源码和测试带进去。
 */
describe("npm package (package.json)", () => {
  const files = pkg["files"] as string[];
  const shipped = new Set(files.map((entry) => entry.replace(/\/$/, "")));

  it("can be published and installed as the `ensemble` command", () => {
    expect(pkg["private"]).not.toBe(true);
    expect(pkg["license"]).toBe("MIT");
    expect(pkg["bin"]).toEqual({ ensemble: "dist/ensemble.mjs" });
    expect(existsSync(join(root, "dist", "ensemble.mjs"))).toBe(true);
    expect(readFileSync(join(root, "dist", "ensemble.mjs"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(String(pkg["engines"]["node"])).toMatch(/^>=22\./);
  });

  it("whitelists everything the installer copies (npm always adds README.md and LICENSE) plus NOTICE", () => {
    for (const entry of PLUGIN_PAYLOAD) {
      if (entry === "README.md" || entry === "LICENSE") continue;
      expect(shipped.has(entry), entry).toBe(true);
    }
    expect(shipped.has("NOTICE")).toBe(true);
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
  });

  it("whitelists only things that exist, and no sources, tests, vendored code, scripts or docs", () => {
    for (const entry of files) {
      expect(existsSync(join(root, entry)), entry).toBe(true);
      expect(entry, entry).not.toMatch(/^(src|test|vendor|scripts|docs|node_modules|\.tmp|\.git)(\/|$)/);
    }
  });

  it("does not make the Cursor SDK a dependency of the package (its licence forbids redistribution)", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
      expect(JSON.stringify(pkg[field] ?? {}), field).not.toContain("@cursor/sdk");
    }
  });
});

describe("Third-party notices (dist/THIRD-PARTY-NOTICES.txt)", () => {
  const text = readFileSync(join(root, "dist", "THIRD-PARTY-NOTICES.txt"), "utf8").replace(/\r\n/g, "\n");

  it("repeats the repository NOTICE and carries the licence texts it points at", () => {
    expect(text).toContain(readFileSync(join(root, "NOTICE"), "utf8").replace(/\r\n/g, "\n").trim());
    expect(text).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"); // Apache-2.0（vendor/mosoo-agent-driver）
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("is in step with the pinned versions of the libraries that get bundled (rebuild with `npm run build` when this fails)", () => {
    const pinned = pkg["devDependencies"] as Record<string, string>;
    for (const name of ["@modelcontextprotocol/sdk", "zod", "ajv", "vestig", "react", "react-dom"]) {
      expect(text, name).toContain(`\n${name} ${pinned[name]}\nLicense: `);
    }
  });

  it("says that the Cursor SDK is not part of the package", () => {
    expect(text).toMatch(/Cursor SDK \(@cursor\/sdk\) is not bundled/);
    expect(text).not.toContain("\n@cursor/sdk 1.");
  });
});
