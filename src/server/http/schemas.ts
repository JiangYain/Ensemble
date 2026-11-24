import { z } from "zod";
import { retentionFault } from "@shared/archive";
import { CONCURRENCY_RULE, isConcurrencyValue } from "@shared/concurrency";
import { LIMITS } from "@shared/constants";
import { contextItem } from "@shared/context-schema";
import { PROFILE_FIELD_MAX } from "@shared/profiles";
import type { ConcurrencyValue } from "@shared/protocol";
import { REPORT_DETAILS, REPORT_LANGS, REPORT_LIMITS, REPORT_SCOPES } from "@shared/report-options";

/** HTTP 请求体校验。字段命名与 src/shared/protocol.ts 保持一致。 */

const harnessId = z.enum(["cursor", "codex", "pi", "claude", "opencode", "dsh", "fixture"]);
const accessLevel = z.enum(["read_only", "full"]);

/**
 * 随任务带上的上下文条目：定义已移到 shared/context-schema.ts（MCP 的 `delegate` 入参与这里共用同一份），
 * 这里保留原来的导出，按 `server/http/schemas` 取它的写法照常成立。
 */
export { contextItem };

const sessionRef = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["session", "thread", "conversation"]),
  // declared = Agent 通过工具参数 conversationId 自报的标识（不是宿主给的）。老服务只认前三个值：
  // 桥靠 service.json / 健康检查里的 features（declared-session-ref）判断，老服务就不发 sessionRef，见 src/mcp/delegate-request.ts。
  source: z.enum(["mcp-meta", "env", "declared", "console"]),
});

const origin = z.object({
  key: z.string().min(1).max(300),
  kind: z.enum(["agent", "user"]),
  host: z.enum(["codex", "cursor", "claude", "pi", "vscode", "console", "unknown"]),
  hostLabel: z.string().min(1).max(80),
  sessionRef: sessionRef.optional(),
  clientInfo: z.object({ name: z.string().max(200), version: z.string().max(100).optional() }).optional(),
  workspace: z.string().max(2_000).optional(),
  // host-record 是后加的取值：老服务只认前两个，桥靠 service.json / 健康检查里的 features（host-record-workspace）判断，老服务就不发它，见 src/mcp/delegate-request.ts。
  workspaceSource: z.enum(["host-record", "mcp-roots", "delegate-cwd"]).optional(),
  hostTitle: z.string().min(1).max(300).optional(),
  evidence: z.array(z.string().max(200)).max(20),
});

export const delegateBody = z.object({
  // harness 与 profile 至少要有一个：这里只校验形状，“两个都没有”由委派入口给出带说明的错误。
  // profile 只限长度、不限字符：写不合规的名字得到的是“没有这个角色，现有的有……”，比一条格式错误有用。
  harness: harnessId.optional(),
  profile: z.string().min(1).max(100).optional(),
  task: z.string().min(1).max(LIMITS.maxTaskChars),
  title: z.string().max(120).optional(),
  cwd: z.string().min(1).max(2_000),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(40).optional(),
  access: accessLevel.optional(),
  context: z.array(contextItem).max(50).optional(),
  origin: origin.optional(),
  parentSessionId: z.string().max(100).optional(),
  // 汇聚：只核对形状。空数组、个数上限、与 parentSessionId 对不对得上由委派入口按同一条规则说明白（normalizeParents），
  // 比一条通用的校验错误有用。老服务不认识这个键：Zod 对象会丢掉它，委派只会接在 parentSessionId 后面——桥靠 features 里的 multi-parent 判断，见 src/mcp/delegate-request.ts。
  parentSessionIds: z.array(z.string().min(1).max(100)).optional(),
  allowDuplicate: z.boolean().optional(),
});

export const sendBody = z.object({
  text: z.string().min(1).max(LIMITS.maxMessageChars),
  mode: z.enum(["auto", "steer", "follow_up"]).optional(),
  originKey: z.string().max(300).optional(),
});

