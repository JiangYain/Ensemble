/**
 * scripts/notices.mjs：生成 dist/THIRD-PARTY-NOTICES.txt 的逻辑。
 * 用临时目录里的假项目驱动，不依赖真实的 node_modules。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Found {
  name: string;
  dir: string;
}
interface Collected {
  name: string;
  version: string;
  license: string;
  source: string | undefined;
  text: string;
  fromUpstream: boolean;
}
interface Notices {
  packageOfModule(root: string, file: string): Found | undefined;
  collectPackages(root: string, files: string[]): Collected[];
  writeThirdPartyNotices(options: { root: string; serverFiles: string[]; webFiles: string[]; outFile?: string }): { file: string; packages: number };
}

const notices = (await import(pathToFileURL(join(repoRoot, "scripts", "notices.mjs")).href)) as Notices;

let root: string;

function put(relative: string, text: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function installPackage(name: string, manifest: Record<string, unknown>, licenseText?: string): void {
  put(join("node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  if (licenseText !== undefined) put(join("node_modules", ...name.split("/"), "LICENSE"), licenseText);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ensemble-notices-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("packageOfModule", () => {
  it("maps relative (esbuild) and absolute (Rollup) paths of any separator style to their package", () => {
    expect(notices.packageOfModule(root, "node_modules/zod/v4/core/index.js")).toEqual({ name: "zod", dir: resolve(root, "node_modules", "zod") });
    expect(notices.packageOfModule(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js")).toEqual({
      name: "@modelcontextprotocol/sdk",
      dir: resolve(root, "node_modules", "@modelcontextprotocol", "sdk"),
    });
    expect(notices.packageOfModule(root, "node_modules\\ajv\\dist\\ajv.js")).toEqual({ name: "ajv", dir: resolve(root, "node_modules", "ajv") });
    const absolute = join(root, "node_modules", "react", "index.js");
    expect(notices.packageOfModule(root, absolute)).toEqual({ name: "react", dir: resolve(root, "node_modules", "react") });
    expect(notices.packageOfModule(root, absolute.replaceAll("\\", "/"))).toEqual({ name: "react", dir: resolve(root, "node_modules", "react") });
  });

  it("attributes a file inside a nested node_modules to the innermost package", () => {
    expect(notices.packageOfModule(root, "node_modules/a/node_modules/@s/b/lib/x.js")).toEqual({
      name: "@s/b",
      dir: resolve(root, "node_modules", "a", "node_modules", "@s", "b"),
    });
  });

  it("ignores our own sources, vendored code and modules the bundler injects", () => {
    expect(notices.packageOfModule(root, "src/server/service.ts")).toBeUndefined();
    expect(notices.packageOfModule(root, "vendor/mosoo-agent-driver/src/index.ts")).toBeUndefined();
    expect(notices.packageOfModule(root, "\0vite/modulepreload-polyfill.js")).toBeUndefined();
    expect(notices.packageOfModule(root, "\0C:/p/node_modules/react/index.js?commonjs-module")).toBeUndefined();
    expect(notices.packageOfModule(root, "node_modules/@scope")).toBeUndefined();
  });
});

describe("collectPackages", () => {
  it("lists each package once, sorted by name, with the licence text it ships", () => {
    installPackage("zeta", { license: "MIT", homepage: "https://zeta.example" }, "MIT License\r\n\r\nCopyright (c) Zeta\r\n");
    installPackage("@scope/alpha", { version: "2.3.4", license: "ISC", repository: { type: "git", url: "git+https://github.com/scope/alpha.git" } }, "ISC License\n\nCopyright (c) Alpha");
    const found = notices.collectPackages(root, ["node_modules/zeta/a.js", "node_modules/zeta/b.js", "node_modules/@scope/alpha/index.js", "src/own.ts"]);
    expect(found.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(["@scope/alpha@2.3.4", "zeta@1.0.0"]);
    expect(found[0]).toMatchObject({ license: "ISC", source: "https://github.com/scope/alpha", text: "ISC License\n\nCopyright (c) Alpha", fromUpstream: false });
    expect(found[1]).toMatchObject({ license: "MIT", source: "https://zeta.example", text: "MIT License\n\nCopyright (c) Zeta", fromUpstream: false });
  });

  it("falls back to a licence text kept in scripts/third-party/, and says so", () => {
    installPackage("nolicense", { license: "MIT" });
    put(join("scripts", "third-party", "nolicense.LICENSE"), "MIT License\n\nCopyright (c) Upstream\n");
    const [pkg] = notices.collectPackages(root, ["node_modules/nolicense/index.js"]);
    expect(pkg).toMatchObject({ name: "nolicense", text: "MIT License\n\nCopyright (c) Upstream", fromUpstream: true });
  });

  it("fails the build rather than ship a bundled package without a licence text", () => {
    installPackage("nolicense", { license: "MIT" });
    expect(() => notices.collectPackages(root, ["node_modules/nolicense/index.js"])).toThrow(/nolicense@1\.0\.0.*scripts\/third-party/s);
  });

  it("fails on a licence outside the allow-list and on a package that declares none", () => {
    installPackage("copyleft", { license: "GPL-3.0-only" }, "GNU GENERAL PUBLIC LICENSE");
    expect(() => notices.collectPackages(root, ["node_modules/copyleft/index.js"])).toThrow(/GPL-3\.0-only.*放行名单/s);
    installPackage("undeclared", {}, "something");
    expect(() => notices.collectPackages(root, ["node_modules/undeclared/index.js"])).toThrow(/没有声明许可证/);
  });

  it("accepts an OR expression only when every alternative is allowed", () => {
    installPackage("dual", { license: "(MIT OR Apache-2.0)" }, "dual licence text");
    expect(notices.collectPackages(root, ["node_modules/dual/index.js"])).toHaveLength(1);
    installPackage("risky", { license: "(MIT OR GPL-2.0)" }, "risky licence text");
    expect(() => notices.collectPackages(root, ["node_modules/risky/index.js"])).toThrow(/放行名单/);
  });
});

describe("writeThirdPartyNotices", () => {
  it("writes the repository NOTICE, every bundled package and the licence texts, deterministically", () => {
    installPackage("server-dep", { license: "MIT" }, "MIT License\n\nCopyright (c) Server");
    installPackage("web-dep", { license: "MIT" }, "MIT License\n\nCopyright (c) Web");
    put("NOTICE", "Ensemble notice line\n");
    put(join("vendor", "mosoo-agent-driver", "LICENSE.txt"), "Apache License fixture\nTERMS AND CONDITIONS\n");
    put(join("src", "web", "fonts", "LICENSE.txt"), "SIL OPEN FONT LICENSE fixture (Inter, JetBrains Mono)\n");
    put(join("src", "web", "public", "licenses", "CORMORANT-OFL.txt"), "SIL OPEN FONT LICENSE fixture (Cormorant)\n");
    mkdirSync(join(root, "dist"), { recursive: true });

    const options = { root, serverFiles: ["node_modules/server-dep/index.js"], webFiles: [join(root, "node_modules", "web-dep", "index.js"), "\0virtual"] };
    const first = notices.writeThirdPartyNotices(options);
    const text = readFileSync(first.file, "utf8");
    expect(first).toEqual({ file: join(root, "dist", "THIRD-PARTY-NOTICES.txt"), packages: 2 });

    const order = ["Ensemble notice line", "2. npm packages bundled into dist/ensemble.mjs", "server-dep 1.0.0", "3. npm packages bundled into dist/web/", "web-dep 1.0.0", "Apache License fixture", "(Inter, JetBrains Mono)", "(Cormorant)"];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next, marker).toBeGreaterThan(at);
      at = next;
    }
    expect(text).toContain("Copyright (c) Server");
    expect(text).toContain("Copyright (c) Web");
    expect(text).not.toMatch(/\r|\0/);
    expect(text.endsWith("\n") && !text.endsWith("\n\n")).toBe(true);

    writeFileSync(first.file, "stale", "utf8");
    notices.writeThirdPartyNotices(options);
    expect(readFileSync(first.file, "utf8")).toBe(text);
  });
});
