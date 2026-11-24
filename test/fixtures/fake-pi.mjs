#!/usr/bin/env node
/**
 * 假 Pi：按真实 `pi --mode rpc` 抓到的事件顺序回放，仅用于适配器的确定性测试。
 * 场景由提示词里的标记选择：
 *   [fake:parallel]  同一条助手消息里并行发起 write + bash
 *   [fake:hold]      第一个工具开始后停住，等收到 steer，在回合边界回显用户消息
 *   [fake:long]      持续调用工具直到被 abort
 *   [fake:error]     以 stopReason=error 结束（429）
 *   [fake:crash]     运行中进程直接退出
 *   [fake:dialog]    先发一个扩展确认对话框，等到被取消后再继续
 *   [fake:slowsteer] 第一个工具后停住，收到 steer 后在 queue_update 中出现，但不回显用户消息就结束（弱证据路径）
 * 环境变量：FAKE_PI_LOG 记录收到的命令与启动参数；FAKE_PI_STATS_JUMP 让启动时的累计用量非零（模拟恢复会话）。
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const record = (value) => {
  if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify(value)}\n`);
};
record({
  argv,
  cwd: process.cwd(),
  parent: process.env.ENSEMBLE_PARENT_SESSION ?? null,
  depth: process.env.ENSEMBLE_PARENT_DEPTH ?? null,
});

const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const requestedModel = flag("--model") ?? "fake/fake-model";
if (requestedModel.includes("nonexistent")) {
  process.stderr.write(`Error: Model "${requestedModel}" not found. Use --list-models to see available models.\n`);
  process.exit(1);
}
const thinking = flag("--thinking") ?? "medium";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolveTimer) => setTimeout(resolveTimer, ms));

const jump = Number(process.env.FAKE_PI_STATS_JUMP ?? 0);
const totals = { input: jump, output: jump, cacheRead: jump, total: jump * 3, cost: jump / 1000 };
let streaming = false;
let aborted = false;
let abortRequestId;
let steering = [];
let clearQueueResponse;
let wake = () => {};
let dialogDone = () => {};
let callSeq = 0;

class Aborted extends Error {}

const waitFor = async (predicate, timeoutMs = 8000) => {
  const start = Date.now();
  while (!predicate()) {
    if (aborted) throw new Aborted();
    if (Date.now() - start > timeoutMs) throw new Error("fake-pi: wait timeout");
    await new Promise((resolveWake) => {
      wake = resolveWake;
      setTimeout(resolveWake, 15);
    });
  }
};

const model = {
  id: requestedModel.split("/").pop(),
  name: "Fake Model",
  provider: requestedModel.includes("/") ? requestedModel.split("/")[0] : "fake",
  reasoning: true,
  contextWindow: 100000,
  thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
};

const userMessage = (text) => {
  const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  emit({ type: "message_start", message });
  emit({ type: "message_end", message });
};

const assistantStart = () => emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
const bumpUsage = () => {
  totals.input += 100;
  totals.output += 10;
  totals.cacheRead += 50;
  totals.total += 160;
  totals.cost += 0.001;
};
const usage = () => ({ input: 100, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 160, cost: { total: 0.001 } });

async function streamToolCall(index, id, name, args) {
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id, toolName: name } });
  const json = JSON.stringify(args);
  const chunks = json.match(/.{1,12}/gs) ?? [json];
  for (const chunk of chunks) {
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta: chunk } });
    await sleep(8);
  }
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: { type: "toolCall", id, name, arguments: args } },
  });
}

const textOf = (result) => result.content.map((block) => block.text).join("\n");

async function execTool(call) {
  emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
  await sleep(6);
  if (aborted) {
    emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, isError: true, result: { content: [{ type: "text", text: "Operation aborted" }], details: {} } });
    return { aborted: true, call, text: "Operation aborted" };
  }
  let result;
  if (call.name === "write") {
    writeFileSync(resolve(process.cwd(), call.args.path), call.args.content);
    result = { content: [{ type: "text", text: `Successfully wrote ${call.args.content.length} bytes to ${call.args.path}` }] };
  } else if (call.name === "edit") {
    result = {
      content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${call.args.path}.` }],
      details: { diff: "-1 hi\n+1 hello", patch: `--- ${call.args.path}\n+++ ${call.args.path}\n@@ -1,1 +1,1 @@\n-hi\n+hello\n`, firstChangedLine: 1 },
    };
  } else if (call.name === "bash") {
    if (String(call.args.command).includes("exit 3")) {
      emit({ type: "tool_execution_end", toolCallId: call.id, toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Command exited with code 3" }] } });
      return { call, text: "Command exited with code 3" };
    }
    emit({ type: "tool_execution_update", toolCallId: call.id, toolName: "bash", args: call.args, partialResult: { content: [{ type: "text", text: "done\n" }] } });
    result = { content: [{ type: "text", text: "done\n" }] };
  } else {
    result = { content: [{ type: "text", text: "ok" }] };
  }
  emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, isError: false, result });
  return { call, text: textOf(result) };
}

/**
 * 一整个回合：助手消息（可含说明文字 + 多个工具调用）→ 工具执行 → 回合边界。
 * autoBoundary=false 时不处理边界（由场景自己决定何时消费纠偏），避免纠偏在场景开始等待之前就被消费。
 */
