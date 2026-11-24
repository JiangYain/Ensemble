import { useId, type ReactNode } from "react";
import type { AccessLevel, HarnessInfo } from "@shared/types";
import { store } from "../../lib/app";
import { modelSelection } from "../../lib/model-settings";
import { useStore } from "../../lib/store";
import { relative } from "../../lib/text";
import { useT } from "../../lib/useT";
import { harnessName } from "../../lib/view";
import { Section } from "../bits";
import { HarnessMark } from "../HarnessMark";
import { Icon } from "../Icons";
import { Chip, CopyButton } from "../ui";
import { statusTone, setupText } from "./harness-info";
import { ModelAccess } from "./ModelAccess";

const ACCESS_LEVELS: AccessLevel[] = ["read_only", "full"];

/**
 * 一个执行端：头部是整条可点的开合钮（执行端的标、名字、版本、账号、状态，以及已开放了几个模型），展开后是设置提示与
 * 模型、访问权限两个分区。几个执行端、每个几十个模型时，一列全部铺开会很长；收起的头部已经带着一眼要看的信息，只有展开的才渲染模型列表。
 * 没有任何可展开内容的（例如还在检测）头部不是按钮，也没有箭头。
 */
export function HarnessCard({ info, now, open, onToggle }: { info: HarnessInfo; now: number; open: boolean; onToggle: () => void }): ReactNode {
  const t = useT();
  const pending = useStore(store, (s) => s.pendingModelSettings[info.id]);
  const region = useId();
  const text = setupText(info, t);
  const hasBody = info.status === "ready" || info.models.length > 0 || Boolean(info.modelSettingsIssue);
  const expandable = Boolean(text) || hasBody;
  const expanded = expandable && open;

  // 与展开后列表里的勾选同一份数据（含还在保存途中的选择）；名单读不出来时不写数字。
  const selection = modelSelection(info, pending);
  const showAllowed = info.models.length > 0 && info.modelSettingsIssue !== "unreadable_file";
  const allowed = selection === null ? info.models.length : info.models.filter((model) => selection.includes(model.id)).length;

  const head = (
    <>
      <HarnessMark harness={info.id} size={40} />
      <span className="hcard-title">
        <span className="hcard-name">
          {harnessName(info.id, t)}
          {info.runtime === "fixture" ? <Chip tone="violet" tip={t("run.simulatedTip")}>{t("run.simulated")}</Chip> : null}
        </span>
        <span className="hcard-sub">
          {info.version ? <span className="mono">{info.version}</span> : null}
          {info.account ? <span>{info.account}</span> : null}
          {info.status === "ready" || info.status === "checking" ? null : <span>{t("harness.checkedAt", { time: relative(info.checkedAt, now, t) })}</span>}
          {showAllowed ? <span className="num">{t("harness.allowedSummary", { n: allowed, total: info.models.length })}</span> : null}
        </span>
      </span>
      <Chip tone={statusTone(info.status)}>
        {/* 状态标记是纯装饰，读屏只读后面那个词。检测中也是同一个 8×8 的标记（画法见 sidebar.css 的 .status-pip），设置窗口里不用全局的转圈。 */}
        <span className="status-pip" data-status={info.status} aria-hidden="true" />
        {t(`harness.status.${info.status}`)}
      </Chip>
      {expandable ? <Icon name="chevronDown" size={14} strokeWidth={2} className="hcard-chevron" /> : null}
    </>
  );

  return (
    <article className="hcard" data-status={info.status} data-open={expanded ? "" : undefined}>
      <h4 className="hcard-head">
        {expandable ? (
          <button type="button" className="hcard-toggle" aria-expanded={expanded} aria-controls={expanded ? region : undefined} onClick={onToggle}>
            {head}
          </button>
        ) : (
          <span className="hcard-toggle">{head}</span>
        )}
      </h4>

      {expanded ? (
        <div className="hcard-panel" id={region}>
          {text ? (
            <div className="hcard-setup" data-status={info.status}>
              <Icon name={info.status === "needs_setup" ? "info" : "alert"} size={14} />
              <div>
                <p>{text}</p>
                {info.setup?.command ? (
                  <div className="cmd">
                    <code className="mono">{info.setup.command}</code>
                    <CopyButton value={info.setup.command} label={t("harness.copyCommand")} size={12} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {hasBody ? (
            <div className="hcard-body">
              <ModelAccess info={info} />

              <Section title={t("harness.access")} defaultOpen={false}>
                <ul className="access-list">
                  {ACCESS_LEVELS.map((level) => {
                    const enforcement = info.access[level];
                    return (
                      <li key={level}>
                        <span className="access-name">{t(`access.${level}`)}</span>
                        {enforcement ? (
                          <>
                            <Chip tone={enforcement.level === "enforced" ? "teal" : enforcement.level === "advisory" ? "amber" : "neutral"} tip={t(`enforce.tip.${enforcement.level}`)}>
                              {t(`enforce.${enforcement.level}`)}
                            </Chip>
                            <span className="access-mech">{enforcement.mechanism}</span>
                          </>
                        ) : (
                          <Chip tone="neutral">{t("harness.accessUnsupported")}</Chip>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Section>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
