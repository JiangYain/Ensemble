import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { testOrigin } from "@shared/testing";
import { reconcileLegacyWorkspace } from "./legacy-origin";

// 这些都是纯字符串判断，不访问磁盘：目录只是写在请求里的字符串。
const HOME = join(tmpdir(), "legacy-origin-home");
const PROJECT = join(tmpdir(), "legacy-origin-project");
const origin = (extra: object = {}) => testOrigin({ host: "cursor", hostLabel: "Cursor", key: "cursor:bridge-old", ...extra });

describe("reconcileLegacyWorkspace", () => {
  it("replaces the home directory an older bridge recorded (its own start directory) with the cwd of the delegation, and says where that came from", () => {
    const before = origin({ workspace: HOME });
    const after = reconcileLegacyWorkspace(before, PROJECT, HOME);
    expect(after).toMatchObject({ workspace: PROJECT, workspaceSource: "delegate-cwd", key: "cursor:bridge-old", host: "cursor" });
    // 不改传进来的对象。
    expect(before.workspace).toBe(HOME);
    expect(before).not.toHaveProperty("workspaceSource");
  });

  it("recognises the home directory however it is written: trailing separator, and case where the file system ignores it", () => {
    expect(reconcileLegacyWorkspace(origin({ workspace: `${HOME}${sep}` }), PROJECT, HOME).workspace).toBe(PROJECT);
    const insensitive = process.platform === "win32" || process.platform === "darwin";
    expect(reconcileLegacyWorkspace(origin({ workspace: HOME.toUpperCase() }), PROJECT, HOME).workspace).toBe(insensitive ? PROJECT : HOME.toUpperCase());
  });

  it("changes nothing when the origin already names where its workspace came from", () => {
    for (const workspaceSource of ["mcp-roots", "delegate-cwd", "host-record"] as const) {
      const given = origin({ workspace: HOME, workspaceSource });
      expect(reconcileLegacyWorkspace(given, PROJECT, HOME)).toBe(given);
    }
  });

  it("changes nothing when the directory is not the home directory: a project, or a folder inside it", () => {
    for (const workspace of [PROJECT, join(HOME, "project"), join(tmpdir(), "legacy-origin-other")]) {
      const given = origin({ workspace });
      expect(reconcileLegacyWorkspace(given, join(tmpdir(), "somewhere-else"), HOME)).toBe(given);
    }
  });

  it("changes nothing when there is no directory, or the delegation passed no usable cwd, or it is the same directory", () => {
    const none = origin();
    expect(reconcileLegacyWorkspace(none, PROJECT, HOME)).toBe(none);

    const inHome = origin({ workspace: HOME });
    // 相对路径不是目录；与来源目录相同的 cwd 没有可换的。
    expect(reconcileLegacyWorkspace(inHome, "relative/project", HOME)).toBe(inHome);
    expect(reconcileLegacyWorkspace(inHome, HOME, HOME)).toBe(inHome);
    expect(reconcileLegacyWorkspace(inHome, `${HOME}${sep}`, HOME)).toBe(inHome);

    const relative = origin({ workspace: "relative/home" });
    expect(reconcileLegacyWorkspace(relative, PROJECT, HOME)).toBe(relative);
  });

  it("uses the current user's home directory by default", () => {
    expect(reconcileLegacyWorkspace(origin({ workspace: homedir() }), PROJECT).workspace).toBe(PROJECT);
  });
});
