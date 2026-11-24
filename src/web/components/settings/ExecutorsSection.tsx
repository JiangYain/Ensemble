import { useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { perform, store, toast, type AppState } from "../../lib/app";
import type { TFunction } from "../../lib/i18n";
import { useStore } from "../../lib/store";
import { useNow } from "../../lib/text";
import { useT } from "../../lib/useT";
import { IconButton } from "../ui";
import { HarnessCard } from "./HarnessCard";
import { moveFocus } from "./keys";

/** 导航项下面的小字：有几个执行端此刻可用。没有执行端信息时不写。 */
export function executorsSummary(state: AppState, t: TFunction): string | undefined {
  const total = state.harnesses.length;
  if (total === 0) return undefined;
  return t("settings.executors.summary", { ready: state.harnesses.filter((harness) => harness.status === "ready").length, total });
}

/** 分区标题行的操作槽：重新探测各执行端。探测期间按钮禁用并转圈。 */
export function ExecutorsActions(): ReactNode {
  const t = useT();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    const response = await perform(() => api.harnesses(true), t("harness.refreshFailed"));
    setRefreshing(false);
    if (response) {
      store.set({ harnesses: response.harnesses });
      toast("success", t("harness.refreshed"), 1600);
    }
  };

  return <IconButton icon="refresh" label={t("harness.refresh")} onClick={() => void refresh()} disabled={refreshing} className={refreshing ? "is-spinning" : undefined} />;
}

/**
 * “执行端”分区：每个执行端一张可折叠的卡片，列表直接取 store 里的 `harnesses`，新增执行端不需要改这里。
 * 默认只展开第一个；用户开合过之后以用户的为准（执行端列表刷新时保持）。
 */
export function ExecutorsSection(): ReactNode {
  const t = useT();
  const harnesses = useStore(store, (s) => s.harnesses);
  const now = useNow();
  // undefined：用户还没动过，按默认（只有第一个展开）。
  const [chosen, setChosen] = useState<ReadonlySet<string> | undefined>(undefined);
  const opened = chosen ?? new Set(harnesses.slice(0, 1).map((info) => info.id));

  if (harnesses.length === 0) return <p className="muted">{t("harness.none")}</p>;

  const toggle = (id: string): void => {
    const next = new Set(opened);
    if (!next.delete(id)) next.add(id);
    setChosen(next);
  };

  return (
    <>
      <p className="settings-intro">{t("harness.modelsIntro")}</p>
      {/* 上下键在各执行端的卡片头之间走；卡片里的勾选行有自己的上下键处理，按键不会漏到这里（只认落在卡片头上的）。 */}
      <div
        className="hlist"
        onKeyDown={(event) => {
          if (!(event.target as HTMLElement).classList.contains("hcard-toggle")) return;
          moveFocus(event, [...event.currentTarget.querySelectorAll<HTMLElement>("button.hcard-toggle")], { axis: "vertical" });
        }}
      >
        {harnesses.map((info) => (
          <HarnessCard key={info.id} info={info} now={now} open={opened.has(info.id)} onToggle={() => toggle(info.id)} />
        ))}
      </div>
    </>
  );
}
