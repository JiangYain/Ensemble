import { LIMITS } from "@shared/constants";
import { dedupeIds } from "@shared/lineage";
import type { SessionId } from "@shared/types";
import { EnsembleError } from "./errors";

/**
 * 请求里“上级”的两种写法：单个 `parentSessionId`（改挂时可以是 null，表示不要上级），或有序的 `parentSessionIds`（汇聚）。
 * 委派（POST /api/sessions）、改挂（POST /api/sessions/:id/parent）与管理器共用这一处归一化，规则只此一份。
 */
export interface ParentInput {
  parentSessionId?: SessionId | null | undefined;
  parentSessionIds?: readonly SessionId[] | undefined;
}

/**
 * 把请求里的上级归一成一个有序、去重的 id 列表（空数组 = 没有上级），第一个是主上级（会话的 `parentSessionId`）：
 * - 只给 `parentSessionId`：它自己（null 或没给就是没有上级）；
 * - 给了 `parentSessionIds`：去重（保留第一次出现的位置，重复不算错）后就是它；空数组、超过 LIMITS.maxParents 个都是 invalid_request，
 *   不悄悄截断；同时给的 `parentSessionId` 必须是它的第一项（null 与“有上级”自相矛盾），对不上就拒绝，不猜哪个才是本意。
 * 这里不查会话存不存在、会不会成环：那要读中枢，由调用方接着做（见 missingParents、planRelink）。
 */
export function normalizeParents(input: ParentInput): SessionId[] {
  const { parentSessionId, parentSessionIds } = input;
  if (parentSessionIds === undefined) return parentSessionId ? [parentSessionId] : [];
  if (parentSessionIds.length === 0) {
    throw new EnsembleError("invalid_request", "parentSessionIds must name at least one session. Leave it out for no parent (when relinking, use parentSessionId: null).");
  }
  const ids = dedupeIds(parentSessionIds);
  if (parentSessionId === null) {
    throw new EnsembleError("invalid_request", "parentSessionId is null but parentSessionIds names parents. Send only one of them.");
  }
  if (parentSessionId !== undefined && parentSessionId !== ids[0]) {
    throw new EnsembleError("invalid_request", "parentSessionId must be the first entry of parentSessionIds (the primary parent), or be left out.", {
      parentSessionId,
      parentSessionIds: ids,
    });
  }
  if (ids.length > LIMITS.maxParents) {
    throw new EnsembleError("invalid_request", "A session can follow at most " + LIMITS.maxParents + " sessions, got " + ids.length + ". Pick the ones its work really depends on.", {
      parentSessionIds: ids,
      maxParents: LIMITS.maxParents,
    });
  }
  return ids;
}

/**
 * 不存在的上级对应的错误（都存在时返回 undefined）：一次把缺的全部说出来，调用方不必改一个再撞下一个。
 * 只缺一个时与原来单上级的说法（和 details）完全一样。
 */
export function missingParents(missing: readonly SessionId[]): EnsembleError | undefined {
  const [first] = missing;
  if (first === undefined) return undefined;
  if (missing.length === 1) return new EnsembleError("not_found", "Parent session " + first + " does not exist.", { parentSessionId: first });
  return new EnsembleError("not_found", "Parent sessions " + missing.join(", ") + " do not exist.", { parentSessionIds: [...missing] });
}
