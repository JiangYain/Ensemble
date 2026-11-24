import { describe, expect, it } from "vitest";
import { modelFamily } from "./modelFamily";

const family = (resolved?: string, label?: string, requested?: string) =>
  modelFamily({ ...(resolved ? { resolved } : {}), ...(label ? { label } : {}), ...(requested ? { requested } : {}) });

describe("modelFamily", () => {
  it("认出真实会话里出现过的模型：标识与展示名两种写法", () => {
    expect(family("deepseek-v41-flash-1017", "DeepSeek V4.1 Flash 1017")).toBe("deepseek");
    expect(family("deepseek-v41-flash-1017")).toBe("deepseek");
    expect(family(undefined, "DeepSeek V4.1 Flash 1017")).toBe("deepseek");
  });

  it("各家的常见命名", () => {
    expect(family("claude-opus-4-1")).toBe("claude");
    expect(family("claude-4.5-sonnet", "Sonnet 4.5")).toBe("claude");
    expect(family(undefined, "Opus 4.1")).toBe("claude");
    expect(family("gpt-5.1-codex-max")).toBe("openai");
    expect(family("gpt-oss-120b")).toBe("openai");
    expect(family("o3-mini")).toBe("openai");
    expect(family("codex-mini-latest")).toBe("openai");
    expect(family("gemini-2.5-pro")).toBe("gemini");
    expect(family("grok-4")).toBe("grok");
    expect(family("kimi-k2-0905")).toBe("kimi");
    expect(family("moonshot-v1-8k")).toBe("kimi");
    expect(family("glm-4.6")).toBe("glm");
    expect(family("chatglm3-6b")).toBe("glm");
    expect(family("qwen3-coder-480b")).toBe("qwen");
    expect(family("mistral-large-latest")).toBe("mistral");
    expect(family("codestral-2501")).toBe("mistral");
    expect(family("llama-3.3-70b-instruct")).toBe("llama");
    expect(family("MiniMax-M2")).toBe("minimax");
    expect(family("composer-1")).toBe("composer");
  });

  it("Pi 的 provider/model 写法：按模型名认，路径前缀不干扰", () => {
    expect(family("anthropic/claude-sonnet-4")).toBe("claude");
    expect(family("openrouter/deepseek/deepseek-chat")).toBe("deepseek");
    expect(family("google/gemini-2.5-flash", "Gemini 2.5 Flash")).toBe("gemini");
  });

  it("蒸馏、微调的名字归发布它的那一家，而不是底座", () => {
    expect(family("deepseek-r1-distill-llama-70b")).toBe("deepseek");
    expect(family("deepseek-r1-distill-qwen-32b")).toBe("deepseek");
  });

  it("按词匹配，不会被名字里的片段误伤", () => {
    // “o1” 只认整词；其他词里碰巧含有 o1 / gpt / glm 之类的片段不算。
    expect(family("proto1-model")).toBeUndefined();
    expect(family("hello1-v2")).toBeUndefined();
    expect(family("agpt-like")).toBeUndefined();
  });

  it("已解析出的模型优先于请求时写的别名", () => {
    expect(family("claude-4.5-sonnet", "Sonnet 4.5", "auto")).toBe("claude");
    expect(family(undefined, undefined, "gpt-5")).toBe("openai");
  });

  it("认不出就是没有：别名、默认值、模拟执行端的假模型都不画标", () => {
    expect(family("default", "Auto", "auto")).toBeUndefined();
    expect(family("fixture-fast", "Fixture Fast")).toBeUndefined();
    expect(family("some-unknown-model-7b")).toBeUndefined();
    expect(modelFamily(undefined)).toBeUndefined();
    expect(modelFamily({})).toBeUndefined();
  });
});
