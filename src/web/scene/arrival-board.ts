import type { Stack } from "./arrival-columns";
import { crowds, unionOf } from "./arrival-slots";
import type { SceneLayout } from "./layout";
import type { LayoutNode } from "./layout-geometry";
import type { Rect } from "./placement";

/**
 * 新卡落点要用的“此刻的排布”（LAYOUT3 从 arrival-hold.ts 拆出来）：已占的矩形、各家人的整块区域、每个节点属于哪家人，
 * 以及从中读出的几样东西——来源块里的会话卡与根会话卡（新根会话怎么长要用，见 arrival-grow.ts）、新卡接在哪一竖排的下面。
 * 只读规划与已摆好的卡，不决定任何一张卡去哪（那是 arrival-hold.ts 的事）。
 */

/** 一家人：会话沿树里的上级一直找到挂在来源卡上的那个根会话。 */
export interface Family {
  root: string;
  origin: string;
}

/** 新卡落点要的一切：已占的矩形、各家人占的整块区域、每个节点属于哪家人。 */
export class Board {
  readonly rects = new Map<string, Rect>();
  /** 每张卡在排布里占着的矩形（用户拖走的卡，这里仍是它在排布里的原位：撤销与重置会让它回去）。 */
  readonly cards: Rect[] = [];
  /** 每家人（根会话的 id）的外框：根会话与它的全部后代；家里空着的格子也算这家人的。 */
  readonly reserved = new Map<string, Rect>();
  private readonly families = new Map<string, Family | undefined>();

  constructor(
    private readonly plan: SceneLayout,
    readonly parents: ReadonlyMap<string, string>,
    private readonly kinds: ReadonlyMap<string, LayoutNode["kind"]>,
    /** 竖排的子会话一格的高（行距）：子列尾下面那一格要往下数这么多。 */
    private readonly rowStep: number,
  ) {}

  /** 树里的上级：会话的第一个上级，根会话是来源卡。 */
  parentOf(id: string): string | undefined {
    return this.parents.get(id)?.split(",")[0];
  }

  familyOf(id: string): Family | undefined {
    if (this.families.has(id)) return this.families.get(id);
    let found: Family | undefined;
    let cursor = id;
    for (let depth = 0; depth < 64; depth++) {
      const up = this.parentOf(cursor);
      if (up === undefined) break;
      if (this.kinds.get(up) === "origin") {
        found = { root: cursor, origin: up };
        break;
      }
      cursor = up;
    }
    this.families.set(id, found);
    return found;
  }

  /** 放一张卡：记下位置，也并进它那家人的外框。 */
  put(id: string, rect: Rect): void {
    this.rects.set(id, rect);
    this.cards.push(rect);
    const family = this.familyOf(id);
    if (!family) return;
    const box = unionOf([rect, ...(this.reserved.has(family.root) ? [this.reserved.get(family.root) as Rect] : [])]);
    if (box) this.reserved.set(family.root, box);
  }

  /**
   * 放 `node` 时的障碍：所有的卡，加上它自己那一家以外各家人的整块区域（别人家空着的格子也不能闯进去），
   * 以及各家的待用格（见 `holesFor`）。
   */
  obstaclesFor(node: LayoutNode): Rect[] {
    const mine = node.kind === "agent" ? this.familyOf(node.id)?.root : undefined;
    const list = [...this.cards];
    for (const [root, box] of this.reserved) if (root !== mine) list.push(box);
    list.push(...this.holesFor(node));
    return list;
  }

  /**
   * `node` 不能落进的待用格（LAYOUT4 · W8）：只拦根会话与不属于任何一家的卡（Folder、Git）；子会话（含汇聚会话）不受它拦。
   * 别家的子会话挤进来只是两家的子列接在一起，不是“无关的卡夹进子列”；拦它反而让交替到来的子会话各自隔格空着
   * （实测：7 个根、两个上级交替来 3 个子会话，1920×1080 的终局从 95.9% 缩到 66.6%）。
   */
  holesFor(node: LayoutNode): Rect[] {
    const family = node.kind === "agent" ? this.familyOf(node.id) : undefined;
    return family && family.root !== node.id ? [] : this.holes(family?.root);
  }

