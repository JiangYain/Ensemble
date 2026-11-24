/**
 * 看门狗脚本（skills/ensemble-delegate/scripts/watch.mjs）自带的那几份“与应用同口径”的拷贝，对照应用的真实实现。
 *
 * 脚本要能脱离本仓库独立运行（只带 Node 内置模块、只读服务的 HTTP 接口），所以它自己带了一小份
 * “与应用同口径”的逻辑（时长写法、会话是否已结束、值得留意的措辞与标识、状态目录）。
 * 这里用对照测试把这几份拷贝钉在应用的真实实现上：应用改了、脚本没跟上，测试会红。
 *
 * 脚本其余部分的测试在同目录：watch-script.test.ts（判断逻辑）、watch-script.pass.test.ts（巡检流程与输出格式）、
 * watch-script.run.test.ts（当作脚本跑、随插件分发）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeAttention as appDescribeAttention, harnessLabel as appHarnessLabel } from "../src/mcp/format";
import { resolveHome as appResolveHome } from "../src/server/paths";
import { attentionKey as appAttentionKey } from "../src/shared/attention";
import { clip as appClip, collapseWhitespace, formatDuration as appFormatDuration, shortenPath as appShortenPath } from "../src/shared/format";
import { isSessionSettled } from "../src/shared/session-end";
import type { AttentionItem, SessionSummary } from "../src/shared/types";
import { at, cleanup, NOW, root, watch } from "./watch-script.fixtures";
import { attentionSamples } from "./watch-script.shared.fixtures";

// 拆分前这是整份测试文件的文件级钩子（对每个用例都生效）；这个文件里没有东西要清理，留着它是为了与拆分前的语义完全相同。
afterEach(cleanup);

const typesSource = readFileSync(join(root, "src", "shared", "types.ts"), "utf8");
function unionMembers(name: string): string[] {
  const body = new RegExp(`export type ${name} =([^;]+);`).exec(typesSource)?.[1] ?? "";
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] as string);
}

// ───────────────────────── 与应用同口径 ─────────────────────────

describe("the copies of shared logic stay in step with the app", () => {
  const harnesses = ["cursor", "codex", "pi", "claude", "opencode", "dsh", "fixture"] as const;
  const runtimes = ["native", "driver", "fixture"] as const;
  const phases = ["ready", "starting", "queued", "running", "done", "failed", "cancelled", "stopped", "lost"] as const;

  it("formats durations the way the MCP output does", () => {
    for (const ms of [0, 999, 1000, 59_999, 60_000, 61_000, 3_599_999, 3_600_000, 3_661_000, 90_061_000, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(watch.formatDuration(ms), String(ms)).toBe(appFormatDuration(ms));
    }
  });

  it("clips text the way the server does", () => {
    const samples = ["short", "a b c d e f g h i j", "line one\nline two\n\n   spaced   out", "x".repeat(300), `${"word ".repeat(40)}end`, "边界 测试 ".repeat(30), ""];
    for (const text of samples) {
      for (const max of [1, 5, 10, 24, 80, 120]) expect(watch.clip(text, max), `${max}: ${text}`).toBe(appClip(collapseWhitespace(text), max));
    }
  });

  it("shortens paths the way the server does", () => {
    const paths = ["a.ts", "src/parser/index.ts", "C:\\Users\\someone\\Desktop\\project\\packages\\core\\src\\very\\deep\\folder\\file-name.test.tsx", `${"d/".repeat(40)}${"n".repeat(70)}.ts`, "/"];
    for (const path of paths) {
      for (const max of [10, 30, 52, 90]) expect(watch.shortenPath(path, max), `${max}: ${path}`).toBe(appShortenPath(path, max));
    }
  });

  it("shortens paths the way the server does at every width, down to a name that only just fits", () => {
    // max 取遍 0 … 路径长度 + 1：文件名长 N 的路径会依次经过 N - 1、N、N + 1、N + 2（以前这一格两份都只留最后一个字符）、N + 3（开始中间省略）。
    // 含 emoji 的两条让名字里的代理对恰好落在这些边界上。
    const paths = ["src/parser/index.ts", "dir/subdir/a.ts", "C:\\work\\project\\file.txt", "dir/😀ab.ts", `/${"😀".repeat(12)}`, "/"];
    for (const path of paths) {
      for (let max = 0; max <= path.length + 1; max += 1) expect(watch.shortenPath(path, max), `${max}: ${JSON.stringify(path)}`).toBe(appShortenPath(path, max));
    }
    // 两份对得上还不够，它们不能一起错：N + 2 时整个名字都留下（以前是 "…s"）。
    expect(watch.shortenPath("src/parser/index.ts", 10)).toBe("…index.ts");
    expect(watch.shortenPath("dir/subdir/a.ts", 6)).toBe("…a.ts");
  });

  it("names harnesses the way the MCP output does", () => {
    for (const harness of harnesses) {
      for (const runtime of runtimes) expect(watch.harnessLabel({ harness, runtime }), `${harness}/${runtime}`).toBe(appHarnessLabel({ harness, runtime }));
    }
  });

  it("finds the state directory exactly like the service", () => {
    const environments: NodeJS.ProcessEnv[] = [
      { ENSEMBLE_HOME: "C:\\custom\\home" },
      { ENSEMBLE_HOME: "   ", LOCALAPPDATA: "C:\\Local", XDG_STATE_HOME: "/state" },
      { LOCALAPPDATA: "C:\\Local", XDG_STATE_HOME: "/state" },
      {},
    ];
    for (const env of environments) expect(watch.resolveHome(env), JSON.stringify(env)).toBe(appResolveHome(env));
  });

  it("knows the default state directory of every platform", () => {
    expect(watch.resolveHome({ LOCALAPPDATA: "D:\\L" }, "win32")).toBe(join("D:\\L", "Ensemble"));
    expect(watch.resolveHome({}, "darwin")).toBe(join(homedir(), "Library", "Application Support", "Ensemble"));
    expect(watch.resolveHome({ XDG_STATE_HOME: "/state" }, "linux")).toBe(join("/state", "ensemble"));
    expect(watch.resolveHome({}, "linux")).toBe(join(homedir(), ".local", "state", "ensemble"));
  });

  it("decides what counts as finished like the service does, for every phase", () => {
    expect([...phases], "a phase was added to or removed from SessionPhase: teach watch.mjs about it").toEqual(unionMembers("SessionPhase"));
    for (const phase of phases) {
      for (const pending of [0, 1]) {
        const input = { phase, messages: { total: 1, pending } };
        expect(watch.isSettled(input), `${phase} with ${pending} pending`).toBe(isSessionSettled(input satisfies Pick<SessionSummary, "phase" | "messages">));
      }
    }
  });

  it("identifies and words every kind of attention exactly like the app", () => {
    expect(Object.keys(attentionSamples).sort(), "an attention kind was added: teach watch.mjs about it").toEqual(unionMembers("AttentionKind").sort());
    const variants: AttentionItem[] = [
      ...Object.values(attentionSamples),
      ...(["task", "steer", "follow_up"] as const).flatMap((messageKind) =>
        (["recorded", "queued", "handed_off", "applied", "failed", "cancelled"] as const).map((stage): AttentionItem => ({ kind: "undelivered", since: at(-200_000), messageId: "msg_9", messageKind, stage })),
      ),
      // 提问的一行摘要：只含第一个问题；有更多问题时写“(+N more)”；问题正文超长时按 160 字截断。
      {
        kind: "question",
        since: at(-30_000),
        questionId: "qst_2",
        prompts: [
          { key: "a", text: `${"Which database should the new service use? ".repeat(8)}end`, multiple: false, custom: true },
          { key: "b", text: "And which region?", options: [{ label: "eu" }, { label: "us" }], multiple: false, custom: false },
          { key: "c", text: "Anything else?", multiple: false, custom: true },
        ],
      },
    ];
    for (const item of variants) {
      expect(watch.attentionKey(item), item.kind).toBe(appAttentionKey(item));
      for (const harness of ["codex", "dsh"] as const) {
        for (const runtime of ["native", "fixture"] as const) {
          const owner = { harness, runtime };
          expect(watch.describeAttention(item, owner, NOW), `${item.kind} ${harness}/${runtime}`).toBe(appDescribeAttention(item, owner, NOW));
        }
      }
    }
  });
});
