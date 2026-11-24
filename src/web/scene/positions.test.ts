import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPositions, savePositions } from "./positions";

const KEY = "ensemble.canvas.positions.v1";

describe("画布节点位置", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("四类节点（会话、来源、Git、Folder）的位置都会读回；别的前缀与不合法的值被忽略", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "agent:a": { x: 1, y: 2 },
        "origin:o": { x: 3, y: 4 },
        "git:c:/repo": { x: 5, y: 6 },
        "folder:c:/repo": { x: 7, y: 8 },
        "other:x": { x: 9, y: 9 },
        "folder:bad": { x: "1", y: 2 },
        "folder:huge": { x: 1e9, y: 0 },
        "folder:null": null,
      }),
    );
    expect([...readPositions()]).toEqual([
      ["agent:a", { x: 1, y: 2 }],
      ["origin:o", { x: 3, y: 4 }],
      ["git:c:/repo", { x: 5, y: 6 }],
      ["folder:c:/repo", { x: 7, y: 8 }],
    ]);
  });

  it("保存后原样读回，包括 Folder 节点；没有位置时清掉整条记录", () => {
    savePositions(new Map([["folder:c:/repo", { x: 12, y: 34 }]]));
    expect(readPositions().get("folder:c:/repo")).toEqual({ x: 12, y: 34 });
    savePositions(new Map());
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("损坏的记录读成空，不抛错", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readPositions().size).toBe(0);
    localStorage.setItem(KEY, "[1,2]");
    expect(readPositions().size).toBe(0);
  });

  it("独立工作空间各自存储位置，不会读到旧全景（all）下的遗留坐标造成重叠", () => {
    savePositions(new Map([["origin:cursor:a", { x: 900, y: 800 }]]), "all");
    savePositions(new Map([["origin:cursor:a", { x: 10, y: 20 }]]), "origin:cursor:a");
    expect(readPositions("all").get("origin:cursor:a")).toEqual({ x: 900, y: 800 });
    expect(readPositions("origin:cursor:a").get("origin:cursor:a")).toEqual({ x: 10, y: 20 });
    expect(readPositions("origin:cursor:b").size).toBe(0);
  });
});
