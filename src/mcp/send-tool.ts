import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIMITS } from "@shared/constants";
import { clip, collapseWhitespace } from "@shared/format";
import type { QuestionResolvedResponse, SendResponse } from "@shared/protocol";
import { answersText } from "@shared/questions";
import type { ServiceClient } from "./client";
import { harnessLabel, renderSessionLine, sendOutcomeText } from "./format";
import { BridgeInputError, conversationIdField, type Call, type Guard, type Output } from "./tool-call";

/** `send` 工具要从桥那里借的东西：统一外壳，以及服务客户端（发消息、回复提问；回复提问要先问服务认不认识提问，所以还要 `connect`、`supports`，报错时要指向面板，所以还要 `panelUrl`）。 */
export interface SendToolDeps {
  guard: Guard;
  client: Pick<ServiceClient, "request" | "connect" | "supports" | "panelUrl">;
}

/**
 * `send` 带 `questionId`：回答（或不回答）一个待回答的提问，而不是发一条消息。
 * 提问是执行端遇到需求歧义、停下来等一个答案——不是授权，也不会让会话换阶段。
 * 老服务不认识提问：不去发那个注定 404 的请求，直接说明并指出出路。发之前查一次；发送时令牌被拒、连接被拒绝而重新发现了服务、
 * 连上的功能与之前不同（例如换成了更老的版本）时再查一次（`rebuildBody`），不然那个请求会撞上 404，得到的是一句对不上号的“列出有效的会话编号”。
 */
async function replyToQuestion(
  client: SendToolDeps["client"],
  args: {
    sessionId: string;
    questionId: string;
    text?: string | undefined;
    answer?: string | string[] | undefined;
    answers?: (string | string[])[] | undefined;
    decline?: boolean | undefined;
  },
  call: Call,
): Promise<Output> {
  const declined = args.decline === true;
  const given = [args.answer !== undefined, args.answers !== undefined, declined].filter(Boolean).length;
  if (given === 0) {
    throw new BridgeInputError("Say what to do with the question: pass `answer` (one prompt) or `answers` (several prompts, one entry each, in order), or `decline: true` to let the session use its own judgment.");
  }
  if (given > 1) throw new BridgeInputError("Pass only one of `answer`, `answers` and `decline: true`.");
  if (args.text !== undefined && !declined) {
    throw new BridgeInputError("`text` is not used when answering a question — put the answer in `answer` (or `answers`). With `decline: true`, `text` is an optional note for the session.");
  }
  await requireQuestionReplies(client, args.sessionId);
  const base = `/api/sessions/${encodeURIComponent(args.sessionId)}/questions/${encodeURIComponent(args.questionId)}`;
  const body = declined
    ? { ...(args.text ? { note: args.text } : {}), originKey: call.origin.key }
    : { ...(args.answer !== undefined ? { answer: args.answer } : { answers: args.answers }), originKey: call.origin.key };
  const response = await client.request<QuestionResolvedResponse>("POST", `${base}/${declined ? "decline" : "answer"}`, {
    body,
    timeoutMs: 30_000,
    signal: call.signal,
    // 重新发现后连上的服务功能变了：回复体没有要改的（老服务没有这条路由，不是丢字段），所以只是把“老服务不能收回复”再查一次，
    // 抛错让这次请求被拒绝而不是发出去（回调的约定见 `RequestOptions.rebuildBody`）。功能没变就照旧重发同一个 `body`。
    rebuildBody: async () => {
      await requireQuestionReplies(client, args.sessionId);
      return body;
    },
  });
  const harness = harnessLabel(response.summary);
  const { outcome } = response;
  const handed = outcome.delivery === "handed_off";
  const what = declined
    ? `Declined question ${response.questionId}: ${harness} was told you chose not to answer and to use its own judgment${args.text ? ` (your note: "${clip(collapseWhitespace(args.text), 200)}")` : ""}.`
    : `Answered question ${response.questionId} (${answersText(outcome.answers ?? [])}).`;
  const delivery = handed ? ` ${harness} has accepted it; it has not confirmed it acted on it.` : " It is recorded, but was not handed to the harness.";
  return {
    text: [`${what}${delivery}`, "", renderSessionLine(response.summary)].join("\n"),
    data: { questionId: response.questionId, status: response.status, ...(outcome.delivery ? { delivery: outcome.delivery } : {}), phase: response.summary.phase },
  };
}

