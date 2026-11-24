import type { ModelRef } from "@shared/types";

/** 有品牌标的模型家族。认不出的家族不画标，也不拿别家的标顶替。 */
export type ModelFamily =
  | "deepseek"
  | "claude"
  | "openai"
  | "gemini"
  | "grok"
  | "kimi"
  | "glm"
  | "qwen"
  | "mistral"
  | "llama"
  | "minimax"
  | "composer";

type Matcher = (token: string) => boolean;

const startsWith =
  (...prefixes: string[]): Matcher =>
  (token) =>
    prefixes.some((prefix) => token.startsWith(prefix));

/**
 * 按“名字里出现了谁”判断，规则顺序即优先级：
 * 蒸馏、微调的模型名里常带着底座的名字（deepseek-r1-distill-llama-70b），
 * 应当认作发布它的那一家，所以底座家族（llama、qwen）排在后面或靠前的发布者之后。
 */
const RULES: ReadonlyArray<readonly [ModelFamily, Matcher]> = [
  ["deepseek", startsWith("deepseek")],
  ["kimi", startsWith("kimi", "moonshot")],
  ["glm", (token) => /^(chat)?glm/.test(token) || token === "zhipu"],
  ["minimax", startsWith("minimax")],
  ["qwen", startsWith("qwen", "qwq")],
  ["claude", (token) => token.startsWith("claude") || token === "opus" || token === "sonnet" || token === "haiku"],
  ["openai", (token) => token.startsWith("gpt") || token === "chatgpt" || token === "codex" || /^o[1-9]$/.test(token)],
  ["gemini", startsWith("gemini")],
  ["grok", startsWith("grok")],
  ["mistral", startsWith("mistral", "mixtral", "codestral", "devstral", "magistral")],
  ["llama", startsWith("llama")],
  // Cursor 自家的模型。
  ["composer", (token) => token === "composer"],
];

const tokensOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * 根据执行端报上来的模型标识判断所属家族。
 * 已解析出的模型（resolved、展示名）优先于请求时写的名字：请求的可能是 “auto” 这类别名。
 */
export function modelFamily(model: ModelRef | undefined): ModelFamily | undefined {
  if (!model) return undefined;
  for (const text of [model.resolved, model.label, model.requested]) {
    if (!text) continue;
    const tokens = tokensOf(text);
    for (const [family, matches] of RULES) {
      if (tokens.some(matches)) return family;
    }
  }
  return undefined;
}
