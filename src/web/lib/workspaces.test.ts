import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { translate } from "./i18n";
import {
  buildSwitcherEntries,
  buildWorkspaces,
  parseScope,
  resolveWorkspace,
  serializeScope,
  sessionsInScope,
  stepOriginScope,
  workspaceDisplayTitle,
  workspaceSubtitle,
} from "./workspaces";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

function make(
  id: string,
  originKey: string,
  opts: {
    phase?: SessionPhase;
    createdAt?: string;
    updatedAt?: string;
    parentSessionId?: string;
    workspace?: string;
    hostTitle?: string;
    title?: string;
    host?: "cursor" | "codex" | "console";
  } = {},
): SessionSummary {
  const log = new EventLog(id);
  const host = opts.host ?? "cursor";
  log.created({
    id,
    title: opts.title ?? id,
    harness: "cursor",
    createdAt: opts.createdAt ?? "2026-11-16T10:00:00.000Z",
    origin: testOrigin({
      key: originKey,
      kind: host === "console" ? "user" : "agent",
      host,
      hostLabel: host === "console" ? "Ensemble" : host === "codex" ? "Codex" : "Cursor",
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      ...(opts.hostTitle ? { hostTitle: opts.hostTitle } : {}),
    }),
    ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
  });
  const base = toSummary(replay(log.events)!);
  return {
    ...base,
    phase: opts.phase ?? "done",
    updatedAt: opts.updatedAt ?? opts.createdAt ?? base.updatedAt,
  };
}

