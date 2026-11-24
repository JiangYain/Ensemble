import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV } from "@shared/constants";
import { candidateBinaries, resolveOpenCode } from "./opencode-launch";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-oc-launch-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EXE = process.platform === "win32" ? "opencode.exe" : "opencode";

/** 一个只回答 --version 的假入口（JS 文件由 node 运行，所以在任何平台都能跑）。 */
function fakeEntry(dir: string, output: string, exitCode = 0): string {
  const path = join(dir, "fake-opencode.mjs");
  // 不调用 process.exit：Windows 上管道输出是异步的，立刻退出会把刚写的版本号截掉。
  writeFileSync(path, `process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exitCode};\n`);
  return path;
}

describe("opencode candidate locations", () => {
  it("lists PATH first, then npm global platform packages (full build before baseline, placeholder last), then installer dirs", () => {
    const appData = tempDir();
    const pathDir = tempDir();
    const pkg = join(appData, "npm", "node_modules", "@opencode", "cli");
    for (const name of ["cli-windows-x64-baseline", "cli-windows-x64"]) mkdirSync(join(pkg, "node_modules", "@opencode", name, "bin"), { recursive: true });
    const home = tempDir();
    const list = candidateBinaries({ PATH: pathDir, APPDATA: appData, USERPROFILE: home }, "win32");
    const platform = (name: string) => join(pkg, "node_modules", "@opencode", name, "bin", "opencode.exe");
    expect(list.slice(0, 4)).toEqual([join(pathDir, "opencode.exe"), platform("cli-windows-x64"), platform("cli-windows-x64-baseline"), join(pkg, "bin", "opencode.exe")]);
    expect(list).toContain(join(home, ".opencode", "bin", "opencode.exe"));
    expect(new Set(list).size).toBe(list.length);
  });

  it("finds npm global packages even when the service PATH does not include the npm directory", () => {
    const appData = tempDir();
    const pkg = join(appData, "npm", "node_modules", "@opencode", "cli");
    mkdirSync(join(pkg, "node_modules", "@opencode", "cli-windows-x64-baseline", "bin"), { recursive: true });
    const list = candidateBinaries({ PATH: tempDir(), APPDATA: appData, USERPROFILE: tempDir() }, "win32");
    expect(list.some((path) => path.includes("cli-windows-x64-baseline"))).toBe(true);
  });
});

describe("resolving a runnable opencode", () => {
  it("accepts a working 2.x entry and reports its version", async () => {
    const entry = fakeEntry(tempDir(), "opencode v2.3.0\n");
    const result = await resolveOpenCode({ ...process.env }, entry);
    expect(result).toMatchObject({ ok: true, launch: { command: process.execPath, prefix: [entry], version: "2.3.0" } });
  });

  it("refuses a 1.x opencode and says which version it found", async () => {
    const entry = fakeEntry(tempDir(), "1.14.2\n");
    expect(await resolveOpenCode({ ...process.env }, entry)).toEqual({ ok: false, reason: "unsupported", version: "1.14.2", path: entry });
  });

  it("does not fall back to other locations when the configured path is missing or does not run", async () => {
    const missing = join(tempDir(), "nope.mjs");
    expect(await resolveOpenCode({ ...process.env }, missing)).toEqual({ ok: false, reason: "configured_unusable", path: missing });
    const broken = fakeEntry(tempDir(), "boom", 1);
    expect(await resolveOpenCode({ ...process.env }, broken)).toEqual({ ok: false, reason: "configured_unusable", path: broken });
  });

  it("reads the override from ENSEMBLE_OPENCODE_BIN", async () => {
    const entry = fakeEntry(tempDir(), "opencode v2.9.1\n");
    const result = await resolveOpenCode({ ...process.env, [ENV.opencodeBin]: entry });
    expect(result).toMatchObject({ ok: true, launch: { version: "2.9.1" } });
  });

  it("skips placeholder or truncated binaries and keeps looking", async () => {
    const bad = tempDir();
    writeFileSync(join(bad, EXE), "this is not an executable".repeat(9));
    const good = tempDir();
    copyFileSync(process.execPath, join(good, EXE)); // node 自己也会回答 --version，足以验证“跳过坏的、用好的”
    const env = { PATH: [bad, good].join(delimiter), APPDATA: tempDir(), USERPROFILE: tempDir(), HOME: tempDir() };
    const result = await resolveOpenCode(env);
    expect(result).toMatchObject({ ok: true, launch: { command: join(good, EXE), prefix: [] } });
    // 这里要复制约 80 MB 的 node 再首次执行它：杀毒首次扫描、多个会话同时占着机器时，默认的 9 秒不够（实测过 11 秒）。
  }, 30_000);

  it("serves a cached result until a fresh probe asks again, so an in-place upgrade shows up", async () => {
    const entry = fakeEntry(tempDir(), "opencode v2.3.0\n");
    const env = { ...process.env };
    expect(await resolveOpenCode(env, entry)).toMatchObject({ launch: { version: "2.3.0" } });
    writeFileSync(entry, `process.stdout.write("opencode v2.5.0\\n");\n`);
    expect(await resolveOpenCode(env, entry)).toMatchObject({ launch: { version: "2.3.0" } });
    expect(await resolveOpenCode(env, entry, { fresh: true })).toMatchObject({ launch: { version: "2.5.0" } });
    expect(await resolveOpenCode(env, entry)).toMatchObject({ launch: { version: "2.5.0" } });
  });

  it("reports not_found when nothing runnable exists anywhere", async () => {
    const bad = tempDir();
    writeFileSync(join(bad, EXE), "stub".repeat(50));
    const env = { PATH: bad, APPDATA: tempDir(), USERPROFILE: tempDir(), HOME: tempDir() };
    expect(await resolveOpenCode(env)).toEqual({ ok: false, reason: "not_found" });
  });
});
