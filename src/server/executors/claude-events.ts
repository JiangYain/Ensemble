import type { PlanEntry, RunId, Usage } from "@shared/types";
import { arr, asRecord, categorizeTool, displayPath, inputPreview, num, oneLine, outputPreview, str, textOfContent, type Json } from "./common";
import type { ExecutorDraft } from "./types";

interface Callbacks {
  emit: (draft: ExecutorDraft) => void;
  init: (message: Json) => void;
  started: () => void;
  result: (message: Json) => void;
}

interface Block {
  id: string;
  kind: "text" | "thinking";
  text: string;
  completed: boolean;
}

interface Tool {
  name: string;
  input: Json | undefined;
}

/** Maps Claude Code's stream-json messages; no event is invented for work the CLI did not report. */
export class ClaudeEvents {
  private messageId = "";
  private messageNumber = 0;
  private currentIndex = 0;
  private blocks = new Map<number, Block>();
  private readonly tools = new Map<string, Tool>();
  private lastText: string | undefined;

  constructor(private readonly runId: RunId, private readonly messageUuid: string, private readonly cwd: string, private readonly callbacks: Callbacks) {}

  accept(value: unknown): void {
    const message = asRecord(value);
    if (!message) return;
    const type = str(message["type"]);
    if (type === "system" && message["subtype"] === "init") {
      this.callbacks.init(message);
      return;
    }
    if (type === "user" && message["isReplay"] === true && message["uuid"] === this.messageUuid) {
      this.callbacks.started();
      return;
    }
    if (type === "stream_event" && !message["parent_tool_use_id"]) {
      this.callbacks.started();
      this.stream(asRecord(message["event"]));
      return;
    }
    if (type === "assistant" && !message["parent_tool_use_id"]) {
      this.callbacks.started();
      this.assistant(asRecord(message["message"]), str(message["uuid"]));
      return;
    }
    if (type === "user" && !message["parent_tool_use_id"]) {
      this.toolResults(asRecord(message["message"]));
      return;
    }
    if (type === "result") {
      if (message["is_error"] !== true && message["subtype"] === "success") {
        this.callbacks.started();
        const result = str(message["result"]);
        if (result && result.trim() !== this.lastText?.trim()) this.emit({ kind: "assistant.completed", data: { itemId: `${this.runId}:result`, text: result } });
      }
      const usage = this.usage(message);
      if (usage) this.emit({ kind: "usage.updated", data: { usage } });
      this.callbacks.result(message);
    }
  }

  private emit(draft: ExecutorDraft): void {
    this.callbacks.emit({ ...draft, runId: this.runId } as ExecutorDraft);
  }

  private stream(event: Json | undefined): void {
    if (!event) return;
    const type = str(event["type"]);
    if (type === "message_start") {
      this.messageId = str(asRecord(event["message"])?.["id"]) ?? `message-${++this.messageNumber}`;
      this.blocks = new Map();
      return;
    }
    const index = num(event["index"]);
    if (index === undefined) return;
    this.currentIndex = index;
    if (type === "content_block_start") {
      const content = asRecord(event["content_block"]);
      const kind = content?.["type"];
      if (kind === "text" || kind === "thinking") {
        const block: Block = { id: `${this.runId}:${this.messageId}:${index}`, kind, text: "", completed: false };
        this.blocks.set(index, block);
        const initial = str(content?.[kind === "text" ? "text" : "thinking"]);
        if (initial) this.delta(block, initial);
      }
    } else if (type === "content_block_delta") {
      const block = this.blocks.get(index);
      const delta = asRecord(event["delta"]);
      const text = delta?.["type"] === "text_delta" ? str(delta["text"]) : delta?.["type"] === "thinking_delta" ? str(delta["thinking"]) : undefined;
      if (block && text) this.delta(block, text);
    } else if (type === "content_block_stop") {
      const block = this.blocks.get(index);
      if (block) this.complete(block);
    }
  }

  private delta(block: Block, text: string): void {
    block.text += text;
    if (block.kind === "text") {
      this.lastText = block.text;
      this.emit({ kind: "assistant.delta", data: { itemId: block.id, text } });
    } else this.emit({ kind: "reasoning.delta", data: { itemId: block.id, text } });
  }

