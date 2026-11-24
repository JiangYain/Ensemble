import { groupFolders, type FolderGroup } from "../lib/folder";
import { boundsOf, NODE, type LayoutNode } from "./layout-geometry";
import type { Cluster } from "./layout-strips";
import { folderNodeId, gitNodeId, NO_OVERHANG, type Built, type LayoutEdge, type LayoutFolder, type Sink } from "./layout-types";

/**
 * 来源与它们的 Folder 卡、Git 卡：按工作目录与 Git 工作树把来源归成一个个整体，并在整体左边排上两种卡片（见 `workspaceClusters`）。
 * 这是排布的一个独立步骤，只读 layout-types 的类型、layout-geometry 的尺寸与 layout-strips 的 `Cluster`，不读会话数据，也不读排布的其余部分。
 */

/** `workspaceClusters` 的几项设置：Git 表、要不要画 Folder 与 Git、来源卡与它左边的卡片之间的间距、竖直叠放的来源块之间的间距。 */
export interface WorkspaceSettings {
  git: ReadonlyMap<string, string> | undefined;
  drawFolders: boolean;
  gap: number;
  stackGap: number;
}

/** 来源 → 它所在的 Folder 卡、来源 → 它的 Git 工作树：两张只读的查找表。 */
interface WorkspaceIndex {
  cardOf: ReadonlyMap<string, FolderGroup>;
  worktreeOf: (item: Built) => string | undefined;
}

/** 一个整体：同一个 Git 节点或 Folder 节点（`root`，没有就是 undefined）下面的来源。 */
interface Unit {
  root: string | undefined;
  items: Built[];
}

/** 整体里的一行：同一张 Folder 卡的来源，或一个没有 Folder 的来源。 */
interface Row {
  card?: FolderGroup;
  items: Built[];
}

function indexWorkspaces(origins: readonly Built[], git: ReadonlyMap<string, string> | undefined, drawFolders: boolean): WorkspaceIndex {
  const workspaceOf = new Map<string, string>();
  if (drawFolders) for (const { summary } of origins) if (summary.origin.workspace) workspaceOf.set(summary.origin.key, summary.origin.workspace);
  const cards = groupFolders(workspaceOf);
  const cardOf = new Map<string, FolderGroup>();
  for (const card of cards) for (const origin of card.origins) cardOf.set(origin, card);

  // 一张 Folder 卡只在一个工作树里：它下面的来源都指向同一个工作树才画 Git 归属。对不上不替数据挑一个、也不补全
  // （读数矛盾的目录 lib/git 的 groupGit 本来就不给工作树，这里只是防止同一张卡拆成两张）。
  const cardWorktree = new Map<string, string>();
  for (const card of cards) {
    const trees = new Set(card.origins.map((origin) => git?.get(origin)));
    const [only] = trees;
    if (trees.size === 1 && only !== undefined) cardWorktree.set(card.key, only);
  }
  const worktreeOf = (item: Built): string | undefined => {
    const origin = item.summary.origin.key;
    const card = cardOf.get(origin);
    return card ? cardWorktree.get(card.key) : git?.get(origin);
  };
  return { cardOf, worktreeOf };
}

function groupUnits(origins: readonly Built[], index: WorkspaceIndex): Unit[] {
  // 同一个 Git 工作树的来源是一个整体；不在工作树里的，同一个目录的来源是一个整体；两者都没有的各自一个。整体按第一个成员出现的先后排。
  const units: Unit[] = [];
  const byRoot = new Map<string, Built[]>();
  for (const item of origins) {
    const worktree = index.worktreeOf(item);
    const card = index.cardOf.get(item.summary.origin.key);
    const root = worktree !== undefined ? gitNodeId(worktree) : card ? folderNodeId(card.key) : undefined;
    const known = root === undefined ? undefined : byRoot.get(root);
    if (known) {
      known.push(item);
    } else {
      const items = [item];
      units.push({ root, items });
      if (root !== undefined) byRoot.set(root, items);
    }
  }
  return units;
}

function rowsOf(items: readonly Built[], cardOf: ReadonlyMap<string, FolderGroup>): Row[] {
  // 同一个目录的来源挨在一起（先出现的目录排前面），没有 Folder 的来源各占一行：线不交叉。
  const rows: Row[] = [];
  const rowOf = new Map<string, Row>();
  for (const item of items) {
    const card = cardOf.get(item.summary.origin.key);
    const row = card ? rowOf.get(card.key) : undefined;
    if (row) {
      row.items.push(item);
    } else {
      const created: Row = { ...(card ? { card } : {}), items: [item] };
      rows.push(created);
      if (card) rowOf.set(card.key, created);
    }
  }
  return rows;
}

