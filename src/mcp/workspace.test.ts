import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { describeRootsFailure, directoryKey, hostRootsIdentifyConversation, isHomeOrRootDirectory, isPluginInstallDirectory, normalizeHostDirectory } from "./workspace";

const root = mkdtempSync(join(tmpdir(), "ensemble-workspace-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function make(...parts: string[]): string {
  const dir = join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("isPluginInstallDirectory", () => {
  it("宿主的插件缓存目录（路径含 plugins 段且有清单）被识别", () => {
    const dir = make(".codex", "plugins", "cache", "personal", "ensemble", "0.1.0");
    writeFileSync(join(dir, "plugin.json"), "{}");
    expect(isPluginInstallDirectory(dir)).toBe(true);
  });

  it("Cursor / Claude 兼容目录里的清单同样算", () => {
    const cursor = make(".cursor", "plugins", "local", "ensemble");
    mkdirSync(join(cursor, ".cursor-plugin"), { recursive: true });
    writeFileSync(join(cursor, ".cursor-plugin", "plugin.json"), "{}");
    expect(isPluginInstallDirectory(cursor)).toBe(true);

    const claude = make(".claude", "plugins", "ensemble");
    mkdirSync(join(claude, ".claude-plugin"), { recursive: true });
    writeFileSync(join(claude, ".claude-plugin", "plugin.json"), "{}");
    expect(isPluginInstallDirectory(claude)).toBe(true);
  });

  it("正在开发插件的项目（路径里没有 plugins 段）不会被误伤", () => {
    const dir = make("Desktop", "Ensemble");
    writeFileSync(join(dir, "plugin.json"), "{}");
    expect(isPluginInstallDirectory(dir)).toBe(false);
  });

  it("plugins 目录下没有清单的普通项目不算", () => {
    const dir = make("work", "plugins", "my-app");
    expect(isPluginInstallDirectory(dir)).toBe(false);
  });

  it("目录不存在时不算（也不抛错）", () => {
    expect(isPluginInstallDirectory(join(root, "plugins", "missing"))).toBe(false);
  });
});

describe("directoryKey", () => {
  it("末尾斜杠与分隔符写法不同的同一个目录得到同一个键", () => {
    const dir = join(root, "same", "place");
    expect(directoryKey(`${dir}${process.platform === "win32" ? "\\" : "/"}`)).toBe(directoryKey(dir));
    if (process.platform === "win32") expect(directoryKey(dir.replace(/\\/g, "/"))).toBe(directoryKey(dir));
  });

  it("Windows 与 macOS 上不区分大小写，别处区分", () => {
    const dir = join(root, "Case", "Place");
    const insensitive = process.platform === "win32" || process.platform === "darwin";
    expect(directoryKey(dir.toUpperCase()) === directoryKey(dir)).toBe(insensitive);
  });

  it("不同的目录得到不同的键", () => {
    expect(directoryKey(join(root, "a"))).not.toBe(directoryKey(join(root, "b")));
    expect(directoryKey(join(root, "a"))).not.toBe(directoryKey(join(root, "a", "b")));
  });
});

describe("isHomeOrRootDirectory", () => {
  const home = join(root, "Users", "someone");

  it("用户主目录（任何写法）和磁盘根目录算：它们不可能是一个具体的项目", () => {
    expect(isHomeOrRootDirectory(home, home)).toBe(true);
    expect(isHomeOrRootDirectory(`${home}${sep}`, home)).toBe(true);
    expect(isHomeOrRootDirectory(parse(home).root, home)).toBe(true);
    if (process.platform === "win32" || process.platform === "darwin") expect(isHomeOrRootDirectory(home.toUpperCase(), home)).toBe(true);
  });

  it("项目目录不算，哪怕它就在主目录里面", () => {
    expect(isHomeOrRootDirectory(join(home, "project"), home)).toBe(false);
    expect(isHomeOrRootDirectory(join(home, "Desktop", "Ensemble"), home)).toBe(false);
    expect(isHomeOrRootDirectory(root, home)).toBe(false);
  });

  it("默认的主目录是当前用户的 homedir()", () => {
    expect(isHomeOrRootDirectory(homedir())).toBe(true);
    expect(isHomeOrRootDirectory(join(homedir(), "some-project-that-is-not-home"))).toBe(false);
  });
});

describe("hostRootsIdentifyConversation", () => {
  it("只有 Cursor 不算：它的一个桥被所有窗口共用，roots 是它们的并集；其余宿主照旧采信", () => {
    expect(hostRootsIdentifyConversation("cursor")).toBe(false);
    for (const host of ["codex", "claude", "pi", "vscode", "console", "unknown"] as const) expect(hostRootsIdentifyConversation(host), host).toBe(true);
  });
});

describe("normalizeHostDirectory", () => {
  const dir = join(root, "project");
  const upperDrive = (path: string): string => (process.platform === "win32" ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : path);

  it("本机的绝对路径，写成与 cwd 一致的样子：末尾分隔符与 .. 段被规整", () => {
    expect(normalizeHostDirectory(dir)).toBe(upperDrive(dir));
    expect(normalizeHostDirectory(`${dir}${sep}`)).toBe(upperDrive(dir));
    expect(normalizeHostDirectory(`${dir}${sep}sub${sep}..`)).toBe(upperDrive(dir));
  });

  it("不是路径、不是绝对路径、含空字符、超过 HTTP 校验长度上限的一律不要", () => {
    for (const raw of [undefined, null, 42, {}, [], "", "project", "./project", "../project", `${dir}\0x`, join(dir, "x".repeat(2_100))]) {
      expect(normalizeHostDirectory(raw), String(raw)).toBeUndefined();
    }
  });

  it("Windows：盘符统一成大写（VS Code 系的 fsPath 是小写），正斜杠也认，UNC 保留；没有盘符的根路径与盘符相对路径不要", () => {
    if (process.platform !== "win32") return;
    expect(normalizeHostDirectory("c:\\Users\\alice\\Desktop\\Ensemble")).toBe("C:\\Users\\alice\\Desktop\\Ensemble");
    expect(normalizeHostDirectory("c:/Users/alice/Desktop/Ensemble/")).toBe("C:\\Users\\alice\\Desktop\\Ensemble");
    expect(normalizeHostDirectory("\\\\server\\share\\folder")).toBe("\\\\server\\share\\folder");
    expect(normalizeHostDirectory("\\Users\\alice")).toBeUndefined();
    expect(normalizeHostDirectory("C:Users")).toBeUndefined();
  });
});

describe("describeRootsFailure", () => {
  it("从 MCP SDK 真实的校验错误里数出没通过的条数与 uri 不是 file:// 的条数，不带任何路径", () => {
    // Cursor 的应答就是这个形状：uri 是普通路径。第二项合格，不该被数进去。
    const parsed = ListRootsResultSchema.safeParse({
      roots: [{ uri: "C:\\work\\project-a", name: "a" }, { uri: "file:///c%3A/work/ok", name: "b" }, { uri: "/home/me/secret-client-project" }],
    });
    expect(parsed.success).toBe(false);
    const described = describeRootsFailure(parsed.error);
    expect(described).toEqual({ invalidEntries: 2, notFileUri: 2 });
    expect(JSON.stringify(described)).not.toContain("secret-client-project");
  });

  it("同一项里有几个字段不合格也只算一项；类型错误之类不算进 notFileUri", () => {
    const parsed = ListRootsResultSchema.safeParse({ roots: [{ uri: 7, name: 3 }] });
    expect(describeRootsFailure(parsed.error)).toEqual({ invalidEntries: 1 });
  });

  it("认不出形状的错误（超时、别的异常、被改过的结构）返回空对象，不抛错", () => {
    for (const error of [new Error("roots/list timed out"), undefined, null, "boom", { issues: "no" }, { issues: [null, 3, { path: "x" }] }]) {
      expect(describeRootsFailure(error)).toEqual({});
    }
  });
});
