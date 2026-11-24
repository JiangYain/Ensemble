import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PROFILE_LIMIT, checkProfile, type ProfileEntry, type ProfilesView } from "@shared/profiles";
import type { HarnessInfo } from "@shared/types";
import { applyProfiles, askConfirm, store, type AppState } from "../../lib/app";
import type { TFunction } from "../../lib/i18n";
import {
  DEFAULT_VALUE,
  accessOptions,
  checkName,
  createRole,
  effortLevels,
  effortOptions,
  harnessOptions,
  issueText,
  modelOptions,
  nameProblemText,
  profilesSupported,
  removeRole,
  renameRole,
  sameFields,
  saveRole,
  specFrom,
  withAccess,
  withEffort,
  withHarness,
  withModel,
  type PickOption,
  type RoleFields,
} from "../../lib/profiles";
import { useStore } from "../../lib/store";
import { useT } from "../../lib/useT";
import { Icon } from "../Icons";
import { IconButton } from "../ui";

/** 导航项下面的小字：有几个角色此刻能用。没有角色（或角色读不出来）时不写；连着的服务没有角色功能时如实写“不可用”，不写“0 个角色”。 */
export function profilesSummary(state: AppState, t: TFunction): string | undefined {
  if (!profilesSupported(state.profiles)) return t("settings.profiles.legacy");
  const { entries, unavailable } = state.profiles;
  if (unavailable || entries.length === 0) return undefined;
  const ready = entries.filter((entry) => checkProfile(entry, state.harnesses.find((info) => info.id === entry.harness)).usable).length;
  return t("settings.profiles.summary", { ready, total: entries.length });
}

/** 选项文字超过这个长度才挂悬停提示：下拉框很窄，长的模型名会被截断，短的不需要把同一个词再说一遍。 */
const TIP_FROM = 14;

interface FieldSelectProps {
  field: "harness" | "model" | "effort" | "access";
  caption: string;
  /** 这一行的角色名，只给读屏用（“模型（verify）”）。 */
  roleName: string;
  value: string;
  options: readonly PickOption[];
  disabled?: boolean;
  onPick: (value: string) => void;
}

