import type { ArchiveResponse, RetentionResponse, RetentionSettings } from "@shared/protocol";
import type { SessionId } from "@shared/types";
import { api, type ReportOptions } from "./api";
import { askConfirm, errorText, perform, store, toast, type Toast } from "./app";
import type { ArchivePick, Blocked, BlockReason } from "./archivePlan";
import { beginListLoad, endListLoad, mergeArchivedList } from "./archiveState";
import { saveTextFile } from "./download";
import { translate, type TFunction, type Vars } from "./i18n";
import { Store } from "./store";

/**
 * 归档、取消归档、导出与留存策略的动作（有网络的那一层）。状态怎么放见 lib/archiveState，选哪些会话见 lib/archivePlan。
 *
 * 所有动作都只信服务端的回执与推送：不做乐观更新——归档不是会话自己的事件，POST 的回执只有 id，
 * 摘要在两张表之间的挪动由 SSE 推来的摘要完成（见 app.patchSummary），回执与推送谁先到都无妨。
 * 这里不替服务端判断“能不能归档”：网页的预判只用来写菜单与确认框，真正的裁决（active / already / not_found）以回执为准，并如实说出来。
 */

const t = (key: string, vars?: Vars): string => translate(store.get().lang, key, vars);

// ───────────────────────── 界面状态：读取与在途 ─────────────────────────

export interface ArchiveUi {
  /** 已归档列表的读取：idle（没读 / 读完了）、loading、error（带原因，视图里给“重试”）。 */
  list: { status: "idle" | "loading" | "error"; error?: string };
  /** 在途的归档 / 取消归档请求数：大于 0 时各入口一律禁用，同一批动作不会被连点两次。 */
  busy: number;
}

export const archiveUi = new Store<ArchiveUi>({ list: { status: "idle" }, busy: 0 });

/** 此刻有归档 / 取消归档在途。菜单项是打开时建好的，读这一刻的值：在途期间入口禁用并写明原因（页头的按钮则是随状态实时变的）。 */
export function archiveInFlight(): boolean {
  return archiveUi.get().busy > 0;
}

let listLoad: Promise<void> | undefined;

/**
 * 读取全部已归档的会话（`GET /api/sessions?archived=only`），首次进入“已归档”视图时才读；读过之后靠 SSE 保持新鲜。
 * `force` 用于重试与重连后的静默重读。服务不懂归档（老服务）时什么也不做；读取失败会抛出，调用方决定怎么说（视图里是内联的“重试”）。
 * 同一时刻只读一份：在途时再调用返回同一个 Promise。
 */
export function loadArchived(options: { force?: boolean } = {}): Promise<void> {
  const state = store.get();
  if (state.archivedCount === undefined) return Promise.resolve();
  if (state.archivedLoaded && !options.force) return Promise.resolve();
  if (listLoad) return listLoad;
  const run = async (): Promise<void> => {
    beginListLoad();
    archiveUi.set({ list: { status: "loading" } });
    try {
      const { sessions } = await api.sessions({ archived: "only" });
      const touched = endListLoad();
      store.set((s) => mergeArchivedList(s, sessions, touched));
      archiveUi.set({ list: { status: "idle" } });
    } catch (error) {
      endListLoad();
      archiveUi.set({ list: { status: "error", error: errorText(error) } });
      throw error;
    }
  };
  listLoad = run().finally(() => {
    listLoad = undefined;
  });
  return listLoad;
}

// ───────────────────────── 归档 ─────────────────────────

/** 没被归档的原因，按“最主要的一个”挑文案；键写成字面量，词典的死键检查才认得它们。 */
const KEPT_TEXT: Record<BlockReason, string> = {
  working: "archive.keptWorking",
  idle: "archive.keptIdle",
  pending: "archive.keptPending",
};

const BLOCK_TEXT: Record<BlockReason, string> = {
  working: "archive.blockedWorking",
  idle: "archive.blockedIdle",
  pending: "archive.blockedPending",
};

