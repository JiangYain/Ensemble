/**
 * `layout*.test.ts` 共用的测试数据与几何读取，仅供测试使用（没有任何运行时代码引用它，不会被打进产物）：
 * 只有构造器和取值函数，不含断言，也不依赖 vitest。每个函数只做一件事，场景由参数里的数据决定；
 * 某一组测试独有的夹具留在那个测试文件里。
 */

import type { SessionSummary } from "@shared/types";
import { folderNodeId, type LayoutNode, type SceneLayout } from "./layout";

/** 一个会话：所属来源的 key、创建的先后（第几秒），其余字段按 `extra` 覆盖。 */
export function session(id: string, origin: string, order: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    origin: { key: origin },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
    phase: "running",
    ...extra,
  } as unknown as SessionSummary;
}

/** 带工作目录的会话：来源的 key、会话的先后，以及这个来源自己带着的 `workspace`（不给就是没有）。 */
export const inDir = (id: string, origin: string, order: number, workspace?: string): SessionSummary =>
  session(id, origin, order, workspace === undefined ? {} : { origin: { key: origin, workspace } as SessionSummary["origin"] });

/**
 * codex 三个、cursor 两个、console 一个会话（创建先后 1 至 6）：三个来源，高矮不一。
 * 并排与否取决于它的尺寸（见 layout.git.test.ts “同一列里的来源节点共用一条竖轴”里的取景数字）：改它之前先核对那里。
 */
export const sessionsOfThreeOrigins: readonly SessionSummary[] = [
  session("a1", "codex", 1), session("a2", "codex", 2), session("a3", "codex", 3),
  session("b1", "cursor", 4), session("b2", "cursor", 5),
  session("c1", "console", 6),
];

export const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
/** REPO 规范化后的 key（directoryKey 的写法）；Folder 节点的 id 是 `folder:` 加上它。 */
export const REPO_KEY = "c:/users/alice/desktop/ensemble";
export const REPO_ID = folderNodeId(REPO_KEY);

export const node = (layout: SceneLayout, id: string): LayoutNode => {
  const found = layout.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing node ${id}`);
  return found;
};

export const centerOf = (n: LayoutNode): number => n.y + n.h / 2;
export const gitsOf = (layout: SceneLayout): LayoutNode[] => layout.nodes.filter((n) => n.kind === "git");
export const foldersOf = (layout: SceneLayout): LayoutNode[] => layout.nodes.filter((n) => n.kind === "folder");
/** 静态的归属连线（Git → Folder → 来源），不含委派连线。 */
export const linksOf = (layout: SceneLayout) => layout.edges.filter((edge) => edge.phase === "link");
export const groupOf = (layout: SceneLayout, key: string) => layout.origins.find((group) => group.origin.key === key)!;

/** 互相重叠的节点对（`a × b`）；没有重叠就是空数组，调用处用 `toEqual([])` 断言，失败时直接看到是哪几对。 */
export const overlapsOf = (layout: SceneLayout): string[] => {
  const found: string[] = [];
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i]!;
      const b = layout.nodes[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) found.push(`${a.id} × ${b.id}`);
    }
  }
  return found;
};
