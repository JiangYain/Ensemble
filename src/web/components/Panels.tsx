import { useMemo, type ReactNode } from "react";
import { attentionKey } from "@shared/attention";
import { deliveryLabelKey } from "@shared/delivery";
import { formatUsd } from "@shared/format";
import { parentIdsOf } from "@shared/lineage";
import type { SessionState } from "@shared/projection";
import type { AttentionItem, ContextItem, FileChange, Message, SessionSummary, ToolItem } from "@shared/types";
import { navigate } from "../lib/app";
import { addKnown, shownDelta } from "../lib/diffstat";
import { refDeclared, workspaceTipLine, workspaceUnknown } from "../lib/originText";
import { revealMessage } from "../lib/reveal";
import { attentionText, clock, dateTime, idHead, phaseLabel, timeOfDay, tokensText, useNow } from "../lib/text";
import { usageBreakdown } from "../lib/usage";
import { useRelated } from "../lib/useRelated";
import { useLang, useT } from "../lib/useT";
import { effortLabel, harnessName, modelLabel } from "../lib/view";
import { Clamp, KV, MiddleText, PathText, Section } from "./bits";
import { ContextRef } from "./ContextRef";
import { StageDot } from "./Delivery";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { LineDelta } from "./LineDelta";
import { HostMark } from "./OriginNode";
import { Preview } from "./Preview";
import { Chip, CopyButton, StatusDot } from "./ui";
import { UsageRing } from "./UsageRing";

// ───────────────────────── 任务（左栏） ─────────────────────────

function safeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** `prompt` 是这个会话实际收到的完整提示：会话引用要从里面取回“当时交出去的原文”（见 ContextRef）。 */
function ContextRow({ item, prompt }: { item: ContextItem; prompt: string }): ReactNode {
  const t = useT();
  switch (item.kind) {
    case "text":
      return (
        <li className="ctx">
          <div className="ctx-head">
            <Icon name="list" size={13} />
            <span className="ctx-title">{item.title ?? t("ctx.text")}</span>
          </div>
          <Clamp lines={4} expandLabel={t("common.expand")} collapseLabel={t("common.collapse")}>
            <div className="ctx-text">{item.text}</div>
          </Clamp>
        </li>
      );
    case "file":
      return (
        <li className="ctx">
          <div className="ctx-head">
            <Icon name="file" size={13} />
            <span className="ctx-path mono" data-tip={item.path}>
              {item.path}
            </span>
            <CopyButton value={item.path} label={t("common.copyPath")} size={12} />
          </div>
          {item.note ? <div className="ctx-note">{item.note}</div> : null}
        </li>
      );
    case "snippet": {
      const range = item.startLine !== undefined ? `${item.startLine}${item.endLine !== undefined ? `–${item.endLine}` : ""}` : undefined;
      return (
        <li className="ctx">
          <div className="ctx-head">
            <Icon name="terminal" size={13} />
            <span className="ctx-path mono" data-tip={item.path}>
              {item.path ?? t("ctx.snippet")}
              {range ? `:${range}` : ""}
            </span>
          </div>
          <Preview preview={{ text: item.text, truncated: false }} maxHeight={180} />
        </li>
      );
    }
    case "url": {
      const href = safeUrl(item.url);
      return (
        <li className="ctx">
          <div className="ctx-head">
            <Icon name="link" size={13} />
            {href ? (
              <a className="ctx-path" href={href} target="_blank" rel="noreferrer noopener" data-tip={item.url}>
                {item.title ?? item.url}
              </a>
            ) : (
              <span className="ctx-path" data-tip={item.url}>
                {item.title ?? item.url}
              </span>
            )}
          </div>
        </li>
      );
    }
    case "session":
      return <ContextRef item={item} prompt={prompt} />;
    default:
      // 编译期穷尽检查：新增了上下文类型而忘了这里，类型检查会在下一行报错；运行时遇到更新版本写下的、不认识的类型就不画这一项。
      item satisfies never;
      return null;
  }
}

