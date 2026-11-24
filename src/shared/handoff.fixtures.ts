/**
 * 仅供测试使用：往一份 `EventLog` 里写“一个上游会话的运行”——开一次运行、说一段话、结束、失败、改文件。
 * 交接取数（shared/handoff）、渲染与额度（server/context-refs）、管理器与服务的集成、报告与页面的测试都要造这样的上游日志，共用这一份写法。
 * 都是事实上执行端会发的事件，不含任何会话引用相关的逻辑。
 */

import { EventLog } from "./testing";
import type { FileChange, Run } from "./types";

export type Phase = "commentary" | "final";

/**
 * 开一次运行：一条消息、消息已被执行端接收、排队、开始。运行序号就是 `index`（第 1 次是任务，之后都是续聊）。
 * 消息要写成“已被接收”：没有这条投递记录的消息一直算待确认，会话就永远不是稳定的，冷热分离的测试里它就冻不起来。
 */
export function startRun(log: EventLog, id: string, index: number): void {
  const trigger: Run["trigger"] = index === 1 ? "task" : "follow_up";
  const messageId = `msg_${id}`;
  log.message(messageId, trigger, `message for ${id}`);
  log.push({ kind: "message.delivery", data: { messageId, record: { stage: "applied", at: log.now() } } }, { source: "ensemble" });
  log.run(id, index, messageId, trigger);
  log.startRun(id);
}

/** 一条完整的助手文字：一段增量加一个 completed。 */
export function say(log: EventLog, runId: string, itemId: string, text: string, phase?: Phase): void {
  log.push({ kind: "assistant.delta", data: { itemId, text, ...(phase ? { phase } : {}) } }, { runId });
  log.push({ kind: "assistant.completed", data: { itemId } }, { runId });
}

export function finish(log: EventLog, runId: string): void {
  log.push({ kind: "run.completed", data: {} }, { runId });
}

export function fail(log: EventLog, runId: string, code: string, message: string, detail?: string): void {
  log.push({ kind: "run.failed", data: { error: { code, message, ...(detail ? { detail } : {}) } } }, { runId });
}

export function changed(log: EventLog, runId: string, files: Array<[string, FileChange["change"]]>): void {
  log.push({ kind: "file.changed", data: { files: files.map(([path, change]) => ({ path, change })) } }, { runId });
}
