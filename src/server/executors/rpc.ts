import type { ExitInfo } from "./process";

interface Pending<Reply> {
  what: string;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Codex app-server 与 Pi 的 RPC 都是“每行一个 JSON”的子进程协议，请求与响应靠编号关联。
 * 这里是两者共用的那一半：登记等待项、超时、发送失败、进程退出时一并失败；
 * 消息怎么编号、怎么解析、哪些算响应，仍由各自的协议决定。
 */
export class PendingRequests<Id extends string | number, Reply> {
  private readonly entries = new Map<Id, Pending<Reply>>();

  /** `peer` 是对端的名字，只用于错误信息（“Codex did not answer …”）。 */
  constructor(private readonly peer: string) {}

  /** 登记并发送一个请求；`send` 返回 false 表示进程没在运行，消息没有送出去。 */
  request(id: Id, what: string, timeoutMs: number, send: () => boolean): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.entries.delete(id);
        reject(new Error(`${this.peer} did not answer "${what}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.entries.set(id, { what, resolve, reject, timer });
      if (!send()) {
        clearTimeout(timer);
        this.entries.delete(id);
        reject(new Error(`${this.peer} is not running (cannot send "${what}")`));
      }
    });
  }

  /** 响应到达时取走对应的等待项；没有（已超时，或根本不是我们发出的）返回 undefined。 */
  take(id: Id): Pick<Pending<Reply>, "what" | "resolve" | "reject"> | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  failAll(error: Error): void {
    for (const [id, entry] of this.entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.entries.delete(id);
    }
  }
}

export function exitMessage(label: string, info: ExitInfo): string {
  if (info.error) return `Failed to run ${label}: ${info.error.message}`;
  return `${label} exited (${info.code !== null ? `code ${info.code}` : `signal ${info.signal ?? "unknown"}`})`;
}
