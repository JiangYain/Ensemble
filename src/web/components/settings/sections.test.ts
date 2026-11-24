import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { en } from "../../lib/dict-en";
import { zh } from "../../lib/dict-zh";
import { store } from "../../lib/app";
import { bindT } from "../../lib/i18n";
import { SECTIONS, SECTION_LIST, type SettingsSectionId } from "./sections";

/**
 * 登记表的不变量：设置窗口只认这张表，所以表本身必须自洽——
 * 重复的 id、缺的译文、不存在的图标，都应该在这里红，而不是到窗口里才发现。
 */
describe("设置分区登记表", () => {
  it("id 唯一、非空、只含小写字母与连字符（它会写进 DOM 的 data-section 与 store）", () => {
    const ids = SECTION_LIST.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("现有四个分区，顺序固定：执行端在前（有实质内容的先出现），角色紧随其后（它的选项来自执行端的设置），通用在后，历史排在最末（回看与留存，不影响委派）；窗口默认落在第一项", () => {
    expect(SECTION_LIST.map((section) => section.id)).toEqual(["executors", "profiles", "general", "history"]);
  });

  it("SECTION_LIST 就是 SECTIONS：没有第二份清单，也没有漏掉或多出的项", () => {
    expect(SECTION_LIST).toHaveLength(SECTIONS.length);
    expect(SECTION_LIST.map((section) => section.id)).toEqual(SECTIONS.map((section) => section.id));
  });

  it("SettingsSectionId 由登记表推导：加一项它就多一个成员，不用另外维护联合类型", () => {
    expectTypeOf<SettingsSectionId>().toEqualTypeOf<"executors" | "profiles" | "general" | "history">();
  });

  it("每个分区的名字在中英文字典里都有，且互不相同（导航里不能出现两个同名项）", () => {
    for (const dict of [zh, en]) {
      const labels = SECTION_LIST.map((section) => dict[section.labelKey]);
      for (const label of labels) expect(typeof label).toBe("string");
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("每个分区都有可渲染的内容组件；操作区组件是可选的，给了就必须是组件", () => {
    for (const section of SECTION_LIST) {
      expect(typeof section.Component, section.id).toBe("function");
      if (section.actions) expect(typeof section.actions, section.id).toBe("function");
    }
  });

  it("导航小字（summary）是纯函数：只读 store 状态与翻译，返回字符串或 undefined，不抛错", () => {
    for (const lang of ["zh", "en"] as const) {
      const t = bindT(lang);
      for (const section of SECTION_LIST) {
        const value = section.summary?.({ ...store.get(), lang }, t);
        expect(value === undefined || typeof value === "string", `${section.id} ${lang}`).toBe(true);
      }
    }
  });

  it("设置窗口里不出现任何具体分区的 id：它只遍历登记表（不会有 if (section === 'executors')）", () => {
    const source = readFileSync("src/web/components/settings/SettingsWindow.tsx", "utf8");
    for (const section of SECTION_LIST) expect(source, section.id).not.toMatch(new RegExp(`["'\`]${section.id}["'\`]`));
  });
});