  /**
   * 各家人（除 `except`）竖排的子列尾下面的那一格，还空着才算（LAYOUT4 · W8）：这家人的下一个子会话就该落在那里，无关的卡不能占。
   * 否则新来的根会话顺着“下一个空位”正好填进别家的子列里，子列被夹断，这家人的下一个子会话只好落到别处。
   * 每家最多一格：取这家人里排在最后（按排布顺序）的子会话——汇聚会话不算，它有自己的落点——它自己所在那一列的下面一格。
   * 不占整列，也不占整块区域里别的空格。
   * 现状推出来、不记任何状态：有子会话落进去，待用格就换成新列尾的下面一格；列满了另起一列也一样，原来那一格自然空出来；
   * 那一格已经被别的卡（或邻家的整块区域）占了就没有。
   */
  holes(except?: string): Rect[] {
    const tails = new Map<string, string>();
    for (const node of this.plan.nodes) {
      if (node.kind !== "agent" || !this.rects.has(node.id)) continue;
      const family = this.familyOf(node.id);
      if (!family || family.root === node.id || family.root === except || (this.parents.get(node.id) ?? "").includes(",")) continue;
      tails.set(family.root, node.id);
    }
    const list: Rect[] = [];
    for (const [root, id] of tails) {
      const tail = this.rects.get(id) as Rect;
      const cell = { x: tail.x, y: tail.y + this.rowStep, w: tail.w, h: tail.h };
      if (this.cards.some((card) => crowds(cell, card, 0))) continue;
      if ([...this.reserved].some(([other, box]) => other !== root && crowds(cell, box, 0))) continue;
      list.push(cell);
    }
    return list;
  }

  /** 来源块 `origin` 名下已经摆好的会话卡：新卡的“第一排”与“块的右缘”都从这里读。 */
  blockOf(origin: string): Rect[] {
    const list: Rect[] = [];
    for (const [id, rect] of this.rects) if (this.kinds.get(id) === "agent" && this.familyOf(id)?.origin === origin) list.push(rect);
    return list;
  }

  /** 来源块 `origin` 名下已经摆好的根会话卡；`keep` 可以只留一部分（比如这一次之前就有的）。 */
  rootsOf(origin: string, keep: (id: string) => boolean = () => true): Rect[] {
    const list: Rect[] = [];
    for (const [id, rect] of this.rects) {
      if (this.kinds.get(id) !== "agent" || !keep(id)) continue;
      const family = this.familyOf(id);
      if (family?.root === id && family.origin === origin) list.push(rect);
    }
    return list;
  }

  /** `id` 是不是 `up` 的后代（沿树里的上级往上找）。 */
  private under(id: string, up: string): boolean {
    let cursor = id;
    for (let depth = 0; depth < 64; depth++) {
      const next = this.parentOf(cursor);
      if (next === undefined) return false;
      if (next === up) return true;
      cursor = next;
    }
    return false;
  }

  /**
   * `node` 接在哪一竖排的下面：它的锚点（上一个兄弟）与它同一个上级时，返回这个上级名下已经摆好的卡的现状；
   * 第一个子会话、第一个根会话（锚点是上级本人）没有——那里还谈不上“一列”。
   */
  stackOf(node: LayoutNode): Stack | undefined {
    const up = this.parentOf(node.id);
    const ref = node.anchor ? this.rects.get(node.anchor.id) : undefined;
    if (up === undefined || !node.anchor || !ref || this.parentOf(node.anchor.id) !== up) return undefined;
    const siblings: Rect[] = [];
    const scope: Rect[] = [];
    for (const [id, rect] of this.rects) {
      if (!this.under(id, up)) continue;
      scope.push(rect);
      if (this.parentOf(id) === up) siblings.push(rect);
    }
    return { ref, siblings, scope };
  }
}