/** 一个下拉框。用原生 select：键盘、读屏、移动端都是现成的，样式在 profiles.css 里按设置窗口的发丝线体系画。 */
function FieldSelect({ field, caption, roleName, value, options, disabled, onPick }: FieldSelectProps): ReactNode {
  const t = useT();
  const shown = options.find((option) => option.value === value)?.label;
  return (
    <label className="prof-field" data-field={field}>
      <span className="prof-cap">{caption}</span>
      <span className="prof-pick" data-tip={shown !== undefined && shown.length > TIP_FROM ? shown : undefined}>
        <select value={value} disabled={disabled} aria-label={t("profiles.fieldFor", { field: caption, name: roleName })} onChange={(event) => onPick(event.currentTarget.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

interface RowProps {
  /** 已经存下来的角色；undefined 是还没存的草稿（名称合格并选了执行端之后自动保存）。 */
  entry: ProfileEntry | undefined;
  /** 别的角色的名称：判重用。 */
  others: readonly string[];
  harnesses: readonly HarnessInfo[];
  /** 草稿＝放弃；已存的＝删除（先确认）。由分区决定怎么做，因为之后焦点要交还给“添加”按钮。 */
  onRemove: () => void;
  /**
   * 这一行马上要以这个名称出现在角色表里（草稿落成角色，或已存的改名）：先把行的身份记到这个名称下。
   * 服务端的推送比请求的回执先到时，新名称才不会被当成“新来的一行”（那样这一行会被重新挂载，输入框丢掉焦点）。
   */
  onClaim: (name: string) => void;
  /** 请求失败：撤销上面的占用。 */
  onRelease: (name: string) => void;
  /** 请求成功：拿到生效后的整张角色表。 */
  onSaved: (name: string, view: ProfilesView) => void;
}

function RoleRow({ entry, others, harnesses, onRemove, onClaim, onRelease, onSaved }: RowProps): ReactNode {
  const t = useT();
  const messageId = useId();
  const [text, setText] = useState(entry?.name ?? "");
  // 名称的问题要等用户“交卷”（回车、离开输入框、点选了执行端）之后才摆出来，之后随输入实时更新：没敲完的名称不挨骂。
  const [attempted, setAttempted] = useState(false);
  const [draft, setDraft] = useState<RoleFields>({});
  // 刚点选、服务端还没确认的取值：下拉框立刻显示新值，不会先弹回旧值再跳到新值。确认（或被拒绝）之后就回到服务端的那一份。
  const [optimistic, setOptimistic] = useState<RoleFields | undefined>(undefined);
  const sent = useRef(0);
  const creating = useRef(false);

  // 服务端那边名称变了（改名成功、别的标签页改了名、草稿落成了角色）：输入框跟着。
  const stored = entry?.name;
  useEffect(() => {
    if (stored === undefined) return;
    setText(stored);
    setAttempted(false);
  }, [stored]);

  // 名称不合规（手改文件造成）的角色，在改名之前存不了任何别的改动：服务端会因为名称不合规拒绝，所以下拉框先不开放。
  const editable = entry === undefined || entry.invalid !== "name";
  const fields: RoleFields = entry === undefined ? draft : (optimistic ?? entry);
  const info = harnesses.find((item) => item.id === fields.harness);
  const subject: ProfileEntry | undefined = entry === undefined ? undefined : optimistic === undefined ? entry : { name: entry.name, ...optimistic };
  const check = subject === undefined ? undefined : checkProfile(subject, info);
  const { name: typed, problem } = checkName(text, others);
  const shownProblem = attempted ? problem : undefined;
  const roleName = entry?.name ?? (text.trim() || t("profiles.newRole"));
  const message =
    shownProblem !== undefined
      ? nameProblemText(shownProblem, typed, t)
      : check !== undefined && !check.usable
        ? issueText(check.issue, t)
        : entry === undefined
          ? t("profiles.draftHint")
          : undefined;

  /** 草稿：名称合格、也选了执行端，就存下来；没到这一步什么也不发。 */
  const attemptCreate = (raw: string, next: RoleFields, fromHarness: boolean): void => {
    const { name, problem: found } = checkName(raw, others);
    const spec = specFrom(next);
    if (found !== undefined || spec === undefined) {
      // 点选了执行端、就只差名称了，或者名称敲了一半就离开：这时才把问题摆出来。
      if (fromHarness || raw.trim() !== "") setAttempted(true);
      return;
    }
    // 回车之后紧接着的失焦会再来一次：上一次还在途中就不重复发。
    if (creating.current) return;
    creating.current = true;
    onClaim(name);
    void createRole(name, spec).then((view) => {
      creating.current = false;
      if (view) onSaved(name, view);
      else onRelease(name);
    });
  };

  const change = (next: RoleFields, fromHarness = false): void => {
    if (entry === undefined) {
      setDraft(next);
      attemptCreate(text, next, fromHarness);
      return;
    }
    const spec = specFrom(next);
    if (spec === undefined || sameFields(next, fields)) return;
    setOptimistic(next);
    const mine = ++sent.current;
    void saveRole(entry.name, spec).then((view) => {
      if (view) applyProfiles(view);
      // 连着改了几次时，只有最后一次的回执才把“刚点选的”放回服务端的那一份。
      if (sent.current === mine) setOptimistic(undefined);
    });
  };

  const commitName = (): void => {
    if (entry === undefined) {
      attemptCreate(text, draft, false);
      return;
    }
    // 清空了名称又离开：当作没改，回到原来的名称，不去存一个空名字。
    if (text.trim() === "") {
      setText(entry.name);
      setAttempted(false);
      return;
    }
    if (problem !== undefined) {
      setAttempted(true);
      return;
    }
    setText(typed);
    setAttempted(false);
    if (typed === entry.name) return;
    const from = entry.name;
    onClaim(typed);
    void renameRole(from, typed).then((view) => {
      if (view) {
        onSaved(typed, view);
      } else {
        onRelease(typed);
        setText(from);
      }
    });
  };

  const onNameKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      commitName();
      return;
    }
    if (event.key !== "Escape") return;
    // 有没提交的改动时，Esc 先撤销它，而不是把整个设置窗口关了（与模型筛选框同一个做法）；没有改动就让 Esc 照常关窗口。
    if (text === (entry?.name ?? "")) return;
    event.stopPropagation();
    event.preventDefault();
    setText(entry?.name ?? "");
    setAttempted(false);
  };

  const levels = effortLevels(info, fields.model).levels;
  const usable = check?.usable === true;

  return (
    <li className="prof-row" data-draft={entry === undefined ? "" : undefined}>
      <div className="prof-id">
        {/* 方块是纯装饰（读屏读 sr-only 里的词）：实心＝此刻可用，空心＝不可用或还没存；形状而不是颜色表达状态，原因写在这一行下面。 */}
        <span className="status-pip prof-pip" data-status={check === undefined ? "needs_setup" : usable ? "ready" : "unavailable"} aria-hidden="true" />
        {check !== undefined ? <span className="sr-only">{t(usable ? "harness.status.ready" : "harness.status.unavailable")}</span> : null}
        <input
          className="prof-name"
          value={text}
          maxLength={64}
          placeholder={t("profiles.namePlaceholder")}
          aria-label={t("profiles.name")}
          aria-invalid={shownProblem !== undefined ? true : undefined}
          aria-describedby={message !== undefined ? messageId : undefined}
          autoFocus={entry === undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitName}
          onKeyDown={onNameKey}
        />
      </div>
      <div className="prof-fields">
        <FieldSelect
          field="harness"
          caption={t("info.harness")}
          roleName={roleName}
          value={fields.harness ?? DEFAULT_VALUE}
          options={harnessOptions(harnesses, fields.harness, t)}
          disabled={!editable}
          onPick={(value) => change(withHarness(fields, value), true)}
        />
        <FieldSelect
          field="model"
          caption={t("info.model")}
          roleName={roleName}
          value={fields.model ?? DEFAULT_VALUE}
          options={modelOptions(info, fields.model, t)}
          disabled={!editable || info === undefined}
          onPick={(value) => change(withModel(fields, info, value === DEFAULT_VALUE ? undefined : value))}
        />
        <FieldSelect
          field="effort"
          caption={t("info.effort")}
          roleName={roleName}
          value={fields.effort ?? DEFAULT_VALUE}
          options={effortOptions(info, fields.model, fields.effort, t)}
          disabled={!editable || info === undefined || (levels.length === 0 && fields.effort === undefined)}
          onPick={(value) => change(withEffort(fields, value === DEFAULT_VALUE ? undefined : value))}
        />
        <FieldSelect
          field="access"
          caption={t("info.access")}
          roleName={roleName}
          value={fields.access ?? DEFAULT_VALUE}
          options={accessOptions(info, fields.access, t)}
          disabled={!editable || info === undefined}
          onPick={(value) => change(withAccess(fields, value === "read_only" || value === "full" ? value : undefined))}
        />
      </div>
      <IconButton className="prof-del" icon="trash" label={entry === undefined ? t("profiles.discard") : t("profiles.delete", { name: entry.name })} onClick={onRemove} />
      {message !== undefined ? (
        <p className="prof-msg" id={messageId}>
          {message}
        </p>
      ) : null}
    </li>
  );
}

/**
 * “角色”分区：用户把一组 (执行端, 模型, 推理强度, 访问权限) 绑定到一个短名字，主 Agent 委派时按名字选用（规则见 shared/profiles.ts）。
 * 改动即时生效，没有保存按钮：下拉框一选就存、名称回车或离开输入框就存、新增的一行名称合格并选了执行端就存；落盘由服务端做，所有宿主共用。
 * 列表取 store 里的 `profiles`（服务端推送），选项取 store 里的真实执行端与模型，不预置任何角色。
 */
export function ProfilesSection(): ReactNode {
  const t = useT();
  const view = useStore(store, (s) => s.profiles);
  const harnesses = useStore(store, (s) => s.harnesses);
  // 还没存下来的新行：只记它们的身份。每一行自己的输入与选择留在行里，行的身份不变，落成角色时输入框也不会丢焦点。
  const [drafts, setDrafts] = useState<readonly number[]>([]);
  // 角色名 → 行的身份。改名与草稿落成角色时把身份带过去，行就不会因为 key 变了而被重新挂载。
  const ids = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const addButton = useRef<HTMLButtonElement>(null);

  const idOf = (name: string): number => {
    let id = ids.current.get(name);
    if (id === undefined) {
      id = ++sequence.current;
      ids.current.set(name, id);
    }
    return id;
  };

  // 连着的是没有角色功能的老服务：导航项照旧留着（设置窗口的结构不随服务版本跳动），内容只有一句如实的说明——没有编辑器，也没有“添加”（保存时才在服务端 404 太晚了）。
  // 必须放在所有 hook 之后：服务升级后快照里出现 profiles，同一个组件会在两种形态之间切换。
  if (!profilesSupported(view)) {
    return (
      <p className="muted" role="status">
        {t("profiles.unsupported")}
      </p>
    );
  }

  if (view.unavailable) {
    return (
      <>
        <p className="settings-intro">{t("profiles.intro", { section: t("settings.section.executors") })}</p>
        <p className="muted" role="status">
          {t("profiles.unavailable")}
        </p>
      </>
    );
  }

  const names = view.entries.map((entry) => entry.name);
  // 已经落成角色的草稿（推送先到、回执还没回来时）由对应的角色那一行接着显示，不再当草稿画第二遍。
  const claimed = new Set(view.entries.map((entry) => idOf(entry.name)));
  const rows: { id: number; entry: ProfileEntry | undefined }[] = [
    ...view.entries.map((entry) => ({ id: idOf(entry.name), entry })),
    ...drafts.filter((id) => !claimed.has(id)).map((id) => ({ id, entry: undefined })),
  ];
  const full = rows.length >= PROFILE_LIMIT;

  const forget = (id: number): void => setDrafts((previous) => previous.filter((item) => item !== id));

  /** 行（以身份 id 区分）在名称上的占用、撤销与成功；改名成功时，这一行原来的名称不再指向它。 */
  const identity = (id: number): Pick<RowProps, "onClaim" | "onRelease" | "onSaved"> => ({
    onClaim: (name) => {
      ids.current.set(name, id);
    },
    onRelease: (name) => {
      if (ids.current.get(name) === id) ids.current.delete(name);
    },
    onSaved: (name, next) => {
      ids.current.set(name, id);
      for (const [other, owner] of [...ids.current]) if (owner === id && other !== name) ids.current.delete(other);
      forget(id);
      applyProfiles(next);
    },
  });

  const remove = (entry: ProfileEntry): void =>
    askConfirm({
      title: t("profiles.deleteTitle", { name: entry.name }),
      body: t("profiles.deleteBody"),
      confirmLabel: t("profiles.deleteConfirm"),
      tone: "danger",
      onConfirm: async () => {
        const next = await removeRole(entry.name);
        if (!next) return;
        applyProfiles(next);
        // 这一行没了，焦点交给“添加”：键盘用户不会掉到页面最上面。
        addButton.current?.focus();
      },
    });

  return (
    <>
      <p className="settings-intro">{t("profiles.intro", { section: t("settings.section.executors") })}</p>
      <div className="prof">
        <div className="prof-table">
          {rows.length === 0 ? (
            <p className="muted prof-empty">{t("profiles.empty")}</p>
          ) : (
            <>
              <div className="prof-cols" aria-hidden="true">
                <span>{t("profiles.col.name")}</span>
                <span>{t("info.harness")}</span>
                <span>{t("info.model")}</span>
                <span>{t("info.effort")}</span>
                <span>{t("info.access")}</span>
              </div>
              {/* 一个数组：草稿落成角色时，这一行从“草稿”变成“角色”，只有在同一个数组里按 key 对上，React 才会沿用同一个组件（否则会重新挂载，丢掉焦点）。 */}
              <ul className="prof-list">
                {rows.map(({ id, entry }) => (
                  <RoleRow
                    key={id}
                    entry={entry}
                    others={entry === undefined ? names : names.filter((name) => name !== entry.name)}
                    harnesses={harnesses}
                    onRemove={() => {
                      if (entry !== undefined) {
                        remove(entry);
                        return;
                      }
                      forget(id);
                      addButton.current?.focus();
                    }}
                    {...identity(id)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="prof-foot">
          <button
            ref={addButton}
            type="button"
            className="btn"
            disabled={full}
            onClick={() => {
              const id = ++sequence.current;
              setDrafts((previous) => [...previous, id]);
            }}
          >
            <Icon name="plus" size={14} />
            {t("profiles.add")}
          </button>
          {full ? (
            <span className="prof-limit" role="status">
              {t("profiles.limit", { max: PROFILE_LIMIT })}
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}
