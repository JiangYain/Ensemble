/**
 * 会话的归档标记：会话目录里的 archive.json，内容是 `{ archivedAt, by }`；文件存在＝已归档，删除文件＝取消归档。
 *
 * 为什么存成一个旁路文件、而不是写进事件日志（归档 / 取消归档事件）——这是实现时的取舍：
 * - 归档是界面上的整理，不是会话自己的经历：不占用 seq，不改 updatedAt（否则“归档”会把一个很久以前的会话顶成“刚刚有动静”，
 *   留存策略也会拿归档当活动），也就不需要为它解冻冷会话；
 * - 老版本服务不认识这个文件，读事件日志时一切照旧（归档过的会话在老版本里只是重新出现），不会因为一种它不认识的事件而出错；
 * - 标记文件丢了只是会话回到默认视图，不损失任何会话记录。
 */
export interface ArchiveMark {
  /** 归档时间（ISO）。 */
  archivedAt: string;
  /** user = 用户在网页上操作；retention = 留存策略自动归档。 */
  by: "user" | "retention";
}

/** 读磁盘上的标记；读不懂（不是对象、没有归档时间）按“没有标记”处理，`by` 缺失或不认识时当作 user。 */
export function parseArchiveMark(value: unknown): ArchiveMark | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const archivedAt = record["archivedAt"];
  if (typeof archivedAt !== "string" || archivedAt.length === 0) return undefined;
  return { archivedAt, by: record["by"] === "retention" ? "retention" : "user" };
}
