/**
 * 凡是要写进事件、日志或错误信息的执行端原文，都先过一遍这里（OpenCode 的错误文本与 stderr、
 * 各执行端的提问原文……）：它们偶尔会带上提供商返回的片段，里面可能有密钥。
 * 原本在 opencode-items.ts；提问的转交需要在 Codex 与 OpenCode 两边共用同一份口径，所以放到这里，
 * opencode-items.ts 仍然从那里重新导出，原有的引用与测试不受影响。
 */

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-***"],
  // 不含 authorization：它的值常是 “Bearer xxx”，由上面第一条处理，免得把 “Bearer” 当成值遮掉、后面的令牌反而漏出。
  [/\b(api[_-]?key|token|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1$2***"],
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}
