import type { StateSnapshot } from "@shared/protocol";
import type { SessionId, SessionSummary } from "@shared/types";
import type { AppState } from "./app";

/**
 * 归档在网页状态里怎么放（纯函数：只读状态、只返回补丁，不碰 store 与网络；动作见 lib/archive.ts）。
 *
 * 两张表分开存：`sessions` 永远只有未归档的会话，画布、侧栏、列表、快切器、批量动作……所有现有消费者看到的仍是这一份，
 * 完全不需要知道归档的存在；已归档的放在 `archived`，只有“已归档”视图、聚焦页与相关会话的链接会去读它（按需加载，见 loadArchived）。
 * `archived` 不一定是全集：`archivedLoaded` 为 false 时里面只有零星几个（聚焦页打开的、本次归档 / 取消归档推送来的），为 true 才是服务端那份的全部。
 *
 * 一个会话同一时刻只在其中一张表里。归档与取消归档不改变会话的 seq（它们不是事件），所以：
 * - 新旧摘要只在“序号更小”时才算过期，序号相同的照收——那份摘要很可能就是这次状态变化本身；
 * - POST 的回执只有 id、没有摘要，状态以 SSE 推来的摘要为准；回执与推送谁先到都行，这里每一步都幂等。
 */

export type ArchiveSlice = Pick<AppState, "sessions" | "archived" | "archivedLoaded" | "archivedCount" | "snapshotAt">;
export type ArchivePatch = Partial<Pick<AppState, "sessions" | "archived" | "archivedCount">>;

/** 按 id 取摘要：未归档的在 sessions，已归档的在 archived。聚焦页与“相关会话”的链接两张表都要认。 */
export function summaryById(state: Pick<AppState, "sessions" | "archived">, id: SessionId): SessionSummary | undefined {
  return state.sessions[id] ?? state.archived[id];
}

// ───────────────────────── 请求在途期间的“推送优先” ─────────────────────────

/**
 * 读取整份已归档列表、或读取单个会话详情的请求在途时，推送（与快照）带来的状态比这份回执新或一样新，回执不能把它们改回去：
 * 例如回执里还写着 X 已归档，而期间的推送刚把 X 取消了归档。这里记下期间被推送碰过的 id，回执落下来时跳过它们。
 * 推送与回执是两条互不相干的通道，没有统一的版本号可比，所以只能靠“期间碰过谁”。
 * 在途的请求可以同时有好几个（整份列表一个、各个详情各一个），每个请求有自己的一份记录。
 */
const watchers = new Set<Set<SessionId>>();

/** 开始记录：返回的集合随推送增长，`stop` 之后不再记（重复调用无妨）。 */
export function watchTouched(): { touched: ReadonlySet<SessionId>; stop: () => void } {
  const touched = new Set<SessionId>();
  watchers.add(touched);
  return {
    touched,
    stop: () => {
      watchers.delete(touched);
    },
  };
}

/** 整份列表的读取是同一时刻只有一份的：它的记录单独留一个入口，开始与结束各一次调用。 */
let listWatch: ReturnType<typeof watchTouched> | undefined;

export function beginListLoad(): void {
  listWatch?.stop();
  listWatch = watchTouched();
}

export function endListLoad(): ReadonlySet<SessionId> {
  const seen = listWatch?.touched ?? new Set<SessionId>();
  listWatch?.stop();
  listWatch = undefined;
  return seen;
}

function touch(id: SessionId): void {
  for (const touched of watchers) touched.add(id);
}

// ───────────────────────── 推送的摘要 ─────────────────────────

/** 去掉某个键，返回新表（不改入参）。 */
function without<T>(table: Readonly<Record<string, T>>, id: string): Record<string, T> {
  const { [id]: _removed, ...rest } = table;
  return rest;
}

/**
 * 数量怎么变：列表已读全时，数量就是表的大小；还没读全时只能在确知的变化上加减——
 * 服务端报告的数是快照那一刻的，之后每一次明确的“进出归档”才改它，拿不准的不改（见下面各处的注释）。
 */
function counted(state: ArchiveSlice, archived: Record<SessionId, SessionSummary>, delta: number): number | undefined {
  if (state.archivedLoaded) return Object.keys(archived).length;
  return state.archivedCount === undefined ? undefined : Math.max(0, state.archivedCount + delta);
}

/**
 * 把服务端推来的（或详情回执里的）一份会话摘要放进该去的那张表：有 `archivedAt` 的是已归档，没有的是未归档。
 * 同一会话上序号更小的摘要是过期的，忽略；序号相同的照收（见文件头）。返回空对象表示没有变化。
 */