async function toolTurn(calls, commentary, autoBoundary = true) {
  assistantStart();
  if (commentary) {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: commentary } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: commentary } });
  }
  let index = commentary ? 1 : 0;
  for (const call of calls) await streamToolCall(index++, call.id, call.name, call.args);
  bumpUsage();
  emit({
    type: "message_end",
    message: { role: "assistant", content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name })), stopReason: "toolUse", usage: usage() },
  });
  const results = await Promise.all(calls.map((call) => execTool(call)));
  for (const outcome of results) {
    const message = { role: "toolResult", toolCallId: outcome.call.id, content: [{ type: "text", text: outcome.text }], isError: Boolean(outcome.aborted) };
    emit({ type: "message_start", message });
    emit({ type: "message_end", message });
  }
  emit({ type: "turn_end", toolResults: results.length });
  if (results.some((outcome) => outcome.aborted)) throw new Aborted();
  emit({ type: "turn_start" });
  if (autoBoundary) boundary();
}

function boundary() {
  if (steering.length === 0) return;
  const texts = steering;
  steering = [];
  emit({ type: "queue_update", steering: [], followUp: [] });
  for (const text of texts) userMessage(text);
}

async function finalAnswer(text) {
  assistantStart();
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const piece of text.match(/.{1,5}/gs) ?? [text]) {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece } });
    await sleep(4);
  }
  emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
  bumpUsage();
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: usage() } });
  emit({ type: "turn_end", toolResults: 0 });
}

async function errorEnding(message, reason = "error") {
  emit({ type: "turn_start" });
  const final = { role: "assistant", content: [], stopReason: reason, errorMessage: message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } };
  emit({ type: "message_start", message: final });
  emit({ type: "message_end", message: final });
  emit({ type: "turn_end", toolResults: 0 });
  emit({ type: "agent_end", messages: [final], willRetry: false });
}