export function TaskPanel({ state, summary }: { state: SessionState; summary: SessionSummary }): ReactNode {
  const t = useT();
  const { meta } = state;
  // 上级可能已经归档（见 useRelated：两张表都认，认不出时后台补读已归档列表）。
  const { parent, parents, missingParents } = useRelated(summary);
  // 汇聚：跟随多个会话时每个上级一行；单上级与原来一样，只有一行（认不出时是页脚的一句说明）。
  const several = parentIdsOf(summary).length > 1;
  const origin = summary.origin;
  const isUser = origin.kind === "user";

  return (
    <div className="panel-stack">
      <Section title={t("task.origin")} defaultOpen>
        <div className="origin-card">
          <span className="origin-mark">
            <HostMark host={origin.host} size={18} />
          </span>
          <div className="origin-card-text">
            <div className="origin-card-title">{isUser ? t("origin.user") : t("origin.dispatchedBy", { host: origin.hostLabel })}</div>
            <div className="origin-card-sub">
              {origin.sessionRef ? (
                <>
                  <span>{t(`origin.refLabel.${origin.sessionRef.kind}`)}</span>
                  <span className="mono" data-tip={origin.sessionRef.id}>
                    {idHead(origin.sessionRef.id, 12)}
                  </span>
                  {refDeclared(origin) ? <span data-tip={t("origin.refDeclaredTip")}>{t("origin.refDeclared")}</span> : null}
                </>
              ) : (
                <span>{isUser ? t("origin.console") : t("origin.noRefTip")}</span>
              )}
            </div>
            {origin.workspace ? (
              <div className="origin-card-ws mono" data-tip={workspaceTipLine(origin, t)}>
                <Icon name="folder" size={11} />
                <PathText value={origin.workspace} />
              </div>
            ) : workspaceUnknown(origin) ? (
              // 宿主没有报告、委派时也没显式传 cwd：写“未知”，不拿桥进程的目录顶替。
              <div className="origin-card-ws" data-tip={t("origin.workspaceUnknownTip")}>
                <Icon name="folder" size={11} />
                <span>{`${t("origin.workspace")}: ${t("origin.workspaceUnknown")}`}</span>
              </div>
            ) : null}
          </div>
        </div>
        {several ? (
          // 一个都认不出时不画空的分组（页脚逐个说明了认不出的是哪几个）。
          parents.length > 0 ? (
            <div className="parent-links" role="group" aria-label={t("task.parentsLabel", { n: parents.length + missingParents.length })}>
              {parents.map((one) => (
                <button key={one.id} type="button" className="parent-link" onClick={() => navigate({ kind: "session", id: one.id })}>
                  <Icon name="branch" size={13} />
                  <span>{t("task.parent")}</span>
                  <strong>{one.title}</strong>
                  <Icon name="chevronRight" size={12} />
                </button>
              ))}
            </div>
          ) : null
        ) : parent ? (
          <button type="button" className="parent-link" onClick={() => navigate({ kind: "session", id: parent.id })}>
            <Icon name="branch" size={13} />
            <span>{t("task.parent")}</span>
            <strong>{parent.title}</strong>
            <Icon name="chevronRight" size={12} />
          </button>
        ) : null}
      </Section>

      <Section title={t("task.brief")} action={<CopyButton value={meta.task.text} label={t("task.copy")} />}>
        <Clamp lines={12} expandLabel={t("common.expand")} collapseLabel={t("common.collapse")} watch={meta.task.text}>
          <div className="task-text">{meta.task.text}</div>
        </Clamp>
      </Section>

      <Section title={t("task.context")} count={meta.task.context.length}>
        {meta.task.context.length === 0 ? (
          <p className="muted">{t("task.noContext")}</p>
        ) : (
          <ul className="ctx-list">
            {meta.task.context.map((item, index) => (
              <ContextRow key={index} item={item} prompt={meta.task.prompt} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("task.prompt")} defaultOpen={false} action={<CopyButton value={meta.task.prompt} label={t("task.copyPrompt")} />}>
        <Clamp lines={12} expandLabel={t("common.expand")} collapseLabel={t("common.collapse")} watch={meta.task.prompt}>
          <div className="task-text">{meta.task.prompt}</div>
        </Clamp>
      </Section>

      {/* 汇聚时逐个说明认不出的上级（已删除，或在还没读到的已归档里）：点名是哪一个，其余的链接照常可点。 */}
      {several ? (
        missingParents.map((id) => (
          <p key={id} className="muted">
            {t("task.parentGoneNamed", { id: idHead(id, 12) })}
          </p>
        ))
      ) : parent === undefined && summary.parentSessionId ? (
        <p className="muted">{t("task.parentGone")}</p>
      ) : null}
    </div>
  );
}

// ───────────────────────── 会话信息 ─────────────────────────

export function InfoPanel({ state, summary }: { state: SessionState; summary: SessionSummary }): ReactNode {
  const t = useT();
  const lang = useLang();
  const { meta } = state;
  const enforcement = summary.accessEnforcement;
  const model = meta.model;
  const effort = effortLabel(summary.effort, t);
  const requested = model?.requested;
  const resolved = model?.resolved;

  return (
    <div className="panel-stack">
      <Section title={t("info.session")}>
        <dl className="kvs">
          <KV label={t("info.harness")}>
            <span className="inline">
              <HarnessMark harness={summary.harness} size={16} variant="bare" />
              {harnessName(summary.harness, t)}
              {summary.runtime === "fixture" ? <Chip tone="violet" tip={t("run.simulatedTip")}>{t("run.simulated")}</Chip> : null}
            </span>
          </KV>
          <KV label={t("info.model")}>
            <span>{modelLabel(summary, t)}</span>
            {requested && resolved && requested !== resolved ? (
              <span className="kv-sub">{t("info.modelResolved", { requested, resolved })}</span>
            ) : model?.provider ? (
              <span className="kv-sub">{model.provider}</span>
            ) : null}
          </KV>
          <KV label={t("info.effort")}>{effort ?? <span className="muted">{t("info.effortDefault")}</span>}</KV>
          <KV label={t("info.access")}>
            <span className="inline inline--nowrap">
              <span>{t(`access.${summary.access}`)}</span>
              {enforcement ? (
                <Chip tone={enforcement.level === "enforced" ? "teal" : enforcement.level === "advisory" ? "amber" : "red"} tip={`${t(`enforce.tip.${enforcement.level}`)}\n${enforcement.mechanism}`}>
                  {t(`enforce.${enforcement.level}`)}
                </Chip>
              ) : null}
            </span>
          </KV>
          <KV label={t("info.cwd")}>
            <span className="inline inline--nowrap">
              <PathText className="kv-path" value={summary.cwd} />
              <CopyButton value={summary.cwd} label={t("common.copyPath")} size={12} />
            </span>
          </KV>
          {summary.nativeRef ? (
            <KV label={t("info.native")} tip={t("info.nativeTip")}>
              <span className="inline inline--nowrap">
                <span className="kv-sub-inline">{t(`native.${summary.nativeRef.kind}`)}</span>
                <MiddleText className="kv-path" value={summary.nativeRef.id} tip={`${t(`native.${summary.nativeRef.kind}`)}\n${summary.nativeRef.id}`} />
                <CopyButton value={summary.nativeRef.id} label={t("common.copyId")} size={12} />
              </span>
            </KV>
          ) : null}
          <KV label={t("info.id")}>
            <span className="inline inline--nowrap">
              <MiddleText className="kv-path" value={summary.id} />
              <CopyButton value={summary.id} label={t("common.copyId")} size={12} />
            </span>
          </KV>
          <KV label={t("info.created")}>{dateTime(summary.createdAt, lang)}</KV>
          <KV label={t("info.runs")}>
            <span className="num">{summary.runCount}</span>
          </KV>
        </dl>
      </Section>
    </div>
  );
}

// ───────────────────────── 概览（右栏） ─────────────────────────

function aggregateFiles(state: SessionState): (FileChange & { status: ToolItem["status"] })[] {
  const files = new Map<string, FileChange & { status: ToolItem["status"] }>();
  for (const item of state.timeline) {
    if (item.type !== "tool" || !item.files) continue;
    for (const file of item.files) {
      const previous = files.get(file.path);
      // 行数只累加执行端上报过的；一次都没上报的那一侧保持“未知”，不会变成 0。
      const added = addKnown(previous?.addedLines, file.addedLines);
      const removed = addKnown(previous?.removedLines, file.removedLines);
      files.set(file.path, {
        ...file,
        // 同一个文件多次修改：行数累加，类型保留最初的（新建后再改仍然是新建）。
        change: previous?.change === "created" && file.change === "modified" ? "created" : file.change,
        ...(added !== undefined ? { addedLines: added } : {}),
        ...(removed !== undefined ? { removedLines: removed } : {}),
        ...(file.diff ? { diff: file.diff } : previous?.diff ? { diff: previous.diff } : {}),
        status: item.status,
      });
    }
  }
  return [...files.values()];
}

/**
 * 消息记录里的一条：只有一行（谁、什么类型、几点、投递状态的小方块）。
 * 正文不在这里重复，点击后主时间线滚动到这条消息，正文就在那里。
 * 小方块留在行上，是为了“未送达 / 已撤回”这类需要注意的状态不必定位过去就能看到。
 */
function MessageLogRow({ message }: { message: Message }): ReactNode {
  const t = useT();
  const stage = message.delivery.stage;
  const stateLabel = t(`delivery.${deliveryLabelKey(message.delivery)}`);
  return (
    <li data-kind={message.kind}>
      <button type="button" className="msg-log-head" data-tip={t("msg.locate")} onClick={() => revealMessage(message.id)}>
        <span className="msg-log-author">{message.author.label}</span>
        <Chip tone={message.kind === "steer" ? "amber" : message.kind === "follow_up" ? "blue" : "neutral"}>{t(`msg.kind.${message.kind}`)}</Chip>
        <span className="msg-log-end">
          <time className="num" dateTime={message.createdAt}>
            {timeOfDay(message.createdAt)}
          </time>
          <span className="msg-log-dot" role="img" aria-label={stateLabel} data-tip={stateLabel}>
            <StageDot stage={stage} />
          </span>
        </span>
      </button>
    </li>
  );
}

function ChildCard({ child }: { child: SessionSummary }): ReactNode {
  const t = useT();
  return (
    <button type="button" className="child" onClick={() => navigate({ kind: "session", id: child.id })}>
      <HarnessMark harness={child.harness} size={30} />
      <span className="child-text">
        <span className="child-title">{child.title}</span>
        <span className="child-sub">
          <StatusDot phase={child.phase} size={7} />
          {phaseLabel(child.phase, t)}
          {child.lastRun?.durationMs !== undefined ? <span className="num"> · {clock(child.lastRun.durationMs)}</span> : null}
          {child.archivedAt !== undefined ? <span> · {t("archive.chip")}</span> : null}
        </span>
      </span>
      <Icon name="chevronRight" size={13} />
    </button>
  );
}

/** 服务端依据事件注意到的事实：每条一句话，时长随时间增长，所以由这个组件自己取现在。 */
function AttentionSection({ items }: { items: readonly AttentionItem[] }): ReactNode {
  const t = useT();
  const now = useNow();
  return (
    <Section title={t("attention.title")} count={items.length}>
      <ul className="attn-list">
        {items.map((item) => (
          <li key={attentionKey(item)}>{attentionText(item, now, t)}</li>
        ))}
      </ul>
    </Section>
  );
}

export function SummaryPanel({ state, summary }: { state: SessionState; summary: SessionSummary }): ReactNode {
  const t = useT();
  // 下级里可能有已经归档的（整棵都已结束的下级可以先于上级被归档）：两张表都认。
  const { children } = useRelated(summary);
  const files = useMemo(() => aggregateFiles(state), [state, state.seq]);
  const usage = summary.usage;
  const plan = state.plan;
  const messages = state.messages;
  const contextShare =
    usage?.contextTokens !== undefined && usage.contextWindow ? Math.min(1, usage.contextTokens / usage.contextWindow) : undefined;
  const breakdown = usage ? usageBreakdown(usage) : undefined;

  return (
    <div className="panel-stack">
      {summary.attention?.length ? <AttentionSection items={summary.attention} /> : null}
      <Section title={t("sum.progress")}>
        {plan && plan.entries.length > 0 ? (
          <ol className="plan-list plan-list--side">
            {plan.entries.map((entry, index) => (
              <li key={entry.id ?? index} data-status={entry.status}>
                <span className="plan-mark">{entry.status === "completed" ? <Icon name="check" size={10} strokeWidth={3} /> : null}</span>
                <span>{entry.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{summary.capabilities.plan.support === "no" ? t("sum.noPlanSupport") : t("sum.noPlan")}</p>
        )}
      </Section>

      {children.length > 0 ? (
        <Section title={t("sum.children")} count={children.length}>
          <div className="children">
            {children.map((child) => (
              <ChildCard key={child.id} child={child} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t("sum.messages")} count={messages.length}>
        <ul className="msg-log">
          {messages.map((message) => (
            <MessageLogRow key={message.id} message={message} />
          ))}
        </ul>
      </Section>

      <Section title={t("sum.files")} count={files.length} defaultOpen={files.length > 0}>
        {files.length === 0 ? (
          <p className="muted">{summary.capabilities.fileEvents.support === "no" ? t("sum.noFileEvents") : t("sum.noFiles")}</p>
        ) : (
          <ul className="files">
            {files.map((file) => {
              const delta = shownDelta(file);
              return (
                <li key={file.path}>
                  <Chip tone={file.change === "deleted" ? "red" : file.change === "created" ? "teal" : "neutral"}>{t(`file.${file.change}`)}</Chip>
                  <span className="mono file-path" data-tip={file.path}>
                    {file.path}
                  </span>
                  {/* 只画执行端真实上报的、不为 0 的行数；没有可画的就连容器也不渲染。 */}
                  {delta ? (
                    <span className="num file-stat">
                      <LineDelta delta={delta} />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={t("sum.usage")} defaultOpen={usage !== undefined}>
        {usage === undefined ? (
          <p className="muted">{summary.capabilities.usage.support === "no" ? t("sum.noUsageSupport") : t("sum.noUsage")}</p>
        ) : (
          <>
            {breakdown ? <UsageRing breakdown={breakdown} /> : null}
            {!breakdown || usage.costUsd !== undefined || contextShare !== undefined ? (
              <dl className="kvs kvs--tight">
                {/* 有环时 token 的构成已经画在环和图例里；缺数据或口径对不上时才退回逐项列表。 */}
                {!breakdown && usage.inputTokens !== undefined ? <KV label={t("usage.input")}><span className="num">{tokensText(usage.inputTokens)}</span></KV> : null}
                {!breakdown && usage.cachedTokens !== undefined ? <KV label={t("usage.cached")}><span className="num">{tokensText(usage.cachedTokens)}</span></KV> : null}
                {!breakdown && usage.outputTokens !== undefined ? <KV label={t("usage.output")}><span className="num">{tokensText(usage.outputTokens)}</span></KV> : null}
                {!breakdown && usage.reasoningTokens !== undefined ? <KV label={t("usage.reasoning")}><span className="num">{tokensText(usage.reasoningTokens)}</span></KV> : null}
                {usage.costUsd !== undefined ? <KV label={t("usage.cost")}><span className="num">{formatUsd(usage.costUsd)}</span></KV> : null}
                {contextShare !== undefined ? (
                  <KV label={t("usage.context")}>
                    <span className="ctx-meter" data-tip={`${tokensText(usage.contextTokens)} / ${tokensText(usage.contextWindow)}`}>
                      <span className="ctx-meter-bar">
                        <i style={{ width: `${Math.round(contextShare * 100)}%` }} data-high={contextShare > 0.85 ? "" : undefined} />
                      </span>
                      <span className="num">{Math.round(contextShare * 100)}%</span>
                    </span>
                  </KV>
                ) : null}
              </dl>
            ) : null}
          </>
        )}
      </Section>
    </div>
  );
}
