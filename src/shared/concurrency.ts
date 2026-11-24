import { LIMITS } from "./constants";
import type { ConcurrencyValue } from "./protocol";

/**
 * 设置里“并发上限”的取值规则：1–1000 的整数，或 "unlimited"。
 * 服务端（settings.json、PUT 请求体）与网页（输入框的草稿）共用这一份，免得两边各写一遍而慢慢对不上。
 * 0、负数、小数、字符串形式的数字（"5"）、null 都不是合法取值——“不设上限”只有 "unlimited" 一种写法，
 * 不靠 0：手改文件时 0 既可能被读成“不限”也可能被读成“一个都不许跑”，干脆不接受。
 */
export function isConcurrencyValue(value: unknown): value is ConcurrencyValue {
  if (value === "unlimited") return true;
  const { min, max } = LIMITS.concurrentRunsSetting;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** 给调用方看的取值规则（英文，服务端的错误信息用），数字取自 LIMITS，改范围时不会忘了这句话。 */
export const CONCURRENCY_RULE = `an integer from ${LIMITS.concurrentRunsSetting.min} to ${LIMITS.concurrentRunsSetting.max}, or "unlimited"`;
