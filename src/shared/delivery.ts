import type { DeliveryRecord, DeliveryState, DeliveryStage } from "./types";

/**
 * 消息投递状态机（纯函数）。
 *
 * 阶段顺序：recorded → queued(Ensemble) → handed_off → queued(执行端) → applied。
 * “已排队”既可能发生在交给执行端之前（Ensemble 自己持有），
 * 也可能发生在之后（执行端接受后在自己的队列里等待回合边界），所以排序时要区分排队方。
 * failed / cancelled 是终态，可从任意非终态进入。
 */

export function newDelivery(at: string): DeliveryState {
  const record: DeliveryRecord = { stage: "recorded", at };
  return { ...record, history: [record] };
}

export function stageRank(record: Pick<DeliveryRecord, "stage" | "queuedBy">): number {
  switch (record.stage) {
    case "recorded":
      return 0;
    case "queued":
      return record.queuedBy === "harness" ? 3 : 1;
    case "handed_off":
      return 2;
    case "applied":
      return 4;
    case "failed":
    case "cancelled":
      return 99;
  }
}

export function isDeliveryTerminal(stage: DeliveryStage): boolean {
  return stage === "applied" || stage === "failed" || stage === "cancelled";
}

/** 是否仍在途：尚未生效、也未失败或撤回。 */
export function isDeliveryPending(state: Pick<DeliveryState, "stage">): boolean {
  return state.stage === "recorded" || state.stage === "queued" || state.stage === "handed_off";
}

/**
 * 应用一次状态转移；非法（倒退或重复）转移会被忽略并返回原对象，
 * 这样事件重放与重复上报都是幂等的。
 */
export function advanceDelivery(state: DeliveryState, next: DeliveryRecord): DeliveryState {
  if (isDeliveryTerminal(state.stage)) return state;

  const isTerminalNext = next.stage === "failed" || next.stage === "cancelled";
  if (!isTerminalNext && stageRank(next) <= stageRank(state)) return state;

  return {
    ...next,
    history: [...state.history, next].slice(-12),
  };
}

/** 供界面与 MCP 文本使用的机器可读标签，不含任何本地化文案。 */
export function deliveryLabelKey(state: Pick<DeliveryState, "stage" | "queuedBy">): string {
  if (state.stage === "queued") return state.queuedBy === "harness" ? "queued_harness" : "queued_ensemble";
  return state.stage;
}