async function runAgent(prompt) {
  streaming = true;
  aborted = false;
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  userMessage(prompt);
  let endedWithError = false;
  try {
    await sleep(10);
    if (prompt.includes("[fake:crash]")) {
      await sleep(20);
      process.exit(3);
    }
    if (prompt.includes("[fake:dialog]")) {
      emit({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Allow dangerous command?", message: "rm -rf" });
      await new Promise((resolveDialog) => {
        dialogDone = resolveDialog;
        setTimeout(resolveDialog, 3000);
      });
    }
    if (prompt.includes("[fake:long]")) {
      for (;;) await toolTurn([{ id: `call_${++callSeq}`, name: "bash", args: { command: "echo tick" } }]);
    }
    if (prompt.includes("[fake:parallel]")) {
      await toolTurn(
        [
          { id: `call_${++callSeq}`, name: "write", args: { path: "new.txt", content: "hi\n" } },
          { id: `call_${++callSeq}`, name: "write", args: { path: "existing.txt", content: "a\nb\n" } },
          { id: `call_${++callSeq}`, name: "bash", args: { command: "echo done" } },
        ],
        "I'll do all three.",
      );
    } else if (prompt.includes("[fake:error]")) {
      await toolTurn([{ id: `call_${++callSeq}`, name: "read", args: { path: "missing.txt" } }]);
      endedWithError = true;
      await errorEnding("429 rate limit exceeded: too many requests");
    } else if (prompt.includes("[fake:late-clear]")) {
      await waitFor(() => clearQueueResponse !== undefined);
    } else if (prompt.includes("[fake:hold]") || prompt.includes("[fake:slowsteer]")) {
      await toolTurn([{ id: `call_${++callSeq}`, name: "read", args: { path: "a.txt" } }], "Starting.", false);
      // 停在回合之间，等纠偏到达。
      if (prompt.includes("[fake:hold]")) {
        await waitFor(() => steering.length > 0);
        boundary();
      } else {
        await waitFor(() => steering.length > 0);
        steering = [];
        emit({ type: "queue_update", steering: [], followUp: [] });
      }
      await toolTurn([{ id: `call_${++callSeq}`, name: "edit", args: { path: "a.txt", edits: [{ oldText: "hi", newText: "hello" }] } }]);
    } else if (prompt.includes("[fake:fail-bash]")) {
      await toolTurn([{ id: `call_${++callSeq}`, name: "bash", args: { command: "exit 3" } }]);
    } else {
      await toolTurn([{ id: `call_${++callSeq}`, name: "bash", args: { command: "echo done" } }]);
    }
    if (!endedWithError) {
      await finalAnswer("All finished.");
      emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }], willRetry: false });
    }
  } catch (error) {
    if (error instanceof Aborted) {
      await errorEnding("This operation was aborted");
    } else {
      throw error;
    }
  } finally {
    streaming = false;
    emit({ type: "agent_settled" });
    if (abortRequestId) {
      emit({ type: "response", id: abortRequestId, command: "abort", success: true });
      abortRequestId = undefined;
    }
  }
}

const respond = (command, id, data, success = true, error) =>
  emit({ type: "response", id, command, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });

function handle(command) {
  record({ command });
  const { id, type } = command;
  switch (type) {
    case "get_state":
      return respond(type, id, {
        model,
        thinkingLevel: thinking,
        isStreaming: streaming,
        sessionId: "fake-session-1",
        sessionFile: join(process.cwd(), ".fake-pi-session.jsonl"),
        sessionName: flag("--name"),
      });
    case "get_available_models":
      return respond(type, id, {
        models: [
          model,
          { id: "plain", name: "Plain Model", provider: "fake", reasoning: false, contextWindow: 8000 },
        ],
      });
    case "get_session_stats":
      return respond(type, id, {
        tokens: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: 0, total: totals.total },
        cost: totals.cost,
        contextUsage: { tokens: 1234, contextWindow: 100000, percent: 1.2 },
      });
    case "prompt":
      if (streaming) return respond(type, id, undefined, false, "Agent is streaming; specify streamingBehavior.");
      respond(type, id);
      void runAgent(command.message).catch((error) => {
        process.stderr.write(`fake-pi crashed: ${error?.stack ?? error}\n`);
        process.exit(9);
      });
      // Reply only after the next prompt is already running.
      if (clearQueueResponse) {
        const { requestId, cleared } = clearQueueResponse;
        clearQueueResponse = undefined;
        respond("clear_queue", requestId, { steering: cleared, followUp: [] });
      }
      return;
    case "steer":
      if (!streaming) return respond(type, id, undefined, false, "Agent is not running.");
      steering.push(command.message);
      emit({ type: "queue_update", steering: [...steering], followUp: [] });
      wake();
      return respond(type, id);
    case "clear_queue": {
      const cleared = steering;
      steering = [];
      emit({ type: "queue_update", steering: [], followUp: [] });
      if (process.env.FAKE_PI_DELAY_CLEAR_QUEUE === "1") {
        clearQueueResponse = { requestId: id, cleared };
        wake();
        return;
      }
      return respond(type, id, { steering: cleared, followUp: [] });
    }
    case "abort":
      if (!streaming) return respond(type, id);
      aborted = true;
      abortRequestId = id;
      wake();
      return;
    case "extension_ui_response":
      dialogDone();
      return;
    default:
      return respond(type, id, undefined, false, `Unknown command ${type}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
