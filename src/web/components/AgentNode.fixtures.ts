/**
 * 会话卡片测试共用的夹具（只被测试引用，不进页面的打包）：一个够用的假引擎，以及读 scene.css 原文的小工具。
 * 头部与正文图标、菜单与标记、氤氲各一份测试：AgentNode.test.tsx、AgentNode.menu.test.tsx、AgentNode.aura.test.tsx。
 */

// tsconfig.web.json 只带 vite/client 的类型，而这个文件不是测试文件、会被它编译：显式引入 node 的类型，才能用 node:fs。
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { SceneEngine } from "../scene/engine";

export const engine = { register: () => () => undefined, toggleSelection: vi.fn(), moveNode: vi.fn() } as unknown as SceneEngine;

// ---- 读样式表原文的小工具 ----
// 测试环境不做布局，也不求值容器查询：头部的弹性与收起、氤氲的参数与显隐条件，只能直接读 scene.css 的写法来守住。

/** scene.css 原文，去掉注释（免得断言匹配到说明文字）。 */
export const sceneCss = (): string => readFileSync("src/web/styles/scene.css", "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * 一条规则的声明块。选择器须与源码写法完全一致（选择器列表连换行都要一样）；声明块里没有嵌套花括号。
 * 规则必须从行首起笔，并且前面是上一条规则的收尾 `}`（或文件开头）：选择器列表 `.a::before,\n.a::after {…}` 里排在后面的那一个也在行首，
 * 可它前面是逗号，不是一条规则的起点——不加这条限制，找 `.a::after` 会误取到这条共用规则。
 */
export const ruleBody = (css: string, selector: string): string => {
  const match = new RegExp(`(?:^|(?<=\\}\\s*)\\n)${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`).exec(css);
  if (!match) throw new Error(`scene.css 里没有这条规则：${selector}`);
  return match[1]!;
};
/** 声明块 → 属性表（值保留原写法，只去掉首尾空白）。 */
export const declared = (body: string): Record<string, string> =>
  Object.fromEntries(
    body
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part): [string, string] => {
        const colon = part.indexOf(":");
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
      }),
  );
