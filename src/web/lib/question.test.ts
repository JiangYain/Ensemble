import { describe, expect, it } from "vitest";
import type { QuestionExpiry, QuestionOutcomeRecord, QuestionPrompt } from "@shared/questions";
import { en } from "./dict-en";
import { zh } from "./dict-zh";
import { bindT, type Dict } from "./i18n";
import {
  actorName,
  answerBody,
  answersReady,
  conflictKey,
  draftAnswer,
  emptyDraft,
  emptyDrafts,
  expiryText,
  pickOption,
  pickOther,
  typeOther,
  type PromptDraft,
} from "./question";

const single: QuestionPrompt = {
  key: "scope",
  header: "Scope",
  text: "Which package should I update?",
  options: [{ label: "core" }, { label: "web", description: "the UI" }],
  multiple: false,
  custom: true,
};
const multi: QuestionPrompt = {
  key: "targets",
  text: "Which targets?",
  options: [{ label: "linux" }, { label: "mac" }, { label: "win" }],
  multiple: true,
  custom: true,
};
/** 不允许自己写答案的问题。 */
const closed: QuestionPrompt = {
  key: "mode",
  text: "Mode?",
  options: [{ label: "fast" }, { label: "safe" }],
  multiple: false,
  custom: false,
};
/** 没有可选项：就是一个自由文本问题。 */
const free: QuestionPrompt = { key: "note", text: "Anything else?", multiple: false, custom: true };

const AT = "2026-01-01T00:00:00.000Z";
const SYSTEM = { kind: "system", label: "Ensemble" } as const;

describe("作答草稿", () => {
  it("空草稿：有可选项的问题什么都没选；没有可选项的问题，文本框就是回答，恒为选中", () => {
    expect(emptyDraft(single)).toEqual({ picks: [], other: "", otherOn: false });
    expect(emptyDraft(free)).toEqual({ picks: [], other: "", otherOn: true });
    expect(emptyDrafts([single, free, multi])).toEqual([emptyDraft(single), emptyDraft(free), emptyDraft(multi)]);
  });

  it("单选：点选换成它，并放掉“其他”（写下的字留着，只是不再算数）", () => {
    let draft = typeOther(single, emptyDraft(single), "my own");
    expect(draft).toEqual({ picks: [], other: "my own", otherOn: true });
    draft = pickOption(single, draft, "core");
    expect(draft).toEqual({ picks: ["core"], other: "my own", otherOn: false });
    expect(draftAnswer(single, draft)).toEqual(["core"]);
    draft = pickOption(single, draft, "web");
    expect(draft.picks).toEqual(["web"]);
    expect(draftAnswer(single, draft)).toEqual(["web"]);
  });

  it("单选：在“其他”里写字等于选了它，并放掉可选项；回答去掉首尾空白", () => {
    let draft = pickOption(single, emptyDraft(single), "core");
    draft = typeOther(single, draft, "  my own  ");
    expect(draft).toEqual({ picks: [], other: "  my own  ", otherOn: true });
    expect(draftAnswer(single, draft)).toEqual(["my own"]);
  });

  it("把“其他”里的字删光，不会悄悄换成别的选择：它仍是选中的，只是回答为空", () => {
    let draft = typeOther(single, emptyDraft(single), "abc");
    draft = typeOther(single, draft, "");
    expect(draft.otherOn).toBe(true);
    expect(draftAnswer(single, draft)).toEqual([]);
    expect(answersReady([single], [draft])).toBe(false);
  });

  it("单选里只敲空白不会选中“其他”，也不会放掉已选的可选项", () => {
    const picked = pickOption(single, emptyDraft(single), "core");
    expect(typeOther(single, picked, "   ")).toEqual({ picks: ["core"], other: "   ", otherOn: false });
  });

  it("单选：点选“其他”放掉可选项；没写字之前回答仍然为空", () => {
    const draft = pickOther(single, pickOption(single, emptyDraft(single), "core"));
    expect(draft).toEqual({ picks: [], other: "", otherOn: true });
    expect(draftAnswer(single, draft)).toEqual([]);
  });

  it("多选：点选是切换；答案按可选项出现的顺序排，不按点击顺序", () => {
    let draft = emptyDraft(multi);
    draft = pickOption(multi, draft, "win");
    draft = pickOption(multi, draft, "linux");
    expect(draftAnswer(multi, draft)).toEqual(["linux", "win"]);
    draft = pickOption(multi, draft, "win");
    expect(draftAnswer(multi, draft)).toEqual(["linux"]);
  });

  it("多选：自己写的那一条放在最后，取消“其他”它就不再算数", () => {
    let draft = pickOption(multi, emptyDraft(multi), "mac");
    draft = typeOther(multi, draft, "bsd");
    expect(draft.otherOn).toBe(true);
    expect(draft.picks).toEqual(["mac"]);
    expect(draftAnswer(multi, draft)).toEqual(["mac", "bsd"]);
    draft = pickOther(multi, draft);
    expect(draft.otherOn).toBe(false);
    expect(draftAnswer(multi, draft)).toEqual(["mac"]);
  });

  it("不允许自己写答案的问题：即使草稿里有“其他”，回答里也不会出现", () => {
    const sneaky: PromptDraft = { picks: ["fast"], other: "something else", otherOn: true };
    expect(draftAnswer(closed, sneaky)).toEqual(["fast"]);
    expect(draftAnswer(closed, { picks: [], other: "something else", otherOn: true })).toEqual([]);
  });

  it("答案里不会出现可选项之外的标签（草稿里残留的旧选择被忽略）", () => {
    expect(draftAnswer(single, { picks: ["gone", "core"], other: "", otherOn: false })).toEqual(["core"]);
  });

  it("没有可选项的问题：写什么就答什么；点“其他”不改变草稿", () => {
    expect(pickOther(free, emptyDraft(free))).toEqual(emptyDraft(free));
    const draft = typeOther(free, emptyDraft(free), "hello");
    expect(draft).toEqual({ picks: [], other: "hello", otherOn: true });
    expect(draftAnswer(free, draft)).toEqual(["hello"]);
    expect(draftAnswer(free, typeOther(free, draft, "   "))).toEqual([]);
  });

  it("每个问题都有答案，“回答”才可用；没有问题时也不可用", () => {
    const drafts = [pickOption(single, emptyDraft(single), "core"), emptyDraft(free)];
    expect(answersReady([single, free], drafts)).toBe(false);
    expect(answersReady([single, free], [drafts[0]!, typeOther(free, drafts[1]!, "ok")])).toBe(true);
    expect(answersReady([], [])).toBe(false);
    // 草稿比问题少（理论上不会）：缺的那一项算没答。
    expect(answersReady([single, free], [drafts[0]!])).toBe(false);
  });

  it("请求体：每个问题一项，与问题一一对应", () => {
    const drafts = [pickOption(single, emptyDraft(single), "web"), typeOther(free, emptyDraft(free), " done "), typeOther(multi, pickOption(multi, emptyDraft(multi), "mac"), "bsd")];
    expect(answerBody([single, free, multi], drafts)).toEqual({ answers: [["web"], ["done"], ["mac", "bsd"]] });
  });

  it("草稿缺失时请求体用空答案占位，不抛错", () => {
    expect(answerBody([single, free], [])).toEqual({ answers: [[], []] });
  });
});

