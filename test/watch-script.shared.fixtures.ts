/**
 * 看门狗脚本测试里不止一个测试文件用到的样本：每一种“值得留意”各一份。
 * 对照应用的措辞与标识（watch-script.copies.test.ts）和逐会话的判断（watch-script.test.ts）都要用它。
 * 从 test/watch-script.test.ts 原样搬出，只加了 export。
 */
import type { AttentionItem } from "../src/shared/types";
import { at } from "./watch-script.fixtures";

export const attentionSamples: Record<string, AttentionItem> = {
  quiet: { kind: "quiet", since: at(-300_000), seq: 41, runId: "run_1" },
  long_tool: {
    kind: "long_tool",
    since: at(-700_000),
    seq: 52,
    tool: { callId: "call_7", name: "shell", category: "shell", title: "npm run build\n   --verbose", startedAt: at(-720_000) },
    runId: "run_1",
  },
  long_run: { kind: "long_run", since: at(-4_000_000), runId: "run_1" },
  shared_file: {
    kind: "shared_file",
    since: at(-90_000),
    path: "C:\\work\\app\\packages\\core\\src\\deeply\\nested\\directory\\structure\\shared-module.ts",
    withSessionIds: ["ses_b", "ses_c"],
  },
  undelivered: { kind: "undelivered", since: at(-200_000), messageId: "msg_3", messageKind: "steer", stage: "handed_off" },
  question: {
    kind: "question",
    since: at(-150_000),
    questionId: "qst_1",
    prompts: [{ key: "scope", header: "Scope", text: "Should the migration\n   also cover the legacy tables?", options: [{ label: "Yes" }, { label: "No", description: "leave them" }], multiple: false, custom: true }],
    runId: "run_1",
  },
};
