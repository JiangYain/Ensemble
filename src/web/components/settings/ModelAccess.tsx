import { useId, useState, type ReactNode } from "react";
import { catalogDefaultModel, effortRule, effortsAllowed, resolveModelChoices } from "@shared/models";
import type { HarnessInfo, ModelInfo } from "@shared/types";
import { store } from "../../lib/app";
import { changeEffortCheck, changeModelChecks, chooseDefaultModel, clearEffortLimit, defaultSelection, effortSelection, modelSelection, modelSettingsMessage, saveModelSelection, staleDefaultMessage } from "../../lib/model-settings";
import { modelFamily } from "../../lib/modelFamily";
import { useStore } from "../../lib/store";
import { useT } from "../../lib/useT";
import { Section } from "../bits";
import { Icon } from "../Icons";
import { ModelMark } from "../ModelMark";
import { Chip } from "../ui";
import { moveFocus } from "./keys";

/** 模型多到一眼扫不完时才出现筛选框。 */
const FILTER_FROM = 8;

const familyOf = (model: ModelInfo) => modelFamily({ resolved: model.id, label: model.label });

/**
 * 一个执行端里“允许主 Agent 选用的模型”：勾选列表、筛选、全选 / 全不选、推理强度，以及默认模型。
 * 默认模型是另一件事：勾选是多选（左边深色实心的方块），默认是单选（每个已开放的行最右一格方框，选中的是框里一块朱色的小方块），
 * 两者不同位置、不同颜色、一实一空，不会被当成同一列控件。
 */