describe("回答时的冲突与过期的措辞", () => {
  const t = bindT("zh");
  const text = (key: string): string => zh[key] as string;

  it("409 里服务端附带的提问状态决定说什么；认不出的状态不编造", () => {
    expect(conflictKey({ status: "answered" })).toBe("question.conflict.answered");
    expect(conflictKey({ status: "declined" })).toBe("question.conflict.declined");
    expect(conflictKey({ status: "expired" })).toBe("question.conflict.expired");
    expect(conflictKey({ status: "open" })).toBe("question.conflict.busy");
    expect(conflictKey({ status: "mystery" })).toBeUndefined();
    expect(conflictKey({ status: 3 })).toBeUndefined();
    expect(conflictKey({})).toBeUndefined();
    expect(conflictKey(undefined)).toBeUndefined();
  });

  it("每一种过期原因都有自己的措辞", () => {
    const reasons: QuestionExpiry[] = ["timeout", "withdrawn", "run_ended", "cancelled", "session_closed", "restarted", "not_waiting"];
    for (const reason of reasons) {
      const outcome: QuestionOutcomeRecord = { at: AT, by: SYSTEM, reason };
      expect(expiryText(outcome, t), reason).toBe(text(`question.expiry.${reason}`));
    }
    expect(new Set(reasons.map((reason) => text(`question.expiry.${reason}`))).size).toBe(reasons.length);
  });

  it("时限到了且 Ensemble 已告知执行端自行判断：单独说明；没告知成就只说时限到了", () => {
    expect(expiryText({ at: AT, by: SYSTEM, reason: "timeout", delivery: "handed_off" }, t)).toBe(text("question.expiry.timeoutTold"));
    expect(expiryText({ at: AT, by: SYSTEM, reason: "timeout", delivery: "not_waiting" }, t)).toBe(text("question.expiry.timeout"));
    expect(expiryText({ at: AT, by: SYSTEM, reason: "timeout" }, t)).toBe(text("question.expiry.timeout"));
  });

  it("没有记下原因就不编造（旧日志或残缺的记录）", () => {
    expect(expiryText({ at: AT, by: SYSTEM }, t)).toBeUndefined();
  });

  it("署名：用户写成“你”，主 Agent 用来源宿主给的名字，系统用它自己的标签", () => {
    expect(actorName({ kind: "user", label: "You" }, t)).toBe("你");
    expect(actorName({ kind: "user", label: "You" }, bindT("en"))).toBe("You");
    expect(actorName({ kind: "agent", label: "Codex" }, t)).toBe("Codex");
    expect(actorName(SYSTEM, t)).toBe("Ensemble");
  });
});

describe("词汇：提问不是授权", () => {
  // 提问、待回答、回答、不回答、过期是固定词汇；授权类的词一旦混进来，用户就会把提问当成要批准的闸门。
  const questionEntries = (dict: Dict): Array<[string, string]> =>
    Object.entries(dict)
      .filter(([key]) => key.includes("question"))
      .map(([key, entry]): [string, string] => [key, typeof entry === "function" ? entry({ n: 2, i: 1, q: "x", d: "1m" }) : entry]);

  it("两种语言里与提问有关的文案都不带授权、批准、允许、拒绝一类的词", () => {
    const zhHits = questionEntries(zh).filter(([, value]) => /授权|批准|许可|允许|拒绝|同意/.test(value));
    const enHits = questionEntries(en).filter(([, value]) => /authori[sz]|approv|permission|allow|reject|deny|denied|consent/i.test(value));
    expect(zhHits).toEqual([]);
    expect(enHits).toEqual([]);
  });

  it("两种语言的提问文案键完全一致，也都有内容", () => {
    const zhKeys = questionEntries(zh).map(([key]) => key).sort();
    const enKeys = questionEntries(en).map(([key]) => key).sort();
    expect(zhKeys).toEqual(enKeys);
    expect(zhKeys.length).toBeGreaterThan(20);
    for (const [, value] of [...questionEntries(zh), ...questionEntries(en)]) expect(value.trim()).not.toBe("");
  });
});
