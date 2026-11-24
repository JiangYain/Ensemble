import { en } from "./dict-en";
import { zh } from "./dict-zh";

export type Lang = "zh" | "en";
export type Vars = Record<string, string | number>;
export type Entry = string | ((vars: Vars) => string);
export type Dict = Record<string, Entry>;

const dictionaries: Record<Lang, Dict> = { zh, en };

/**
 * 语言选择顺序：用户在界面上明确切换过的 > 任何一个信号指向中文 > 英文。
 * 信号有两个：浏览器的语言偏好，以及本地服务按操作系统语言写进页面的提示
 * （宿主内置的浏览器自带的语言往往并不代表使用者本人，所以不能只看浏览器）。
 */
export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("ensemble.lang");
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // 读取失败时按浏览器语言处理。
  }
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  if (preferred.some((tag) => tag.toLowerCase().startsWith("zh"))) return "zh";
  return serverLangHint() === "zh" ? "zh" : "en";
}

function serverLangHint(): string | null {
  return document.querySelector('meta[name="ensemble-lang"]')?.getAttribute("content") ?? null;
}

function render(entry: Entry, vars: Vars | undefined): string {
  if (typeof entry === "function") return entry(vars ?? {});
  if (!vars) return entry;
  return entry.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** 取文案；缺失时回退到中文，再回退到键名本身，界面上能一眼看出缺了什么。 */
export function translate(lang: Lang, key: string, vars?: Vars): string {
  const entry = dictionaries[lang][key] ?? dictionaries.zh[key];
  return entry === undefined ? key : render(entry, vars);
}

export type TFunction = (key: string, vars?: Vars) => string;

export function bindT(lang: Lang): TFunction {
  return (key, vars) => translate(lang, key, vars);
}
