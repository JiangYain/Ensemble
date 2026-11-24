import { writeNode, type Body } from "./engine-body";
import { PlacementHistory, snapshotOf, type Placement } from "./engine-history";
import { readPositions, savePositions, type NodePosition } from "./positions";

/** 手动位置向引擎问的几件事，以及位置改完之后引擎要做的收尾（相机、外框、连线、宿主回调）；它们的顺序由引擎定。 */
export interface PlacementHost {
  /** 正在拖动：对齐、撤销、重做不动（手里的节点和历史会互相打架）。 */
  dragging(): boolean;
  /** 布局给这个节点的原位；布局里没有它就是 undefined。 */
  homeOf(id: string): NodePosition | undefined;
  /** 用户把节点放到了新位置（拖动中的每一步、方向键微调）。 */
  placed(): void;
  /** 对齐、撤销、重做把一批位置改好了。 */
  settled(): void;
  /** 能否撤销、重做变了。 */
  historyChanged(): void;
}

/**
 * 当前空间里用户摆放过的节点位置（手动位置）、它们的持久化，以及改动它们的操作与历史：
 * 手放、微调、对齐、分布、撤销、重做、清除。位置改好之后的收尾交给 `PlacementHost`。
 */
export class Placements {
  private map: Map<string, NodePosition> = readPositions();
  private key = "all";
  private readonly history = new PlacementHistory();

  constructor(
    private readonly bodies: ReadonlyMap<string, Body>,
    private readonly host: PlacementHost,
  ) {}

  /** 当前空间里用户摆放过的节点位置。 */
  get positions(): Map<string, NodePosition> {
    return this.map;
  }

  /** 当前空间的 key（也是位置存在 localStorage 里的那一份的名字）。 */
  get space(): string {
    return this.key;
  }

  get count(): number {
    return this.map.size;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** 换到另一个空间：位置读那个空间自己存的（历史由 `forget` 另清）。 */
  open(space: string): void {
    this.key = space;
    this.map = readPositions(space);
  }

  forget(): void {
    this.history.clear();
  }

  save(): void {
    savePositions(this.map, this.key);
  }

  snapshot(ids: readonly string[]): Map<string, Placement> {
    return snapshotOf(this.map, ids);
  }

  /** 拖动、微调结束：存下，并记进历史。 */
  commit(before: Map<string, Placement>, ids: readonly string[], merge?: string): void {
    this.save();
    this.record(before, ids, merge);
  }

  /** 用户把这些节点放到了新位置：立即到位（弹簧不再追），位置记下来。 */
  place(updates: readonly { body: Body; position: NodePosition }[]): void {
    for (const { body, position } of updates) {
      body.x = body.tx = position.x;
      body.y = body.ty = position.y;
      body.vx = body.vy = 0;
      this.map.set(body.id, position);
      writeNode(body);
    }
    this.host.placed();
  }

  /** Keyboard alternative to dragging a focused node. */
  nudge(moving: readonly Body[], dx: number, dy: number): void {
    const ids = moving.map((item) => item.id);
    const before = this.snapshot(ids);
    this.place(moving.map((item) => ({ body: item, position: { x: item.x + dx, y: item.y + dy } })));
    this.commit(before, ids, `nudge:${[...ids].sort().join(",")}`);
  }

  /** 把一批节点移到 `next` 给的位置；返回是否真的挪动了节点。 */
  arrange(next: ReadonlyMap<string, NodePosition>): boolean {
    if (this.host.dragging()) return false;
    const targets = [...next].flatMap(([id, position]) => {
      const body = this.bodies.get(id);
      return body ? [{ id, body, position }] : [];
    });
    const changed = targets.some(({ body, position }) => Math.abs(position.x - body.tx) > 0.01 || Math.abs(position.y - body.ty) > 0.01);
    if (!changed) return false;
    // 选中的节点一并固定下来，包括本来就在位的那几个：否则之后重新布局时，没被固定的会被排到别处，对齐就散了。
    const ids = targets.map(({ id }) => id);
    const before = this.snapshot(ids);
    for (const { id, body, position } of targets) {
      body.tx = position.x;
      body.ty = position.y;
      this.map.set(id, { ...position });
    }
    this.host.settled();
    this.record(before, ids);
    return true;
  }

  /** 清除全部手动位置并存下；这一步也进历史（Ctrl+Z 找回手动位置）。 */
  clear(): void {
    const ids = [...this.map.keys()];
    const before = this.snapshot(ids);
    this.map.clear();
    this.record(before, ids);
    this.save();
  }

  /** 拖动进行中不撤销：手里的节点和历史会互相打架。 */
  undo(): boolean {
    if (this.host.dragging()) return false;
    const entry = this.history.undo();
    if (!entry) return false;
    this.restore(entry.before);
    this.host.historyChanged();
    return true;
  }

  redo(): boolean {
    if (this.host.dragging()) return false;
    const entry = this.history.redo();
    if (!entry) return false;
    this.restore(entry.after);
    this.host.historyChanged();
    return true;
  }

  private record(before: Map<string, Placement>, ids: readonly string[], merge?: string): void {
    if (this.history.record(before, snapshotOf(this.map, ids), merge)) this.host.historyChanged();
  }

  /** 把一批节点放回某个时刻的位置：没有手动位置的回到布局给的位置，由弹簧送过去。 */
  private restore(placements: ReadonlyMap<string, Placement>): void {
    for (const [id, placement] of placements) {
      if (placement) this.map.set(id, { ...placement });
      else this.map.delete(id);
      const body = this.bodies.get(id);
      if (!body) continue;
      const target = placement ?? this.host.homeOf(id);
      if (!target) continue;
      body.tx = target.x;
      body.ty = target.y;
    }
    this.host.settled();
  }
}
