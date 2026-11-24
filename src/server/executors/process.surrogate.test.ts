import { describe, expect, it } from "vitest";
import { runCapture, spawnJsonl, type ExitInfo } from "./process";

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";
/** 孤立的高位或低位代理项（诊断文字里会变成乱码字符）。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** 子进程脚本里写 😀 的表达式。脚本里的字符串一律用单引号，免得 Windows 命令行的引号转义碍事。 */
const EMOJI_EXPR = "String.fromCodePoint(0x1F600)";

/** 起一个真的 node 子进程跑 script，收集 runCapture 的尾窗口（stdout 留 64000、stderr 留 16000 个码元）。 */
const capture = (script: string) => runCapture(process.execPath, ["-e", script], { timeoutMs: 15_000 });

/** 起一个真的 node 子进程跑 script，等它退出，取 spawnJsonl 留下的 stderr 尾窗口（6000 个码元）。 */
function exitOf(script: string): Promise<ExitInfo> {
  return new Promise((resolve) => {
    spawnJsonl(process.execPath, ["-e", script], { cwd: process.cwd() }).onExit(resolve);
  });
}

/**
 * 三处尾窗口（子进程输出只留最后 N 个码元）。窗口的起点落在 😀 中间时少留一个码元，不留孤立的低位代理项。
 * 带 😀 的输入总长要么刚好等于窗口（不动），要么只比窗口多一个码元（只在最后一块到达时才动），所以分几块写、分几块读都不影响结果。
 */
describe("runCapture: stdout / stderr tails do not start inside an emoji", () => {
  it("leaves the emoji out of a stdout tail that would start in the middle of it", async () => {
    // 😀 占下标 0、1，后面 63999 个 a，共 64001 个码元：留最后 64000 个会从低位代理开始，所以再让出一个，只剩 63999 个 a。
    const result = await capture(`process.stdout.write(${EMOJI_EXPR} + 'a'.repeat(63999))`);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("a".repeat(63_999));
    expect(LONE.test(result.stdout)).toBe(false);
  });

  it("keeps an emoji that fits inside the stdout tail", async () => {
    // 63998 个 a 加 😀 正好 64000 个码元，没有越过窗口，整段原样保留。
    const result = await capture(`process.stdout.write('a'.repeat(63998) + ${EMOJI_EXPR})`);
    expect(result.stdout).toBe(`${"a".repeat(63_998)}${EMOJI}`);
    expect(result.stdout).toHaveLength(64_000);
  });

  it("does the same for the 16000-unit stderr tail", async () => {
    const result = await capture(`process.stderr.write(${EMOJI_EXPR} + 'b'.repeat(15999))`);
    expect(result.stderr).toBe("b".repeat(15_999));
    expect(LONE.test(result.stderr)).toBe(false);

    const fits = await capture(`process.stderr.write('b'.repeat(15998) + ${EMOJI_EXPR})`);
    expect(fits.stderr).toBe(`${"b".repeat(15_998)}${EMOJI}`);
  });

  it("still keeps exactly the last 64000 / 16000 units of plain text", async () => {
    const result = await capture("process.stdout.write('a'.repeat(70000)); process.stderr.write('b'.repeat(20000))");
    expect(result.stdout).toBe("a".repeat(64_000));
    expect(result.stderr).toBe("b".repeat(16_000));
  });
});

describe("spawnJsonl: the stderr tail kept for diagnostics does not start inside an emoji", () => {
  it("leaves the emoji out when the 6000-unit window would start in the middle of it", async () => {
    // 共 6001 个码元：😀 占下标 0、1，留最后 6000 个会从低位代理开始，所以只剩 5999 个 c。
    const info = await exitOf(`process.stderr.write(${EMOJI_EXPR} + 'c'.repeat(5999))`);
    expect(info.stderrTail).toBe("c".repeat(5_999));
    expect(LONE.test(info.stderrTail)).toBe(false);
  });

  it("keeps an emoji that fits inside the window", async () => {
    // 5998 个 c 加 😀 正好 6000 个码元，原样保留。
    const info = await exitOf(`process.stderr.write('c'.repeat(5998) + ${EMOJI_EXPR})`);
    expect(info.stderrTail).toBe(`${"c".repeat(5_998)}${EMOJI}`);
  });

  it("still keeps exactly the last 6000 units of plain text", async () => {
    const info = await exitOf("process.stderr.write('c'.repeat(9000))");
    expect(info.stderrTail).toBe("c".repeat(6_000));
  });
});