export function ModelAccess({ info }: { info: HarnessInfo }): ReactNode {
  const t = useT();
  const pending = useStore(store, (s) => s.pendingModelSettings[info.id]);
  const catalog = info.models;
  const [filter, setFilter] = useState("");
  // 刚被取消勾选而不再是默认的那个模型：只是一句就地的说明，不是设置本身，所以放在视图状态里，下一次操作就收起。
  const [dropped, setDropped] = useState<string | null>(null);
  // 展开了推理强度区的模型。只是视图状态：真正的选择在 pending / 服务端里，关掉模型就收起。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const regionPrefix = useId();
  const selection = modelSelection(info, pending);
  const savedEfforts = effortSelection(info, pending);
  const userDefault = defaultSelection(info, pending);
  const issue = pending === undefined ? info.modelSettingsIssue : undefined;

  if (catalog.length === 0 || issue === "unreadable_file") {
    return (
      <Section title={t("harness.modelsAllowed")} defaultOpen>
        <p className="muted" role={issue ? "status" : undefined}>{t(issue ? modelSettingsMessage[issue] : "harness.noModels")}</p>
      </Section>
    );
  }

  const wanted = new Set(selection ?? catalog.map((model) => model.id));
  const needle = filter.trim().toLowerCase();
  const shown = needle ? catalog.filter((model) => model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle)) : catalog;
  const allowedCount = catalog.filter((model) => wanted.has(model.id)).length;
  const shownOn = shown.filter((model) => wanted.has(model.id)).length;
  const marked = catalog.some((model) => familyOf(model) !== undefined);

  // 默认模型落到哪一个，要让用户事先知道：用户指定的（picked，已核对过可用）优先；没指定时是执行端自己的，
  // 它没有勾选就退到第一个被开放的；指定过但已经用不了的（stale）退回上述规则，并在下面如实说明。
  const preferred = catalogDefaultModel(info);
  const choices = resolveModelChoices({ ...info, allowedModels: selection ?? undefined, allowedEfforts: savedEfforts, userDefaultModel: userDefault ?? undefined, modelSettingsIssue: issue });
  const standard = choices.defaultModel;
  const picked = "defaultSource" in choices && choices.defaultSource === "user" ? choices.defaultModel : undefined;
  const stale = "staleDefault" in choices ? choices.staleDefault : undefined;
  const swapped = picked === undefined && allowedCount > 0 && preferred !== undefined && standard !== undefined && standard !== preferred;
  // 模型名里的空格换成不换行空格：这句话折行时，名字整体挪到下一行，不会断在名字中间；
  // 连字符后面补一个零宽的“字间连接符”：Chrome 会在 “GPT-” 之后断行（实测），不挡住就成了 “GPT-” / “5.12 Codex”。
  const nameOf = (id: string | undefined): string => (catalog.find((model) => model.id === id)?.label ?? id ?? t("harness.defaultUnnamed")).replace(/ /g, "\u00a0").replace(/-/g, "-\u2060");
  const pickName = `${regionPrefix}-default`;

  // 勾选状态一变（开放或关闭），这些模型的推理强度区都回到收起：关闭的不再占位，重新开放时也从简洁的列表开始。
  const collapse = (ids: readonly string[]): void =>
    setExpanded((previous) => {
      if (!ids.some((id) => previous.has(id))) return previous;
      const next = new Set(previous);
      for (const id of ids) next.delete(id);
      return next;
    });
  const check = (ids: readonly string[], on: boolean): void => {
    collapse(ids.filter((id) => wanted.has(id) !== on));
    // 取消勾选的恰是指定的默认模型：不拦着，保存时一并清掉它（见 saveModelSelection），这里只负责就地说一句。
    setDropped(!on && userDefault !== null && ids.includes(userDefault) ? userDefault : null);
    changeModelChecks(info.id, ids, on);
  };
  const pick = (id: string): void => {
    setDropped(null);
    chooseDefaultModel(info.id, id);
  };
  const restore = (): void => {
    setDropped(null);
    chooseDefaultModel(info.id, null);
  };
  const toggleRegion = (id: string): void =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const uncheckedAll = (): void => {
    collapse(catalog.map((model) => model.id));
    setDropped(userDefault);
    saveModelSelection(info.id, { allowed: [] });
  };

  return (
    <Section
      className="mcfg-section"
      title={t("harness.modelsAllowed")}
      count={`${allowedCount} / ${catalog.length}`}
      defaultOpen
      action={
        <span className="mcfg-bulk">
          {needle ? (
            <button type="button" disabled={shownOn === shown.length} onClick={() => check(shown.map((model) => model.id), true)}>
              {t("harness.selectAll")}
            </button>
          ) : (
            <button type="button" disabled={selection === null} data-tip={t("harness.allowAllTip")} onClick={() => { setDropped(null); saveModelSelection(info.id, { allowed: null }); }}>
              {t("harness.allowAll")}
            </button>
          )}
          <button
            type="button"
            disabled={needle ? shownOn === 0 : selection?.length === 0 && !issue}
            onClick={() => needle ? check(shown.map((model) => model.id), false) : uncheckedAll()}
          >
            {t("harness.selectNone")}
          </button>
        </span>
      }
    >
      {catalog.length > FILTER_FROM ? (
        <span className="input-wrap mcfg-filter">
          <Icon name="search" size={14} />
          <input
            className="input"
            value={filter}
            placeholder={t("harness.modelFilter")}
            aria-label={t("harness.modelFilter")}
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              // 筛选框里有字时，Esc 先清掉字，而不是把整个设置窗口关了。
              if (event.key === "Escape" && filter) {
                event.stopPropagation();
                event.preventDefault();
                setFilter("");
              }
            }}
          />
        </span>
      ) : null}

      {shown.length === 0 ? (
        <p className="muted mcfg-empty">{t("harness.modelNoMatch")}</p>
      ) : (
        // 上下键在勾选框之间走（Tab 仍是逐个走：展开钮也在其中）：模型几十个时不必一路 Tab 过去。
        <ul
          className="mlist"
          data-scroll
          data-marked={marked ? "" : undefined}
          onKeyDown={(event) => {
            if (!(event.target as HTMLElement).classList.contains("mrow-input")) return;
            moveFocus(event, [...event.currentTarget.querySelectorAll<HTMLElement>(".mrow-input")], { axis: "vertical" });
          }}
        >
          {shown.map((model) => {
            const on = wanted.has(model.id);
            const family = familyOf(model);
            // 只有开放了的、并且执行端真的报告了档位的模型才有推理强度区；没有档位就不生成控件。
            const levels = model.efforts ?? [];
            const configurable = on && levels.length > 0;
            const rule = effortRule(savedEfforts, model.id);
            const allowedLevels = configurable ? effortsAllowed(levels, rule) : [];
            const open = configurable && expanded.has(model.id);
            const region = `${regionPrefix}-${catalog.indexOf(model)}`;
            return (
              <li key={model.id} className="mitem" data-open={open ? "" : undefined}>
                <div className="mline">
                  <label className="mrow" data-on={on ? "" : undefined}>
                    <input type="checkbox" className="mrow-input" checked={on} onChange={(event) => check([model.id], event.currentTarget.checked)} />
                    <span className="mrow-box" aria-hidden="true">
                      <Icon name="check" size={12} strokeWidth={3} />
                    </span>
                    {marked ? family ? <ModelMark family={family} size={14} /> : <Icon name="sparkle" size={14} strokeWidth={1.9} className="model-glyph" /> : null}
                    <span className="mrow-name" data-tip={model.id === model.label ? undefined : `${model.label}\n${model.id}`}>
                      {model.label}
                    </span>
                    {model.id === (picked ?? preferred) ? (
                      <Chip tone="teal" tip={model.id === picked ? t("harness.defaultPicked") : undefined}>{t("harness.default")}</Chip>
                    ) : picked !== undefined && model.id === preferred ? (
                      <Chip tone="neutral" tip={t("harness.defaultOwnTip")}>{t("harness.defaultOwn")}</Chip>
                    ) : null}
                  </label>
                  {configurable ? (
                    <button
                      type="button"
                      className="mrow-more"
                      data-state={allowedLevels.length === 0 ? "empty" : rule !== undefined ? "limited" : undefined}
                      aria-expanded={open}
                      aria-controls={region}
                      aria-label={t("harness.effortsToggle", { name: model.label, n: allowedLevels.length, total: levels.length })}
                      onClick={() => toggleRegion(model.id)}
                    >
                      <span>{t("harness.effortShort")}</span>
                      <span className="num">{allowedLevels.length}/{levels.length}</span>
                      <Icon name="chevronDown" size={12} strokeWidth={2} className="mrow-more-chevron" />
                    </button>
                  ) : null}
                  {on ? (
                    // 单选的“默认”：同一个 name 的原生单选组，方向键切换并选中，Tab 只停一次。没开放的模型不能当默认，只留空位，列不会错位。
                    <label className="mpick" data-tip={t(picked === model.id ? "harness.defaultPicked" : "harness.defaultPickTip")}>
                      <input
                        type="radio"
                        className="mpick-input"
                        name={pickName}
                        checked={picked === model.id}
                        aria-label={t("harness.defaultPick", { name: model.label })}
                        onChange={() => pick(model.id)}
                      />
                      <span className="mpick-dot" aria-hidden="true" />
                    </label>
                  ) : (
                    <span className="mpick" data-void="" aria-hidden="true" />
                  )}
                </div>
                {open ? (
                  <div className="mefforts" id={region} role="group" aria-label={t("harness.effortsGroup", { name: model.label })}>
                    {levels.map((level) => {
                      const checked = allowedLevels.includes(level);
                      // 最后一档不能取消：不禁用，保持可聚焦，只是不响应（aria-disabled）。
                      const last = checked && allowedLevels.length === 1;
                      return (
                        <label key={level} className="echip" data-on={checked ? "" : undefined} data-last={last ? "" : undefined} data-tip={last ? t("harness.effortLast") : undefined}>
                          <input
                            type="checkbox"
                            className="echip-input"
                            checked={checked}
                            aria-disabled={last || undefined}
                            onChange={(event) => {
                              if (!last) changeEffortCheck(info.id, model.id, level, event.currentTarget.checked);
                            }}
                          />
                          <span className="echip-text mono">{level}</span>
                        </label>
                      );
                    })}
                    {rule !== undefined ? (
                      <button type="button" className="link-btn" onClick={() => clearEffortLimit(info.id, model.id)}>
                        {t("harness.effortUnlimited")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {choices.kind === "empty" || issue ? (
        <div className="field-note field-note--amber" role="status">
          <Icon name="alert" size={14} />
          <span>{t(issue ? modelSettingsMessage[issue] : allowedCount > 0 ? "harness.effortsNeeded" : "harness.noneAllowed")}</span>
        </div>
      ) : null}

      {/* 默认模型的说明，同一时刻只说最要紧的一件：指定的默认用不了 > 刚取消勾选了它 > 现在用的是用户指定的 > 执行端的默认没勾选。 */}
      {issue ? null : stale ? (
        <div className="field-note field-note--amber" role="status">
          <Icon name="alert" size={14} />
          <span>
            {t(staleDefaultMessage[stale.why], { stale: nameOf(stale.id), name: nameOf(standard) })}
            <button type="button" className="link-btn" onClick={restore}>{t("harness.defaultRestore")}</button>
          </span>
        </div>
      ) : dropped !== null ? (
        <p className="mcfg-note" role="status">
          {choices.kind === "empty" ? t("harness.defaultDroppedNone", { dropped: nameOf(dropped) }) : t("harness.defaultDropped", { dropped: nameOf(dropped), name: nameOf(standard) })}
        </p>
      ) : picked !== undefined ? (
        <p className="mcfg-note">
          {t("harness.defaultUser", { name: nameOf(picked) })}
          <button type="button" className="link-btn" onClick={restore}>{t("harness.defaultRestore")}</button>
        </p>
      ) : swapped ? (
        <p className="mcfg-note">{t("harness.defaultSwapped", { name: nameOf(standard) })}</p>
      ) : null}
    </Section>
  );
}