/** 菜单项禁用时给的原因（悬停 / 读屏）：数字来自摘要里的事实（在工作的、待命的、消息未确认的会话数），不是网页编的。 */
export function blockedText(blocked: Blocked, t: TFunction): string {
  return t(BLOCK_TEXT[blocked.reason], { n: blocked.n });
}

/** 一次归档回执 → 提示文案。`kept` 是点之前网页就知道会被留下的（还在工作的），回执里 active 的是执行那一刻才发现的。 */
function archiveToast(response: ArchiveResponse, kept: Blocked | undefined): { tone: Toast["tone"]; text: string } {
  const changed = response.changed.length;
  const reasons = new Set(response.skipped.map((entry) => entry.reason));
  const active = response.skipped.filter((entry) => entry.reason === "active").length;
  if (changed === 0) {
    if (active > 0) return { tone: "warn", text: t("archive.noneActive") };
    if (reasons.has("not_found")) return { tone: "warn", text: t("archive.noneMissing") };
    return { tone: "info", text: t("archive.noneAlready") };
  }
  const parts: { reason: BlockReason; n: number }[] = kept ? [{ ...kept }] : [];
  if (active > 0) {
    const working = parts.find((part) => part.reason === "working");
    if (working) working.n += active;
    else parts.push({ reason: "working", n: active });
  }
  // 汇聚：本来会随上级一起归档、却还跟随着没有归档的别的会话而留在原处的（回执的 kept，老服务没有这一项）。
  const following = response.kept?.length ?? 0;
  const suffix = parts.map((part) => t(KEPT_TEXT[part.reason], { n: part.n })).join("") + (following > 0 ? t("archive.keptFollowing", { n: following }) : "");
  return { tone: "success", text: `${t("archive.done", { n: changed })}${suffix}` };
}

/**
 * 归档这些会话（每个连同它的整棵子树）。成功时给一条带“撤销”的提示：撤销就是只把这次实际变化的会话放回去（`exact`）。
 * 默认的取消归档会连它们仍归档的下级一起带回来，其中可能有用户更早就单独归档、这次没碰过的会话，那就不是归档的逆操作了。
 * 在途时再调用会被忽略（入口本来就是禁用的，这里只是兜底）。失败是一条真实的错误提示，状态不动。
 */
export async function archiveSessions(ids: readonly SessionId[], kept?: Blocked): Promise<ArchiveResponse | undefined> {
  if (ids.length === 0 || archiveUi.get().busy > 0) return undefined;
  archiveUi.set((s) => ({ busy: s.busy + 1 }));
  try {
    const response = await perform(() => api.archive([...ids]), t("archive.failed"));
    if (!response) return undefined;
    const { tone, text } = archiveToast(response, kept);
    const changed = response.changed;
    // 带“撤销”的提示留久一点（10 秒），键盘用户才来得及 Tab 过去。
    // 撤销走不受“在途”闸门限制的那条路：它是另一个动作，提示一点就收起，不会被连点；被闸门静默吞掉才是真的糟糕。
    toast(tone, text, changed.length > 0 ? 10_000 : 6000, changed.length > 0 ? { label: t("archive.undo"), run: () => void unarchive(changed, { exact: true }) } : undefined);
    return response;
  } finally {
    archiveUi.set((s) => ({ busy: s.busy - 1 }));
  }
}

/**
 * 批量归档前的确认（整个 Main Agent 空间、页头的“归档已完成会话”、多选的“归档所选”共用）：写明实际会归档几个、
 * 其中几个是随上级一起走的、几个因为任务树里还有会话在工作而留下。单个会话（含它的子树）的归档不确认，它是可撤销的小动作。
 */