export function routeSummary(state: ArchiveSlice, summary: SessionSummary): ArchivePatch {
  const { id } = summary;
  const hot = state.sessions[id];
  const cold = state.archived[id];
  const known = hot ?? cold;
  if (known && known.seq > summary.seq) return {};
  touch(id);

  if (summary.archivedAt !== undefined) {
    const archived = { ...state.archived, [id]: summary };
    if (hot) {
      // 未归档 → 已归档：这是一次确知的变化，数量 +1。
      return { sessions: without(state.sessions, id), archived, archivedCount: counted(state, archived, 1) };
    }
    // 已经在已归档表里（更新摘要），或表里没有它：后者只可能是一份在我们拿到快照之前就已归档、而我们没有加载的会话
    // （我们认识的未归档会话都在 sessions 里）——它早就算在快照的数里了，不再加一。
    return { archived, archivedCount: counted(state, archived, 0) };
  }

  if (hot) return { sessions: { ...state.sessions, [id]: summary } };

  const sessions = { ...state.sessions, [id]: summary };
  if (cold) {
    // 已归档 → 未归档：确知的变化，数量 −1。
    const archived = without(state.archived, id);
    return { sessions, archived, archivedCount: counted(state, archived, -1) };
  }
  // 两张表里都没有、也没有归档标记：要么是一个刚创建的新会话，要么是一个我们没加载的已归档会话刚被取消了归档（例如主 Agent 给它发了消息）。
  // 区分的办法是创建时间：比快照那一刻还早创建、却不在快照的未归档列表里，只能是此前归档着的——数量 −1；否则是新会话，数量不变。
  const resurfaced = !state.archivedLoaded && state.snapshotAt !== undefined && summary.createdAt < state.snapshotAt;
  if (!resurfaced) return { sessions };
  return { sessions, archivedCount: counted(state, state.archived, -1) };
}

/** 一个会话被删除（SSE 的 `removed`、本页删除）：两张表里都清掉。认不出的 id 不动数量——不知道它算没算在里面。 */
export function forgetPatch(state: ArchiveSlice, id: SessionId): ArchivePatch {
  if (state.sessions[id]) {
    touch(id);
    return { sessions: without(state.sessions, id) };
  }
  if (state.archived[id]) {
    touch(id);
    const archived = without(state.archived, id);
    return { archived, archivedCount: counted(state, archived, -1) };
  }
  touch(id);
  return {};
}

// ───────────────────────── 快照与整份列表 ─────────────────────────

export type SnapshotArchivePatch = Pick<AppState, "sessions" | "archived" | "archivedCount" | "retention" | "snapshotAt">;

/**
 * 快照里的归档部分。快照（重连时、首屏）里的 `sessions` 不含已归档的会话，已归档的只给个数。
 * - 没有 `archivedCount` 的是不懂归档的老服务：整个归档界面都不出现，已归档表清空；
 * - 断线期间被取消归档的会话现在在快照的未归档列表里，要从已归档表里去掉（一个会话只在一张表里）；
 * - 个数以快照为准；列表读全的标记（`archivedLoaded`）不动，由调用方决定要不要在后台重读（见 live.ts）。
 */
export function snapshotArchivePatch(state: Pick<AppState, "archived">, snapshot: StateSnapshot): SnapshotArchivePatch {
  const sessions = Object.fromEntries(snapshot.sessions.map((summary) => [summary.id, summary])) as Record<SessionId, SessionSummary>;
  for (const id of Object.keys(sessions)) touch(id);
  if (snapshot.archivedCount === undefined) {
    return { sessions, archived: {}, archivedCount: undefined, retention: undefined, snapshotAt: snapshot.serverTime };
  }
  const archived = Object.fromEntries(Object.entries(state.archived).filter(([id]) => !(id in sessions))) as Record<SessionId, SessionSummary>;
  return { sessions, archived, archivedCount: snapshot.archivedCount, retention: snapshot.retention, snapshotAt: snapshot.serverTime };
}

/**
 * 整份已归档列表读回来了：合并进状态。期间被推送碰过的 id 以推送为准（见 beginListLoad）；
 * 已经在未归档表里的 id 不收（一个会话只在一张表里；它若真的已归档，推送很快会把它挪过来）；
 * 读到的比已有的更旧（序号更小）的不覆盖。列表读全之后，个数就是表的大小。
 */
export function mergeArchivedList(
  state: Pick<AppState, "sessions" | "archived">,
  listed: readonly SessionSummary[],
  touched: ReadonlySet<SessionId>,
): Pick<AppState, "archived" | "archivedLoaded" | "archivedCount"> {
  const archived: Record<SessionId, SessionSummary> = {};
  for (const summary of listed) {
    if (touched.has(summary.id) || state.sessions[summary.id]) continue;
    const known = state.archived[summary.id];
    archived[summary.id] = known && known.seq > summary.seq ? known : summary;
  }
  for (const id of touched) {
    const known = state.archived[id];
    if (known) archived[id] = known;
  }
  return { archived, archivedLoaded: true, archivedCount: Object.keys(archived).length };
}