/** 把各行的来源块整体右移 `lead`、自上而下叠放，并给有 Folder 的行排上 Folder 卡（连同它到来源的连线与 `folders` 里的记录）。 */
function placeRows(
  rows: readonly Row[],
  worktree: string | undefined,
  gitShift: number,
  lead: number,
  stackGap: number,
  folders: LayoutFolder[],
): { folderNodes: LayoutNode[]; below: LayoutNode[]; links: LayoutEdge[] } {
  const folderNodes: LayoutNode[] = [];
  /** Git 节点的下游：Folder 节点，或没有 Folder 的来源节点。 */
  const below: LayoutNode[] = [];
  const links: LayoutEdge[] = [];
  let top = 0;
  for (const row of rows) {
    for (const item of row.items) {
      for (const node of item.nodes) {
        node.x += lead;
        node.y += top;
      }
      if (worktree !== undefined) item.summary.worktree = worktree;
      top += item.height + stackGap;
    }
    const head = row.items[0]!.origin;
    const tail = row.items.at(-1)!.origin;
    if (!row.card) {
      below.push(head);
      continue;
    }

    // Folder 卡落在它的来源（首尾两个来源节点的中线）的正中。
    const y = (head.y + tail.y + NODE.originH) / 2 - NODE.folderH / 2;
    const card: LayoutNode = {
      id: folderNodeId(row.card.key),
      kind: "folder",
      x: gitShift,
      y,
      w: NODE.folderW,
      h: NODE.folderH,
      overhang: NO_OVERHANG,
      anchor: { id: head.id, dx: gitShift - head.x, dy: y - head.y },
    };
    folderNodes.push(card);
    below.push(card);
    folders.push({ ...row.card, id: card.id });
    for (const item of row.items) {
      item.summary.folder = row.card.key;
      links.push({ id: `${card.id}>${item.origin.id}`, from: card.id, to: item.origin.id, phase: "link" });
    }
  }
  return { folderNodes, below, links };
}

function gitCardFor(worktree: string, below: readonly LayoutNode[]): { card: LayoutNode; links: LayoutEdge[] } {
  // Git 卡落在它的下游（首尾两个 Folder 节点，或没有 Folder 的来源节点）的正中，锚点是排在最前的那个；它排在 Folder 之后，锚点先于它得到位置。
  const upper = below[0]!;
  const lower = below.at(-1)!;
  const y = (upper.y + upper.h / 2 + lower.y + lower.h / 2) / 2 - NODE.gitH / 2;
  const card: LayoutNode = {
    id: gitNodeId(worktree),
    kind: "git",
    x: 0,
    y,
    w: NODE.gitW,
    h: NODE.gitH,
    overhang: NO_OVERHANG,
    anchor: { id: upper.id, dx: -upper.x, dy: y - upper.y },
  };
  const links: LayoutEdge[] = [];
  for (const node of below) links.push({ id: `${card.id}>${node.id}`, from: card.id, to: node.id, phase: "link" });
  return { card, links };
}

function clusterOf(unit: Unit, index: WorkspaceIndex, out: Sink, folders: LayoutFolder[], settings: WorkspaceSettings): Cluster {
  const { root, items } = unit;
  const first = items[0]!;
  if (root === undefined) return { nodes: first.nodes, width: first.width, height: first.height, lead: 0, keys: [first.summary.origin.key] };
  const worktree = index.worktreeOf(first);
  const rows = rowsOf(items, index.cardOf);

  const gitShift = worktree === undefined ? 0 : NODE.gitW + settings.gap;
  const lead = gitShift + (rows.some((row) => row.card) ? NODE.folderW + settings.gap : 0);
  const { folderNodes, below, links } = placeRows(rows, worktree, gitShift, lead, settings.stackGap, folders);

  const cardNodes: LayoutNode[] = [...folderNodes];
  let gitLinks: LayoutEdge[] = [];
  if (worktree !== undefined) {
    const git = gitCardFor(worktree, below);
    cardNodes.push(git.card);
    gitLinks = git.links;
  }
  out.nodes.push(...cardNodes);
  out.edges.push(...gitLinks, ...links);

  const own = [...items.flatMap((item) => item.nodes), ...cardNodes];
  const box = boundsOf(own);
  for (const node of own) node.y -= box.y;
  return { nodes: own, width: box.x + box.w, height: box.h, lead, keys: items.map((item) => item.summary.origin.key) };
}

/**
 * 把来源按工作目录与 Git 工作树归成一个个整体，并在它们左边排上 Folder 节点与 Git 节点：
 *
 *   Git 工作树 ─▶ Folder（目录）─▶ 来源 ─▶ 会话
 *
 * - 目录取来源自己带着的 `workspace`，规范化后相同的是同一个目录：同一个目录只有一张 Folder 节点，每个来源各有一条连线。
 * - 目录在某个 Git 工作树里（`git` 表给出）：Git 节点连到这个 Folder 节点；几个 Folder 在同一个工作树里就共用一张 Git 节点，
 *   Git 节点连到每个 Folder。同一个目录的来源指向的工作树不一致（读数互相矛盾，数据层不给结论）时不画 Git 归属：Folder 直接连到来源。
 *   没有 Folder 的来源（表里有工作树、却没有工作目录）由 Git 节点直接连到来源。
 * - 共用一张卡的下游叠放在一起，卡落在它们中线的正中；一对一时两张卡同高，管线是一条水平线。
 * 每条连线都是静态的 link，从上游节点的右缘中点接到下游节点的左缘中点。
 * 不画 Folder 与 Git 的整体（没有工作目录、也不在 Git 仓库里的来源）原样返回。`drawFolders` 为假（紧凑的取景区域）时一个都不画。
 */
export function workspaceClusters(origins: readonly Built[], out: Sink, folders: LayoutFolder[], settings: WorkspaceSettings): Cluster[] {
  const index = indexWorkspaces(origins, settings.git, settings.drawFolders);
  return groupUnits(origins, index).map((unit) => clusterOf(unit, index, out, folders, settings));
}