export function confirmArchive(pick: ArchivePick): void {
  const n = pick.changed.length;
  askConfirm({
    title: t("archive.confirmTitle", { n }),
    body: t("archive.confirmBody", { n, carried: pick.carried, kept: pick.kept }),
    confirmLabel: t("archive.confirmAction", { n }),
    onConfirm: async () => {
      // 对话框开着的时候别处又起了一次归档：archiveSessions 会把在途时的调用静默忽略，这里要说出来，不能让用户点了确认却什么都没发生。
      if (archiveInFlight()) {
        toast("info", t("archive.busy"));
        return;
      }
      await archiveSessions(pick.ids, pick.blocked);
    },
  });
}

// ───────────────────────── 取消归档 ─────────────────────────

/**
 * 取消归档：被点名的会话、它仍归档的下级，加上仍归档的上级链（取消之后它不会脱离上级单独出现，见 shared/archive 的 planUnarchive）。
 * 提示里如实写出“一并恢复了几个”：用户点的是一个，回来的可能更多。
 */
export function unarchiveSessions(ids: readonly SessionId[]): Promise<ArchiveResponse | undefined> {
  return archiveUi.get().busy > 0 ? Promise.resolve(undefined) : unarchive(ids);
}

/**
 * 取消归档的请求本身。`options.exact` 是撤销用的（只恢复点名的会话），直接取消归档不带它。
 * 提示照服务端这次实际恢复的会话写，“一并恢复了几个”不看有没有带 `exact`：旧服务不认识它，撤销时也会多恢复，提示不能因此少说。
 */
async function unarchive(ids: readonly SessionId[], options: { exact?: boolean } = {}): Promise<ArchiveResponse | undefined> {
  if (ids.length === 0) return undefined;
  archiveUi.set((s) => ({ busy: s.busy + 1 }));
  try {
    const response = await perform(() => api.unarchive([...ids], options), t("archive.unarchiveFailed"));
    if (!response) return undefined;
    const requested = new Set(ids);
    const carried = response.changed.filter((id) => !requested.has(id)).length;
    if (response.changed.length > 0) {
      const extra = carried > 0 ? t("archive.unarchivedCarried", { n: carried }) : "";
      toast("success", `${t("archive.unarchived", { n: response.changed.length })}${extra}`);
    } else if (response.skipped.some((entry) => entry.reason === "not_found")) {
      toast("warn", t("archive.unarchiveMissing"));
    } else {
      toast("info", t("archive.unarchiveNone"));
    }
    return response;
  } finally {
    archiveUi.set((s) => ({ busy: s.busy - 1 }));
  }
}

// ───────────────────────── 导出 ─────────────────────────

const exporting = new Set<string>();

/**
 * 导出 Markdown 复盘报告：一次点击直接下载，不弹对话框、成功不打扰（浏览器自己会显示下载）；失败是一条真实的错误提示。
 * 报告的语言跟着当前界面语言。令牌只出现在请求头里（见 api.report），下载走的是浏览器本地的 blob 链接。
 * 同一份报告在途时再点不重复发。
 */
export async function exportReport(id: SessionId, options: Pick<ReportOptions, "scope" | "detail">): Promise<boolean> {
  const key = `${id}|${options.scope}|${options.detail}`;
  if (exporting.has(key)) return false;
  exporting.add(key);
  try {
    const result = await perform(() => api.report(id, { ...options, lang: store.get().lang }), t("export.failed"));
    if (!result) return false;
    saveTextFile(result.filename, result.text);
    return true;
  } finally {
    exporting.delete(key);
  }
}

// ───────────────────────── 留存策略 ─────────────────────────

/** 读留存策略与最近一次清扫；同时把策略放进状态（快照里也有，这里读的是此刻服务端的那份）。 */
export async function readRetention(signal?: AbortSignal): Promise<RetentionResponse> {
  const response = await api.retention(signal);
  store.set({ retention: response.retention });
  return response;
}

/** 写留存策略（整份替换；两项各自独立，null＝不限）。错误原样抛给调用方，设置页把它写在控件旁边。 */
export async function saveRetention(body: RetentionSettings): Promise<RetentionResponse> {
  const response = await api.setRetention(body);
  store.set({ retention: response.retention });
  return response;
}
