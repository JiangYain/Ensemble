import type { ReactNode } from "react";
import { deliveryLabelKey } from "@shared/delivery";
import type { DeliveryRecord, Message } from "@shared/types";
import { timeOfDay } from "../lib/text";
import { useT } from "../lib/useT";
import { Icon } from "./Icons";

const STEPS = ["recorded", "handed_off", "applied"] as const;

type StepState = "done" | "current" | "todo" | "failed" | "cancelled";

function reachedIndex(history: readonly DeliveryRecord[]): number {
  let reached = 0;
  for (const record of history) {
    if (record.stage === "handed_off") reached = Math.max(reached, 1);
    else if (record.stage === "queued") reached = Math.max(reached, record.queuedBy === "harness" ? 1 : 0);
    else if (record.stage === "applied") reached = 2;
  }
  return reached;
}

function recordLine(record: DeliveryRecord, t: ReturnType<typeof useT>): string {
  const key = deliveryLabelKey(record);
  const reason = record.reason ? `（${t(`queue.${record.reason}`)}）` : "";
  const detail = record.error ? `：${record.error.message}` : record.evidence ? ` · ${record.evidence}` : "";
  return `${timeOfDay(record.at)}  ${t(`delivery.${key}`)}${reason}${detail}`;
}

/**
 * 消息投递轨迹：已记录 → 已交给执行端 → 已生效。排队、失败和撤回各自单独说明，不把“已发送”说成“已生效”。
 *
 * 已生效是投递的终点——前面两步必然都走过了，三个方块不再提供信息，收成一行“执行端已确认纳入上下文”；
 * 逐条记录（每一步的时刻与证据）仍在悬停提示里。还在路上、卡住、失败、撤回时才展开完整的三步，
 * 因为这时用户需要看清它停在了哪一步。
 */
export function DeliveryTrack({ message }: { message: Message }): ReactNode {
  const t = useT();
  const { delivery } = message;
  const reached = reachedIndex(delivery.history);
  const key = deliveryLabelKey(delivery);
  const failed = delivery.stage === "failed";
  const cancelled = delivery.stage === "cancelled";
  const queued = delivery.stage === "queued";

  const stateOf = (index: number): StepState => {
    if (failed || cancelled) {
      // 已经走过的步骤保持完成；失败/撤回落在它的下一步（例如“交给执行端后没能生效”）。
      if (index <= reached) return "done";
      if (index === reached + 1) return failed ? "failed" : "cancelled";
      return "todo";
    }
    if (index < reached) return "done";
    return index === reached ? "current" : "todo";
  };

  const tip = delivery.history.map((record) => recordLine(record, t)).join("\n");
  const reason = delivery.reason ? t(`queue.${delivery.reason}`) : undefined;
  const status = failed && delivery.error ? `${t("delivery.failed")}: ${delivery.error.message}` : t(`delivery.${key}`) + (queued && reason ? ` · ${reason}` : "");

  if (delivery.stage === "applied") {
    return (
      <div className="delivery" data-stage="applied" data-compact="" data-tip={tip}>
        <span className="dl-done" aria-hidden="true">
          <Icon name="check" size={9} strokeWidth={3} />
        </span>
        <span className="dl-status" data-tone="neutral">
          {status}
        </span>
      </div>
    );
  }

  return (
    <div className="delivery" data-stage={delivery.stage} data-queued-by={delivery.queuedBy} data-tip={tip}>
      <ol className="dl-steps" aria-label={t("delivery.label")}>
        {STEPS.map((step, index) => {
          const state = stateOf(index);
          return (
            <li key={step} data-state={state}>
              <span className="dl-dot">{state === "done" ? <Icon name="check" size={9} strokeWidth={3} /> : state === "failed" ? <Icon name="close" size={9} strokeWidth={3} /> : null}</span>
              <span className="dl-name">{t(`delivery.step.${step}`)}</span>
            </li>
          );
        })}
      </ol>
      <span className="dl-status" data-tone={failed ? "red" : cancelled ? "gray" : queued ? "amber" : "neutral"}>
        {status}
      </span>
    </div>
  );
}

/** 单个小方块：用颜色区分投递阶段（列表里用，不替代文字）。 */
export function StageDot({ stage }: { stage: Message["delivery"]["stage"] }): ReactNode {
  return <span className="stage-dot" data-stage={stage} aria-hidden="true" />;
}

/** 用户的干预是否已经同步给发起端的主 Agent。 */
export function SyncTag({ message }: { message: Message }): ReactNode {
  const t = useT();
  if (message.sync.toOrigin === "not_needed") return null;
  const delivered = message.sync.toOrigin === "delivered";
  return (
    <span className="sync-tag" data-state={delivered ? "delivered" : "pending"} data-tip={delivered ? t("sync.deliveredTip", { time: message.sync.at ? timeOfDay(message.sync.at) : "" }) : t("sync.pendingTip")}>
      <Icon name={delivered ? "check" : "clock"} size={11} strokeWidth={2} />
      {delivered ? t("sync.delivered") : t("sync.pending")}
    </span>
  );
}
