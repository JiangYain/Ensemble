import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
if (args.includes("--version")) {
  console.log("2.1.322 (Claude Code)");
  process.exit(0);
}
if (args.includes("--help")) {
  const required = ["--input-format", "--output-format", "--replay-user-messages", "--include-partial-messages", "--session-id", "--resume", "--permission-mode"];
  const readOnly = process.env.FAKE_CLAUDE_OLD ? [] : ["--safe-mode", "--strict-mcp-config", "--tools"];
  console.log([...required, ...readOnly].join("\n"));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_OUT !== "1";
  console.log(JSON.stringify({ loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}

if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, parent: process.env.ENSEMBLE_PARENT_SESSION, depth: process.env.ENSEMBLE_PARENT_DEPTH })}\n`);
const session = flag("--resume") ?? flag("--session-id");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (event) => emit({ type: "stream_event", session_id: session, parent_tool_use_id: null, event });
const read = createInterface({ input: process.stdin });
read.once("line", (line) => {
  const input = JSON.parse(line);
  const text = input.message.content;
  const requestedTools = flag("--tools")?.split(",") ?? ["Read", "Bash", "Edit"];
  const replay = { type: "user", uuid: input.uuid, session_id: session, isReplay: true, message: input.message };
  if (process.env.FAKE_CLAUDE_REVERSE_INIT) emit(replay);
  if (!process.env.FAKE_CLAUDE_NO_INIT) emit({ type: "system", subtype: "init", session_id: session, model: "claude-fake-model", tools: process.env.FAKE_CLAUDE_UNSAFE ? [...requestedTools, "Bash"] : requestedTools });
  if (text.includes("[fake:early]")) { process.exitCode = 1; return; }
  if (!process.env.FAKE_CLAUDE_REVERSE_INIT) emit(replay);
  if (text.includes("[fake:hold]")) { setInterval(() => {}, 1000); return; }
  const finish = () => {
    event({ type: "message_start", message: { id: "msg-fake" } });
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready." } });
    emit({ type: "assistant", uuid: "assistant-fake", session_id: session, parent_tool_use_id: null, message: { id: "msg-fake", content: [{ type: "text", text: "Ready." }] } });
    event({ type: "content_block_stop", index: 0 });
    if (text.includes("[fake:tool]")) {
      emit({ type: "assistant", uuid: "tool-fake", session_id: session, parent_tool_use_id: null, message: { id: "msg-fake", content: [{ type: "tool_use", id: "toolu-1", name: "Read", input: { file_path: "README.md" } }] } });
      emit({ type: "user", session_id: session, parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "contents" }] } });
    }
    if (text.includes("[fake:noresult]")) return;
    emit({ type: "result", subtype: "success", is_error: false, session_id: session, result: "Ready.", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 }, total_cost_usd: 0.002 });
  };
  if (text.includes("[fake:slow]")) setTimeout(finish, 300);
  else finish();
});