/**
 * 服务不认识提问（老服务）时拒绝并指出出路：把回复发过去只会得到“No route …”的 404。连上服务之后才能问 `supports`；
 * 发送前与重新发现之后（见 `replyToQuestion` 的 `rebuildBody`）都问这同一个问题、说同一句话。
 */
async function requireQuestionReplies(client: SendToolDeps["client"], sessionId: string): Promise<void> {
  await client.connect();
  if (client.supports("session-questions")) return;
  throw new BridgeInputError(
    "The running Ensemble service is older than this plugin and cannot take replies to questions. Tell the user: they can answer in the panel " +
      `(${await client.panelUrl(sessionId)}), or restart Ensemble onto the current version.`,
  );
}

export function registerSendTool(server: McpServer, deps: SendToolDeps): void {
  server.registerTool(
    "send",
    {
      title: "Send a correction or follow-up to a session",
      description:
        "Message a delegated session. While it is running this steers it (a correction); when it is idle this starts a follow-up run in the same session. " +
        "The result states honestly whether the message was applied, only handed to the harness, or queued. The user is told about every message you send. " +
        "To reply to a question a session is waiting on (a `question` block in `status`, `wait` or `read`), pass its `questionId` with `answer`/`answers`, or `decline: true` to let the session use its own judgment — no `text` needed.",
      inputSchema: {
        sessionId: z.string().min(1).max(100),
        text: z.string().min(1).max(LIMITS.maxMessageChars).optional().describe("The message to send. Required unless you are replying to a question with `questionId`; together with `decline: true` it is an optional note for the session."),
        mode: z.enum(["auto", "steer", "follow_up"]).optional().describe("auto (default): steer if running, otherwise follow up. steer: only a mid-run correction. follow_up: wait until the current run ends."),
        questionId: z.string().min(1).max(100).optional().describe("Reply to this open question instead of sending a message: the id shown in its `question` block. Then give `answer`/`answers`, or `decline: true`."),
        answer: z
          .union([z.string().min(1).max(LIMITS.question.maxAnswerChars), z.array(z.string().min(1).max(LIMITS.question.maxAnswerChars)).min(1).max(LIMITS.question.maxPicks)])
          .optional()
          .describe("With `questionId`, for a question with one prompt: an option label (or your own text when the prompt allows it); an array of labels only for a multiple-choice prompt."),
        answers: z
          .array(
            z.union([z.string().min(1).max(LIMITS.question.maxAnswerChars), z.array(z.string().min(1).max(LIMITS.question.maxAnswerChars)).min(1).max(LIMITS.question.maxPicks)]),
          )
          .min(1)
          .max(LIMITS.question.maxPrompts)
          .optional()
          .describe("With `questionId`, for a question with several prompts: one entry per prompt, in order (an array of labels for a multiple-choice prompt)."),
        decline: z.boolean().optional().describe("With `questionId`: do not answer. The session is told you chose not to and to use its own judgment (it makes a reasonable assumption and continues)."),
        conversationId: conversationIdField,
      },
      annotations: { title: "Message a session", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      deps.guard("send", extra, args, async (call) => {
        if (args.questionId !== undefined) return replyToQuestion(deps.client, { ...args, questionId: args.questionId }, call);
        if (args.answer !== undefined || args.answers !== undefined || args.decline !== undefined) {
          throw new BridgeInputError("`answer`, `answers` and `decline` only go with `questionId`: the id of the open question you are replying to (the `question` blocks in `status`, `wait` and `read` show it).");
        }
        if (args.text === undefined) {
          throw new BridgeInputError("`text` is required: the message to send to the session. (To reply to a question instead, pass `questionId` with `answer`/`answers` or `decline: true`.)");
        }
        const response = await deps.client.request<SendResponse>("POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/messages`, {
          body: { text: args.text, ...(args.mode ? { mode: args.mode } : {}), originKey: call.origin.key },
          timeoutMs: 30_000,
          signal: call.signal,
        });
        const text = [sendOutcomeText(response, harnessLabel(response.summary)), "", renderSessionLine(response.summary)].join("\n");
        return {
          text,
          data: { messageId: response.messageId, kind: response.kind, stage: response.stage, ...(response.runId ? { runId: response.runId } : {}) },
        };
      }),
  );
}
