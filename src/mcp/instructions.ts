import { LIMITS } from "@shared/constants";

/**
 * MCP 握手时交给宿主的 `instructions`：宿主把它放进主 Agent 的上下文，是主 Agent 了解 Ensemble 的第一份说明。
 * 与各工具自己的 `description` 分工：这里讲“怎么配合着用”（等结果用 `wait`、衔接会话用 `follows`、没有对话标识时自报 `conversationId`……），
 * 单个工具的用法写在那个工具的 `description` 里。措辞是对外契约的一部分，测试钉着其中几句（`bridge*.test.ts` 的 `getInstructions()`）。
 */
export const INSTRUCTIONS = [
  "Ensemble hands work to full external agent sessions (Cursor, Codex, Pi, Claude Code, OpenCode, DSH) that run in the background with their own tools,",
  "and lets you and the user watch and steer them from a local web panel.",
  "`delegate` returns at once with a session id and a panel URL; the session keeps working without you.",
  "Write each task as a complete brief — the session cannot see this conversation.",
  "Use `wait` (not repeated `status` calls) when you need results, `read` for the answer (`view=\"errors\"` or `\"commands\"` for what failed or what it ran, `afterSeq` for only what is new, `sessionIds` to collect several finished sessions in one call, `view=\"report\"` for a clean Markdown write-up to archive or share — `scope=\"tree\"` covers the whole task tree), `send` to correct or continue a session.",
  "When new work follows up on an existing session — for example fixing what a review session found — pass that session's id as `follows` so the panel draws it after that session. " +
    "When it depends on the results of several sessions — for example one acceptance pass over two parallel implementations — pass all of their ids as `follows` (up to " + LIMITS.maxParents + "); sessions that do not depend on each other should not be linked just to draw lines.",
  "To give a new session what another session produced, put `{ kind: \"session\", sessionId }` in `delegate`'s `context` (`include` adds `files` and `error`) instead of reading it and retelling it: " +
    "Ensemble copies that session's real final answer from its own record into the new prompt, verbatim. The referenced session must not be running; `follows` still decides how the panel draws the connection.",
  "If your host does not tell Ensemble which conversation a call comes from (for example Cursor IDE, where every conversation shares one plugin process), pass your own conversation id as `conversationId` on every Ensemble tool call; it keeps your sessions and the user's interventions apart from other conversations.",
  "`wait` also returns early when an unfinished session newly shows something worth a look (shown as `attention:` lines): treat it as a fact to check with `read`, not as proof the session is stuck.",
  "Delegated sessions run with Full Access by default and never stop to ask anyone for approval; ask for `access: \"read_only\"` only when a session must not change anything.",
  "Separately, a session whose task is ambiguous may stop to ask a question: `status`, `wait` and `read` then show a `question` block with its id, the question and the options, and `wait` returns for it even with `attention: false`. " +
    `Reply with \`send\` (\`questionId\` plus \`answer\`/\`answers\`, or \`decline: true\` to let it use its own judgment); a question nobody answers is closed after ${Math.round(LIMITS.question.timeoutMs / 60_000)} minutes and the session carries on with its own assumption.`,
].join(" ");