  private complete(block: Block, fullText?: string): void {
    if (block.completed && fullText === undefined) return;
    if (block.kind === "text") {
      if (fullText !== undefined) this.lastText = fullText;
      this.emit({ kind: "assistant.completed", data: { itemId: block.id, ...(fullText !== undefined ? { text: fullText } : {}) } });
    } else {
      if (!block.text && fullText) this.delta(block, fullText);
      this.emit({ kind: "reasoning.completed", data: { itemId: block.id } });
    }
    block.completed = true;
  }

  private assistant(message: Json | undefined, uuid: string | undefined): void {
    if (!message) return;
    const id = str(message["id"]);
    if (id && id !== this.messageId) {
      this.messageId = id;
      this.currentIndex = 0;
      this.blocks = new Map();
    }
    for (const value of arr(message["content"]) ?? []) {
      const content = asRecord(value);
      if (!content) continue;
      const kind = content["type"];
      if (kind === "tool_use") {
        this.toolStart(content);
      } else if (kind === "text" || kind === "thinking") {
        const text = str(content[kind === "text" ? "text" : "thinking"]);
        if (text === undefined) continue;
        const active = this.blocks.get(this.currentIndex);
        const block: Block = active?.kind === kind ? active : { id: `${this.runId}:${uuid ?? ++this.messageNumber}:${this.currentIndex}`, kind, text: "", completed: false };
        this.complete(block, text);
      }
    }
  }

  private toolStart(content: Json): void {
    const id = str(content["id"]);
    const name = str(content["name"]);
    if (!id || !name || this.tools.has(id)) return;
    const input = asRecord(content["input"]);
    this.tools.set(id, { name, input });
    const title = str(input?.["file_path"]) ?? str(input?.["path"]) ?? str(input?.["command"]) ?? str(input?.["pattern"]) ?? name;
    const category = name === "Agent" ? "task" : name === "PowerShell" ? "shell" : categorizeTool(name);
    this.emit({ kind: "tool.updated", data: { callId: id, name, category, title: oneLine(title, 180), status: "running", ...(input ? { input: inputPreview(input, "json") } : {}) } });
  }

  private toolResults(message: Json | undefined): void {
    for (const value of arr(message?.["content"]) ?? []) {
      const content = asRecord(value);
      if (content?.["type"] !== "tool_result") continue;
      const id = str(content["tool_use_id"]);
      const tool = id ? this.tools.get(id) : undefined;
      if (!id || !tool) continue;
      const text = textOfContent(content["content"]);
      const failed = content["is_error"] === true;
      this.emit({ kind: "tool.updated", data: { callId: id, status: failed ? "failed" : "completed", ...(text ? { output: outputPreview(text) } : {}), ...(failed && text ? { error: oneLine(text, 400) } : {}) } });
      if (!failed && (tool.name === "Edit" || tool.name === "MultiEdit")) {
        const path = str(tool.input?.["file_path"]);
        if (path) this.emit({ kind: "file.changed", data: { callId: id, files: [{ path: displayPath(this.cwd, path), change: "modified" }] } });
      }
      if (!failed && tool.name === "TodoWrite") this.plan(tool.input);
      this.tools.delete(id);
    }
  }

  private plan(input: Json | undefined): void {
    const statuses: Record<string, PlanEntry["status"]> = { pending: "pending", in_progress: "in_progress", completed: "completed" };
    const entries = (arr(input?.["todos"]) ?? []).flatMap((value) => {
      const item = asRecord(value);
      const text = str(item?.["content"]);
      const status = str(item?.["status"]);
      return text && status && statuses[status] ? [{ text, status: statuses[status] }] : [];
    });
    if (entries.length) this.emit({ kind: "plan.updated", data: { entries } });
  }

  private usage(message: Json): Usage | undefined {
    const data = asRecord(message["usage"]);
    const input = num(data?.["input_tokens"]);
    const output = num(data?.["output_tokens"]);
    const cached = num(data?.["cache_read_input_tokens"]);
    const written = num(data?.["cache_creation_input_tokens"]);
    const cost = num(message["total_cost_usd"]);
    if (input === undefined && output === undefined && cached === undefined && written === undefined && cost === undefined) return undefined;
    const inputTotal = (input ?? 0) + (cached ?? 0) + (written ?? 0);
    return { inputTokens: inputTotal, outputTokens: output ?? 0, cachedTokens: cached ?? 0, totalTokens: inputTotal + (output ?? 0), ...(cost !== undefined ? { costUsd: cost } : {}) };
  }
}
