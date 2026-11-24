import type { SceneLayout } from "./layout";

/**
 * 交出去的排布与同一次的全新规划“不一样”吗——“重置节点布局”要不要因此出现（LAYOUT5 · W15）。按内容比，不比对象引用。
 *
 * 只比会话卡：有任何一张会话卡的位置与规划不同，或两边的节点对不上，才算不一样。来源卡、Folder 卡、Git 卡的位置是规划跟着它们连着的会话
 * 居中出来的——第二个根会话到来时，规划把来源卡居中到两个会话之间，持有的排布里它留在原位，而两张会话卡与规划逐像素相同；
 * 这时重排只是把来源卡挪一段，不值得为它多出一个按钮（arrival-hold.ts 的 `shiftOf` 出于同一个理由不让 Folder 与 Git 卡参与“规划有没有把已有的卡重排”的判断）。
 *
 * `shown` 与 `plan` 出自同一份规划（持有逻辑只改坐标，节点的个数与顺序不变），所以按下标逐个比：O(n)，不建表；
 * 节点对不上不会发生，真发生了也按“不一样”处理，不假设。
 */
export function driftsFromPlan(shown: SceneLayout, plan: SceneLayout): boolean {
  if (shown === plan) return false;
  const held = shown.nodes;
  const planned = plan.nodes;
  if (held.length !== planned.length) return true;
  for (let i = 0; i < held.length; i++) {
    const node = held[i]!;
    const spot = planned[i]!;
    if (node.id !== spot.id) return true;
    if (node.kind === "agent" && (node.x !== spot.x || node.y !== spot.y)) return true;
  }
  return false;
}
