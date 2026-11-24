import { useId, useState, type ReactNode } from "react";
import { handedOverText, type HandoffNoResult, type HandoffSample, type SessionContextItem } from "@shared/handoff";
import { routeHash } from "../lib/app";
import type { TFunction } from "../lib/i18n";
import { dateTime, phaseLabel } from "../lib/text";
import { useUpstream } from "../lib/useUpstream";
import { useLang, useT } from "../lib/useT";
import { harnessName } from "../lib/view";
import { KV } from "./bits";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { Preview } from "./Preview";
import { StatusDot } from "./ui";

/**
 * 聚焦页“传入的上下文”里的一条会话引用（context 的第五种条目，见 shared/handoff.ts）。
 * 画的全是派发那一刻冻结在会话记录里的事实（`item.sample`）和当时交出去的原文（取自 `meta.task.prompt` 里它那一块），
 * 不回头读上游：上游之后可能继续跑、改名、被归档甚至被删除，“当时交接了什么”都不该跟着变。
 * 唯一实时的只有标题能不能点——上游还在，标题就是指向它的链接；已经不在了，就只留文字并说明。
 */

/** 取不到结果的三种原因各一句话；键写成字面量，词典的“死键”检查才认得它们。 */
const NO_RESULT_KEY: Record<HandoffNoResult, string> = {
  no_runs: "handoff.noRuns",
  no_text: "handoff.noText",
  no_final: "handoff.noFinal",
};

/** 一行事实：主文字加若干条补充（取自第几次运行、被截断了没有……），补充用小一号的灰字。 */
interface Fact {
  main: string;
  notes: string[];
}

function resultFact(sample: HandoffSample, t: TFunction): Fact | undefined {
  const fact = sample.result;
  if (!fact) return undefined;
  if (!fact.found) return { main: t("handoff.noResult"), notes: [t(NO_RESULT_KEY[fact.reason])] };
  const notes = [t("handoff.fromRun", { run: fact.runIndex, runs: sample.runCount })];
  if (fact.latest) notes.push(t("handoff.laterNone", { run: fact.latest.runIndex }));
  if (fact.label === "unlabeled") notes.push(t("handoff.notFinal"));
  if (fact.sentChars < fact.chars) notes.push(t("handoff.cut", { sent: fact.sentChars, n: fact.chars }));
  return { main: t("handoff.chars", { n: fact.sentChars }), notes };
}

function filesFact(sample: HandoffSample, t: TFunction): Fact | undefined {
  const fact = sample.files;
  if (!fact) return undefined;
  if (fact.total === 0) return { main: t("handoff.filesNone"), notes: [] };
  return {
    main: t("handoff.pathCount", { n: fact.sent }),
    notes: fact.sent < fact.total ? [t("handoff.pathsCut", { sent: fact.sent, n: fact.total })] : [],
  };
}

function errorFact(sample: HandoffSample, t: TFunction): Fact | undefined {
  const fact = sample.error;
  if (!fact) return undefined;
  if (!fact.found) return { main: t("handoff.errorNone"), notes: [] };
  return {
    main: fact.runIndex !== undefined ? t("handoff.errorIn", { code: fact.code, run: fact.runIndex }) : t("handoff.errorSession", { code: fact.code }),
    notes: fact.truncated ? [t("handoff.errorCut")] : [],
  };
}

function FactRow({ label, fact }: { label: string; fact: Fact }): ReactNode {
  return (
    <KV label={label}>
      <span>{fact.main}</span>
      {fact.notes.map((note) => (
        <span key={note} className="kv-sub">
          {note}
        </span>
      ))}
    </KV>
  );
}

export function ContextRef({ item, prompt }: { item: SessionContextItem; prompt: string }): ReactNode {
  const t = useT();
  const lang = useLang();
  const { summary, state } = useUpstream(item.sessionId);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const sample = item.sample;

  const harness = sample?.harness ?? summary?.harness;
  // 标题：上游还在就用它现在的名字（点进去看到的就是它）；已经不在了，只能用交接时记下的。
  const title = (state === "gone" ? sample?.title : (summary?.title ?? sample?.title)) ?? item.sessionId;
  const rows = sample
    ? [
        { key: "result", label: t("handoff.result"), fact: resultFact(sample, t) },
        { key: "files", label: t("handoff.files"), fact: filesFact(sample, t) },
        { key: "error", label: t("handoff.error"), fact: errorFact(sample, t) },
      ].flatMap((row) => (row.fact ? [{ key: row.key, label: row.label, fact: row.fact }] : []))
    : [];
  // 只在展开时才从提示里取原文；区间对不上（记录被改过）时返回 undefined，说“找不到”，而不是展示一段错位的文字。
  const text = open && sample ? handedOverText(prompt, item) : undefined;

  return (
    <li className="ctx cref" data-state={state}>
      <div className="cref-head">
        {harness ? <HarnessMark harness={harness} size={16} variant="bare" /> : null}
        <div className="cref-main">
          {state === "gone" ? (
            <span className="cref-title">{title}</span>
          ) : (
            <a className="cref-title" href={routeHash({ kind: "session", id: item.sessionId })} aria-label={t("handoff.open", { title })} data-tip={item.sessionId}>
              {title}
            </a>
          )}
          {sample ? (
            <div className="cref-sub">
              <span>{harnessName(sample.harness, t)}</span>
              {sample.model ? <span>{sample.model}</span> : null}
              <span className="cref-phase">
                <StatusDot phase={sample.phase} size={7} />
                {t("handoff.phaseAt", { phase: phaseLabel(sample.phase, t) })}
              </span>
              <span className="num">{t("handoff.readAt", { time: dateTime(sample.at, lang) })}</span>
            </div>
          ) : null}
        </div>
      </div>

      {state === "gone" ? <p className="cref-gone">{t("handoff.gone")}</p> : null}
      {sample ? null : <p className="muted">{t("handoff.noSample")}</p>}

      {rows.length > 0 || item.note ? (
        <dl className="kvs kvs--tight">
          {rows.map((row) => (
            <FactRow key={row.key} label={row.label} fact={row.fact} />
          ))}
          {item.note ? (
            <KV label={t("handoff.note")}>
              <span className="cref-note">{item.note}</span>
            </KV>
          ) : null}
        </dl>
      ) : null}

      {sample ? (
        <>
          <button type="button" className="cref-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} strokeWidth={2} />
            <span>{t("handoff.text")}</span>
          </button>
          <div id={bodyId} hidden={!open}>
            {open ? text !== undefined ? <Preview preview={{ text, truncated: false }} maxHeight={240} /> : <p className="muted">{t("handoff.textMissing")}</p> : null}
          </div>
        </>
      ) : null}
    </li>
  );
}
