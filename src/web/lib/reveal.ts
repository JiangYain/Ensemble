/**
 * 右栏“消息记录”点击后，请主时间线滚动到对应的那条消息。
 *
 * 两边在组件树里不是父子关系，窄屏下更是分在不同标签页（点击发生时时间线根本没有挂载），
 * 所以用一个很小的订阅通道连接，并把还没被处理的请求暂存一会儿：时间线挂载时来取。
 */

type Listener = (messageId: string) => void;

const listeners = new Set<Listener>();
let pending: { id: string; at: number } | undefined;

/** 暂存的请求超过这个时间就当作过期：避免很久以后打开另一个会话时被一个陈旧的请求拽着滚动。 */
const PENDING_TTL_MS = 3000;

export function revealMessage(messageId: string): void {
  pending = { id: messageId, at: Date.now() };
  for (const listener of [...listeners]) listener(messageId);
}

export function onReveal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 取走暂存的请求（取走即清除）。过期或没有时返回 undefined。 */
export function takePendingReveal(): string | undefined {
  const request = pending;
  pending = undefined;
  if (!request || Date.now() - request.at > PENDING_TTL_MS) return undefined;
  return request.id;
}

/**
 * 输入框发出消息时，请时间线回到最新处并继续贴底：用户刚说了话，自然想看到它落在哪里，
 * 不论之前滚到了哪一段。与上面的定位请求不同，这里不暂存——时间线没有挂载就没有可滚的东西。
 */
const followListeners = new Set<() => void>();

export function followLatest(): void {
  for (const listener of [...followListeners]) listener();
}

export function onFollowLatest(listener: () => void): () => void {
  followListeners.add(listener);
  return () => {
    followListeners.delete(listener);
  };
}
