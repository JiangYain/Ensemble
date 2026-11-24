import type { NodePosition } from "./positions";

/** 手动位置；undefined 表示这个节点没有手动位置，回到布局给的位置。 */
export type Placement = NodePosition | undefined;

/** 一次位置变动：撤销回到 before，重做回到 after。 */
export interface HistoryEntry {
  before: Map<string, Placement>;
  after: Map<string, Placement>;
  /** 连续的同类小动作（方向键微调）合并成一条，免得撤销要按几十下。 */
  merge?: string;
  at: number;
}

const HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 1000;

/** 这一批节点此刻的手动位置（复制一份，之后原表怎么改都不影响它）。 */
export function snapshotOf(positions: ReadonlyMap<string, NodePosition>, ids: readonly string[]): Map<string, Placement> {
  return new Map(ids.map((id) => {
    const position = positions.get(id);
    return [id, position ? { ...position } : undefined];
  }));
}

/** 位置的撤销栈与重做栈：只管栈本身，位置怎么放回去、界面怎么通知由调用方做。 */
export class PlacementHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** 记下一次变动（前后没有差别就不记）；带 `merge` 的连续小动作在窗口内并进上一条。返回是否真的记了。 */
  record(before: Map<string, Placement>, after: Map<string, Placement>, merge?: string): boolean {
    const same = [...before].every(([id, was]) => {
      const now = after.get(id);
      return was === now || (was !== undefined && now !== undefined && was.x === now.x && was.y === now.y);
    });
    if (same) return false;
    const now = Date.now();
    const last = this.undoStack[this.undoStack.length - 1];
    if (merge && last?.merge === merge && now - last.at < MERGE_WINDOW_MS && this.redoStack.length === 0) {
      last.after = after;
      last.at = now;
    } else {
      this.undoStack.push({ before, after, ...(merge ? { merge } : {}), at: now });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    return true;
  }

  /** 撤销栈顶的一条移到重做栈，返回它；没有就是 undefined。 */
  undo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  /** 重做栈顶的一条移回撤销栈，返回它；没有就是 undefined。 */
  redo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    return entry;
  }
}