/**
 * 回答执行端的提问（不是授权）：`answer` 与 `answers` 二选一，一个答案是可选项的标签，或在允许时自己写的文字；
 * 多选的一项写成字符串数组。这里只核对形状与长度，选项对不对、数量对不对由 checkAnswers 按提问本身核对。
 */
const answerValue = z.union([
  z.string().max(LIMITS.question.maxAnswerChars),
  z.array(z.string().max(LIMITS.question.maxAnswerChars)).max(LIMITS.question.maxPicks),
]);
export const answerQuestionBody = z.object({
  answer: answerValue.optional(),
  answers: z.array(answerValue).min(1).max(LIMITS.question.maxPrompts).optional(),
  originKey: z.string().max(300).optional(),
});

/** 不回答，让执行端自行判断；`note` 是附给它的一句话（可选）。 */
export const declineQuestionBody = z.object({
  note: z.string().min(1).max(LIMITS.question.maxAnswerChars).optional(),
  originKey: z.string().max(300).optional(),
});

/**
 * 至少要有 `parentSessionId` 与 `parentSessionIds` 之一：省略不等于“去掉上级”，去掉要显式写 null，空字符串也不当作 null；
 * `parentSessionIds` 是整组替换原来的上级（汇聚）。两个同时给时对不对得上、空数组与个数上限由 normalizeParents 说明白。
 */
export const relinkBody = z
  .object({
    parentSessionId: z.string().min(1, "Use null (not an empty string) to remove the parent.").max(100).nullable().optional(),
    parentSessionIds: z.array(z.string().min(1).max(100)).optional(),
  })
  .refine((body) => body.parentSessionId !== undefined || body.parentSessionIds !== undefined, {
    message: "Send parentSessionId (a session id, or null to remove the parent) or parentSessionIds (the full ordered list of parents).",
  });

export const waitBody = z.object({
  sessionIds: z.array(z.string().max(100)).min(1).max(50),
  mode: z.enum(["any_settled", "all_settled"]).optional(),
  timeoutMs: z.number().int().min(0).max(LIMITS.maxWaitMs).optional(),
  originKey: z.string().max(300).optional(),
  attention: z.boolean().optional(),
});

export const collectBody = z.object({ originKey: z.string().min(1).max(300) });

/** 归档 / 取消归档：要处理的会话 id（规则见 shared/archive.ts）。一次的数量有上限，再多的分批发。 */
export const archiveBody = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1).max(LIMITS.maxArchiveIds),
});

/**
 * 取消归档的请求体：`archiveBody` 加一个可选的 `exact`（只恢复点名的会话，撤销刚才那次归档用，见 shared/archive.ts 的 UnarchiveOptions）。
 * 不带它的请求（老网页、直接点“取消归档”）与原来一字不差；它必须是布尔值，别的取值让整个请求按 400 拒绝，不悄悄当成缺省。
 * 展开 `archiveBody.shape` 而不用 `.extend`：`ids` 的校验只此一份；zod 4 对带 refine 的对象调 `.extend` 有限制，将来 `archiveBody` 加了校验时这里不用跟着改写。
 */
export const unarchiveBody = z.object({ ...archiveBody.shape, exact: z.boolean().optional() });

/**
 * 留存策略：两个键都必须出现，`null` 表示这一项不限（省略不等于不限，与 relinkBody 同一条规矩）。
 * 取值规则（1 起的整数、有上限）只此一处（shared/archive.ts 的 retentionFault），SettingsStore 写入时按同一份再验一遍。
 */
const retentionValue = z.custom<number | null>((value) => value === null || (typeof value === "number" && Number.isFinite(value)), {
  message: "Use a whole number of at least 1, or null for no limit.",
});
export const retentionBody = z
  .object({ keepDays: retentionValue, keepCount: retentionValue })
  .superRefine((value, ctx) => {
    for (const field of ["keepDays", "keepCount"] as const) {
      const fault = retentionFault(field, value[field]);
      if (fault) ctx.addIssue({ code: "custom", path: [field], message: fault, input: value[field] });
    }
  });

