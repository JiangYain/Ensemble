import { INVALID_TOKEN } from "@shared/constants";
import type { StateSnapshot, StreamMessage } from "@shared/protocol";
import { ApiError, api, streamUrl } from "./api";
import { loadArchived } from "./archive";
import { forgetPatch, snapshotArchivePatch } from "./archiveState";
import { applyHarness, applyLiveEvents, applyProfiles, loadDetail, patchSummary, store } from "./app";
import { PROFILES_UNSUPPORTED } from "./profiles";

/** 本标签页上一次“因令牌失效而整页刷新”的时间；刷新之后令牌仍被拒绝时，靠它避免刷新死循环。 */
const TOKEN_RELOAD_KEY = "ensemble:token-reload-at";
const TOKEN_RELOAD_GUARD_MS = 15_000;

const STREAM_EVENTS: StreamMessage["type"][] = ["hello", "snapshot", "summary", "events", "removed", "harness", "capacity", "profiles", "ping"];

function applySnapshot(snapshot: StateSnapshot, fromStream = true): void {
  const state = store.get();
  // 快照里的 sessions 不含已归档的会话；归档部分（已归档个数、留存策略、已归档表里该去掉的）由 archiveState 一并算好。
  const archive = snapshotArchivePatch(state, snapshot);
  const { sessions } = archive;
  store.set({
    ...archive,
    harnesses: snapshot.harnesses,
    capacity: snapshot.capacity,
    // 老服务没有这个字段：留空，设置窗口据此只显示容量、不提供修改（不拿“没给”当成“不限”）。
    concurrency: snapshot.concurrency,
    // 老服务没有角色功能，快照里没有这个字段：放进“不支持”的标记，不是一张空表（空表是“有这项功能、只是还没建角色”）；设置窗口据此只说明、不提供编辑。
    profiles: snapshot.profiles ?? PROFILES_UNSUPPORTED,
    version: snapshot.version,
    ready: true,
    ...(fromStream ? { conn: "live" as const } : {}),
  });
  // 重连后（或首次打开聚焦页时）核对一下聚焦会话的序号，缺了就重新读取。
  const detail = state.detail;
  if (detail?.state) {
    const summary = sessions[detail.id] ?? archive.archived[detail.id];
    if (summary) {
      if (summary.seq !== detail.state.seq) void loadDetail(detail.id);
    } else if (snapshot.archivedCount !== undefined) {
      // 懂归档的服务：快照里没有它，可能只是被归档了（快照不含已归档的），不能直接断定“已删除”。问一下详情：
      // 读到了（带归档标记）就归到已归档表，404 才是真的没了。
      void loadDetail(detail.id);
    } else {
      store.set({ detail: { ...detail, error: "not_found" } });
    }
  } else if (detail && !detail.loading && detail.error === "failed") {
    void loadDetail(detail.id);
  }
  // 已归档列表读过：重连期间可能有会话进出归档，推送没收全，快照到了就在后台按服务端的重读一遍（静默，失败也不打扰）。
  if (state.archivedLoaded && snapshot.archivedCount !== undefined) loadArchived({ force: true }).catch(() => undefined);
}

function handle(message: StreamMessage): void {
  switch (message.type) {
    case "snapshot":
      applySnapshot(message.snapshot);
      return;
    case "summary":
      patchSummary(message.summary);
      return;
    case "events":
      applyLiveEvents(message.sessionId, message.events);
      return;
    case "removed": {
      // 未归档与已归档两张表里都清掉（已归档的会话也能被删）；聚焦页正开着它就标记为已不存在。
      store.set((s) => ({
        ...forgetPatch(s, message.sessionId),
        ...(s.detail?.id === message.sessionId ? { detail: { ...s.detail, error: "not_found" as const } } : {}),
      }));
      return;
    }
    case "harness":
      applyHarness(message.info);
      return;
    case "capacity":
      // 名额的占用 / 等待与并发上限的设置成对更新：别的标签页改了上限，这里也立刻看到。
      store.set({ capacity: message.capacity, concurrency: message.concurrency });
      return;
    case "profiles":
      // 整张角色表：别的标签页、别的入口改了角色，这里也立刻看到。收到它也说明这个服务有角色功能（服务在页面打开之后才升级的情形）：
      // 新的表是新对象，自然顶掉快照里放的“不支持”标记。
      applyProfiles(message.profiles);
      return;
    case "hello":
    case "ping":
      return;
  }
}

function isTokenRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === INVALID_TOKEN;
}

/**
 * 这个页面带着的令牌已被服务拒绝：服务重启后令牌会换新，而页面里的令牌是加载时写死的，
 * 唯一的补救是整页刷新去拿新令牌（页面本身是 no-store，刷新一定拿到当前的令牌）。
 * 刷新后令牌依然被拒绝时（例如页面来自缓存）不再自动刷新，否则会陷入刷新死循环；
 * sessionStorage 不可用时同样不自动刷新，因为无法防止死循环。这两种情况都交给“连接已断开”卡片里的按钮。
 * @returns 是否已经发起刷新
 */
function reloadForFreshToken(reload: () => void): boolean {
  try {
    const last = Number(sessionStorage.getItem(TOKEN_RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < TOKEN_RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(TOKEN_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reload();
  return true;
}

export interface LiveOptions {
  /** 整页刷新（测试注入）。 */
  reload?: () => void;
}

/**
 * EventSource 自己带 Last-Event-ID 重连。连接彻底关闭时，直接用当前令牌读取状态：
 * 读到快照便重连，传输失败则重试，明确拒绝令牌才刷新页面。
 */
export function startLive(options: LiveOptions = {}): () => void {
  const reload = options.reload ?? ((): void => location.reload());
  let source: EventSource | undefined;
  const lifetime = new AbortController();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollDelay = 1000;

  const stop = (): void => {
    lifetime.abort();
    clearTimeout(pollTimer);
    source?.close();
  };

  const tokenRejected = (): void => {
    stop();
    if (!reloadForFreshToken(reload)) store.set({ conn: "offline" });
  };

  const open = (): void => {
    if (lifetime.signal.aborted) return;
    source?.close();
    const next = new EventSource(streamUrl());
    source = next;
    const isCurrent = (): boolean => !lifetime.signal.aborted && source === next;
    for (const type of STREAM_EVENTS) {
      next.addEventListener(type, (event) => {
        if (!isCurrent()) return;
        try {
          handle(JSON.parse((event as MessageEvent<string>).data) as StreamMessage);
        } catch (error) {
          console.error("[ensemble] bad stream message", error);
        }
      });
    }
    next.addEventListener("open", () => {
      if (!isCurrent()) return;
      pollDelay = 1000;
      if (store.get().conn !== "live") store.set({ conn: store.get().ready ? "live" : "connecting" });
    });
    next.addEventListener("error", () => {
      if (!isCurrent()) return;
      if (next.readyState === EventSource.CLOSED) {
        store.set({ conn: "offline" });
        schedulePoll();
      } else {
        store.set({ conn: "reconnecting" });
      }
    });
  };

  const schedulePoll = (): void => {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      const { signal } = lifetime;
      if (signal.aborted) return;
      try {
        await api.state(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
        if (signal.aborted) return;
        store.set({ conn: "reconnecting" });
        open();
      } catch (error) {
        if (signal.aborted) return;
        if (isTokenRejection(error)) tokenRejected();
        else if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) {
          pollDelay = Math.min(pollDelay * 1.6, 6000);
          schedulePoll();
        }
      }
    }, pollDelay);
  };

  // 首屏先主动拉一次快照，不必等 SSE 握手；之后以流为准。
  // 令牌一开始就被拒绝（打开的是服务重启之前的旧页面）时不必等到连接失败，直接换新页面。
  void api
    .state(lifetime.signal)
    .then((snapshot) => {
      if (!lifetime.signal.aborted && !store.get().ready) applySnapshot(snapshot, false);
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted && isTokenRejection(error)) tokenRejected();
    });

  open();
  return stop;
}