describe("workspaces（按 Main Agent 隔离的工作空间聚合与切换）", () => {
  it("按根来源聚合会话（嵌套子会话归到根 Main Agent），并按 running > attention > working > 最新活跃排序", () => {
    const sDone = make("ses_1", "cursor:a", { phase: "done", updatedAt: "2026-11-16T12:00:00.000Z", hostTitle: "旧任务" });
    const sRunParent = make("ses_2", "codex:b", { phase: "done", updatedAt: "2026-11-16T09:00:00.000Z", hostTitle: "进行中任务", host: "codex", workspace: "C:\\repo" });
    const sRunChild = make("ses_3", "pi:nested", { phase: "running", updatedAt: "2026-11-16T09:05:00.000Z", parentSessionId: "ses_2" });
    const sReady = make("ses_4", "cursor:c", { phase: "ready", updatedAt: "2026-11-16T11:00:00.000Z", hostTitle: "待命任务" });

    const workspaces = buildWorkspaces([sDone, sRunParent, sRunChild, sReady]);
    expect(workspaces.map((w) => w.key)).toEqual(["codex:b", "cursor:c", "cursor:a"]);
    // 嵌套子会话算在根来源名下，不会多出一个 pi:nested 空间
    expect(workspaces[0]!.total).toBe(2);
    expect(workspaces[0]!.running).toBe(1);
    expect(workspaces[0]!.hostTitle).toBe("进行中任务");
    expect(workspaces[0]!.workspace).toBe("C:\\repo");
  });

  it("resolveWorkspace：首次打开默认进入最活跃/最近的单个 Main Agent，不把全部历史混在一起", () => {
    const list = [
      make("ses_1", "cursor:old", { phase: "done", updatedAt: "2026-11-15T10:00:00.000Z" }),
      make("ses_2", "cursor:live", { phase: "running", updatedAt: "2026-11-16T10:00:00.000Z" }),
    ];
    const ws = buildWorkspaces(list);

    expect(resolveWorkspace(undefined, undefined, ws)).toEqual({ kind: "origin", key: "cursor:live" });
    expect(resolveWorkspace(undefined, { kind: "origin", key: "cursor:old" }, ws)).toEqual({ kind: "origin", key: "cursor:old" });
    expect(resolveWorkspace({ kind: "active" }, { kind: "origin", key: "cursor:old" }, ws)).toEqual({ kind: "active" });
    // 上次记住的空间已被删除时，自动落回排在第一位的空间
    expect(resolveWorkspace(undefined, { kind: "origin", key: "cursor:gone" }, ws)).toEqual({ kind: "origin", key: "cursor:live" });
    expect(resolveWorkspace(undefined, undefined, [])).toEqual({ kind: "all" });
  });

  it("sessionsInScope：单 Main Agent 空间只包含该树，active 只包含工作中会话及其祖先链", () => {
    const a1 = make("ses_a1", "cursor:a", { phase: "done" });
    const a2 = make("ses_a2", "pi:sub", { phase: "running", parentSessionId: "ses_a1" });
    const b1 = make("ses_b1", "cursor:b", { phase: "done" });
    const all = [a1, a2, b1];

    expect(sessionsInScope(all, { kind: "origin", key: "cursor:a" }).map((s) => s.id)).toEqual(["ses_a1", "ses_a2"]);
    expect(sessionsInScope(all, { kind: "origin", key: "cursor:b" }).map((s) => s.id)).toEqual(["ses_b1"]);
    expect(sessionsInScope(all, { kind: "active" }).map((s) => s.id)).toEqual(["ses_a1", "ses_a2"]);
    expect(sessionsInScope(all, { kind: "all" }).map((s) => s.id)).toEqual(["ses_a1", "ses_a2", "ses_b1"]);
  });

  it("stepOriginScope：支持 `[` / `]` 在多个 Main Agent 之间循环切换", () => {
    const ws = buildWorkspaces([
      make("s1", "cursor:1", { updatedAt: "2026-11-16T12:00:00.000Z" }),
      make("s2", "cursor:2", { updatedAt: "2026-11-16T11:00:00.000Z" }),
      make("s3", "cursor:3", { updatedAt: "2026-11-16T10:00:00.000Z" }),
    ]);
    expect(stepOriginScope(ws, { kind: "origin", key: "cursor:1" }, 1)).toEqual({ kind: "origin", key: "cursor:2" });
    expect(stepOriginScope(ws, { kind: "origin", key: "cursor:1" }, -1)).toEqual({ kind: "origin", key: "cursor:3" });
    expect(stepOriginScope(ws, { kind: "active" }, 1)).toEqual({ kind: "origin", key: "cursor:1" });
  });

  it("buildSwitcherEntries：无搜索词时按 MRU 将刚离开的 Main Agent 排最前（类 Alt+Tab），有搜索词时跨标题/目录/分支/会话匹配", () => {
    const sessions = [
      make("s1", "cursor:a", { title: "重构样式", hostTitle: "界面改版", workspace: "C:\\Desktop\\Ensemble", updatedAt: "2026-11-16T12:00:00.000Z" }),
      make("s2", "cursor:b", { title: "排查接口", hostTitle: "修 DSH 取消", workspace: "C:\\Desktop\\Other", phase: "running", updatedAt: "2026-11-16T11:00:00.000Z" }),
      make("s3", "cursor:c", { title: "写测试", hostTitle: "补充单测", updatedAt: "2026-11-16T10:00:00.000Z" }),
    ];
    const ws = buildWorkspaces(sessions);
    const branches = new Map([["cursor:a", "feat/ui"], ["cursor:b", "fix/dsh"]]);

    // 当前在 cursor:a，刚离开的是 cursor:c → cursor:c 应排第一项，方便 ⌘K + Enter 一键往返！
    const mru = buildSwitcherEntries({
      query: "",
      workspaces: ws,
      sessions,
      currentScope: { kind: "origin", key: "cursor:a" },
      recentOrigins: ["cursor:a", "cursor:c", "cursor:b"],
      branches,
      t,
    });
    const wsEntries = mru.filter((e) => e.kind === "workspace");
    expect(wsEntries.map((e) => e.item.key)).toEqual(["cursor:c", "cursor:b", "cursor:a"]);
    expect(wsEntries[0]!.recent).toBe(true);

    // 搜索分支名
    const byBranch = buildSwitcherEntries({
      query: "fix/dsh",
      workspaces: ws,
      sessions,
      currentScope: { kind: "origin", key: "cursor:a" },
      recentOrigins: [],
      branches,
      t,
    });
    expect(byBranch.some((e) => e.kind === "workspace" && e.item.key === "cursor:b")).toBe(true);
  });

  it("serializeScope / parseScope 往返一致，displayTitle 与 subtitle 不重复且能区分无标题同目录来源", () => {
    for (const scope of [{ kind: "active" } as const, { kind: "all" } as const, { kind: "origin", key: "cursor:abc:123" } as const]) {
      expect(parseScope(serializeScope(scope))).toEqual(scope);
    }
    const ws = buildWorkspaces([
      make("s1", "console:ensemble", { host: "console", createdAt: "2026-11-16T02:15:00.000Z" }),
      make("s2", "cursor:dir", { workspace: "C:\\Users\\alice\\Desktop\\Ensemble", createdAt: "2026-11-16T06:30:00.000Z" }),
      make("s3", "cursor:named", { hostTitle: "审查代码", workspace: "C:\\Users\\alice\\Desktop\\Ensemble", createdAt: "2026-11-16T08:00:00.000Z" }),
    ]);
    const userWs = ws.find((w) => w.key === "console:ensemble")!;
    const unnamedWs = ws.find((w) => w.key === "cursor:dir")!;
    const namedWs = ws.find((w) => w.key === "cursor:named")!;
    expect(workspaceDisplayTitle(userWs, t)).toBe("你（控制台）");
    // testOrigin 默认带 sessionRef（thr_test…），优先展示 宿主 · 短会话标识；副行展示真实首次委派时刻与目录，绝不重复
    expect(workspaceDisplayTitle(unnamedWs, t)).toBe("Cursor · thr_test");
    expect(workspaceSubtitle(unnamedWs, "zh")).toMatch(/2026-11-16/);
    expect(workspaceSubtitle(unnamedWs, "zh")).toContain("Ensemble");
    // 无 sessionRef 时回退到 宿主 · 目录名，副行只展示首次委派时刻
    const noRef = { ...unnamedWs, origin: { ...unnamedWs.origin, sessionRef: undefined } };
    expect(workspaceDisplayTitle(noRef, t)).toBe("Cursor · Ensemble");
    expect(workspaceSubtitle(noRef, "zh")).not.toContain("Ensemble");
    // 有宿主标题时副行展示目录与分支
    expect(workspaceDisplayTitle(namedWs, t)).toBe("审查代码");
    expect(workspaceSubtitle(namedWs, "zh", "main")).toBe("Ensemble · main");
  });
});