/**
 * 按模型 id 的档位记录的形状：至多 5000 个模型，每个模型 1–50 个档位名，名字 1–40 个字符。
 * 不用 `z.record`：zod 4 的 record 会静默跳过名叫 `__proto__` 的键，只有这个键时整张表解析成 `{}`，
 * 被当成“清空所有档位记录”。这里只核对形状、原样放行 JSON 里的对象；名字与档位的细则由 `SettingsStore` 再验一遍。
 */
function isEffortRecord(value: unknown): value is Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 5_000 &&
    entries.every(
      ([id, list]) =>
        id.length >= 1 &&
        id.length <= 200 &&
        Array.isArray(list) &&
        list.length >= 1 &&
        list.length <= 50 &&
        list.every((name) => typeof name === "string" && name.length >= 1 && name.length <= 40),
    )
  );
}

/**
 * 设置某个执行端开放的模型；`null` 去掉限制。空数组是合法的：一个都不开放。
 * `efforts` 是按模型 id 的完整档位记录，每项至少留一档；省略表示不改动已有记录，`{}` 清空。
 * `userDefaultModel`：字符串＝指定默认模型，`null`＝恢复执行端自己的默认，省略＝不改动（是否可选由保存入口按名单与目录核对）。
 */
export const setModelsBody = z.object({
  allowed: z.array(z.string().min(1).max(200)).max(5_000).nullable(),
  efforts: z.custom<Record<string, string[]>>(isEffortRecord, { message: "Each model needs 1-50 efforts of 1-40 characters, for at most 5000 models." }).optional(),
  userDefaultModel: z.string().min(1).max(200).nullable().optional(),
});

/**
 * 指定全局并发上限：`max` 键必须出现——正整数（1–1000）或 "unlimited" 是指定，`null` 是清掉指定（回到环境变量 / 内置默认）；
 * 省略不等于清掉（与 relinkBody 同一条规矩）。取值规则与 settings.json 同一份（shared/concurrency.ts），SettingsStore 还会再验一遍。
 */
export const setConcurrencyBody = z.object({
  max: z.custom<ConcurrencyValue | null>((value) => value === null || isConcurrencyValue(value), { message: `Use ${CONCURRENCY_RULE}, or null to restore the default.` }),
});

/**
 * 新增或整条改写一个角色。`harness` 不限定为已知的执行端：这一版不认识的执行端 id 也能存（保留、标为暂时不可用），
 * 是否是已启用的执行端由保存入口按服务端当前的执行端核对。取值的长度上限与委派请求里同名字段一致。
 */
export const putProfileBody = z.object({
  harness: z.string().min(1).max(PROFILE_FIELD_MAX.harness),
  model: z.string().min(1).max(PROFILE_FIELD_MAX.model).optional(),
  effort: z.string().min(1).max(PROFILE_FIELD_MAX.effort).optional(),
  access: accessLevel.optional(),
  create: z.boolean().optional(),
});

export const renameProfileBody = z.object({ to: z.string().min(1).max(200) });

/**
 * 导出会话报告的查询参数（`GET /api/sessions/:id/report`）：全是可选的，写错了明确拒绝而不是悄悄当成缺省值——
 * 误拼的 `detail=ful` 会让调用方以为拿到了完整版。`token` 等不认识的参数被忽略（zod 对象默认丢弃多余的键）。
 * 取值范围只此一处（shared/report-options.ts 与 LIMITS）。`format` 目前只有 markdown：写成别的（比如还没有的 bundle）得到 400，而不是悄悄回一份 Markdown。
 * maxChars 缺省为上限，即默认不截断；下限见 REPORT_LIMITS.minChars。
 */
export const reportQuery = z.object({
  scope: z.enum(REPORT_SCOPES).default("session"),
  detail: z.enum(REPORT_DETAILS).default("brief"),
  lang: z.enum(REPORT_LANGS).default("en"),
  format: z.enum(["markdown"]).default("markdown"),
  maxChars: z.coerce.number().int().min(REPORT_LIMITS.minChars).max(LIMITS.maxReportChars).default(LIMITS.maxReportChars),
});

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
