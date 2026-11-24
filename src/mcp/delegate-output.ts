import { clip } from "@shared/format";
import type { DelegateResponse } from "@shared/protocol";
import type { CwdSource, ParentChoice, PreparedDelegation } from "./delegate-request";
import { harnessLabel, renderSessionDetail } from "./format";
import { renderContextRefs } from "./format-context";
import { renderRoleEcho } from "./format-profiles";
import type { Output } from "./tool-call";

/**
 * `delegate` 的回执：服务的回复加上构造请求时留下的事实（delegate-request.ts 的 `PreparedDelegation`）。
 * 这里不再判断“服务认不认某项功能”“有没有传 `cwd`”这类条件——它们在构造请求时只决定了一次，回执只陈述结果。
 * 服务命中重复委派时没有新建任何东西，走另一份回执：不说“已委派”；工作目录的出处、上级与降级说明描述的都是新会话，这次没有新会话，所以一概不写。
 */
export function renderDelegateOutput(prepared: PreparedDelegation, response: DelegateResponse, panelUrl: string): Output {
  return response.duplicate ? duplicateOutput(response, response.duplicate.ageMs, panelUrl) : createdOutput(prepared, response, panelUrl);
}

/** 服务端没有新建任何东西：这里不能说成“已委派”；结构化结果里仍是真实存在的那个会话。 */
function duplicateOutput(response: DelegateResponse, ageMs: number, panelUrl: string): Output {
  const seconds = Math.round(ageMs / 1000);
  const ago = seconds < 1 ? "just now" : `${seconds} s ago`;
  const phase = response.summary.phase;
  const lines = [
    `Not delegated again: an identical delegation was created ${ago} as session ${response.sessionId} (phase ${phase}). ` +
      "Nothing new was started — this is that same session, returned instead. " +
      "Do not call `delegate` for it again: use `wait` (or `read`, if it is already done) to get its result. " +
      "Pass `allowDuplicate: true` only if you really want a second identical session.",
    renderSessionDetail(response.summary, { panelUrl }),
  ];
  return {
    text: lines.join("\n"),
    data: {
      sessionId: response.sessionId,
      runId: response.runId,
      panelUrl,
      phase,
      harness: response.summary.harness,
      duplicate: true,
      duplicateAgeSeconds: seconds,
      ...(response.profile ? { profile: response.profile } : {}),
    },
  };
}

function createdOutput(prepared: PreparedDelegation, response: DelegateResponse, panelUrl: string): Output {
  const summary = response.summary;
  // 并发名额满了时新会话在排队、还没有开始：这时说“已在后台工作”不是事实。别的阶段的原句一个字不动。
  const progress =
    summary.phase === "queued"
      ? "It is queued: the concurrent-run limit is full, so it starts when a slot frees up. You do not need to poll."
      : "It is working in the background; you do not need to poll.";
  const lines = [
    `Delegated to ${harnessLabel(summary)} — session ${response.sessionId}, run ${response.runId}. ${progress}`,
    // 多个上级的 id 与标题由下面 `parentLines` 的一行说清；详情里的 `follows: id, id` 行在回执里不再重复（`status` 的 `detail=true` 与 `wait` 因会话结束而返回时的详情仍然有它）。
    renderSessionDetail({ ...summary, parentSessionIds: undefined }, { panelUrl }),
    // 角色的回执：每个字段取自角色、你显式传的、还是默认；角色里写了但没用上的取值也如实说明。
    ...(response.profile ? renderRoleEcho(response.profile) : []),
    // 会话引用的回执：每个被引用的会话取到了什么（取自第几次运行、字符数、文件数、有没有被截断），只陈述事实。
    ...(response.contextRefs ? renderContextRefs(response.contextRefs) : []),
    workspaceSourceLine(prepared.cwdSource),
    ...(prepared.declaredNotRecorded
      ? ["    note: the running Ensemble service is older than this plugin and cannot store `conversationId` as a session reference, so the panel will not show it (sessions are still grouped by that id). Restarting the service updates it."]
      : []),
    ...parentLines(prepared.parents),
    "",
    "Next: open the panel URL in your browser tool if you have one, so the user can watch and steer. Use `wait` when you need the result.",
  ];
  return {
    text: lines.join("\n"),
    data: {
      sessionId: response.sessionId, runId: response.runId, panelUrl, phase: summary.phase, harness: summary.harness,
      ...(response.profile ? { profile: response.profile } : {}),
      ...(response.contextRefs ? { contextRefs: response.contextRefs } : {}),
    },
  };
}

const CWD_SOURCE_TEXT: Record<CwdSource, string> = {
  argument: "argument",
  "host-roots": "the workspace folder reported by the host",
  "bridge-directory": "the bridge process directory",
};

/** 会话的工作目录哪来的；只有退回桥的进程目录这一种需要提醒：那多半不是调用方指的项目。 */
function workspaceSourceLine(source: CwdSource): string {
  return `    workspace source: ${CWD_SOURCE_TEXT[source]}${source === "bridge-directory" ? " (pass `cwd` explicitly if this is not the project you meant)" : ""}`;
}

/**
 * 上级的回执：点名了一个、点名了几个（含老服务只记了第一个的说明）、或只是自动推断出的承接。
 * “没有采用推断的上级”“只记录了第一个”都直接看 `ParentChoice`（想挂的与实际记录的），不再各自重新判断。
 */
function parentLines({ followed, inferred, wanted, recorded }: ParentChoice): string[] {
  const [only] = followed;
  const overridden = inferred !== undefined && !wanted.includes(inferred);
  const notNested = overridden ? ` (not nested under session ${inferred}: \`follows\` takes precedence)` : "";
  if (followed.length === 1 && only) {
    return [`    follows session ${only.id} “${clip(only.title, 80)}”${notNested}`];
  }
  if (followed.length > 1) {
    return [
      // 多个上级：各自的 id 与标题都写在这一行里（上面的详情在 createdOutput 里去掉了自己的 `follows:` 行），并说明去向。
      `    follows ${followed.length} sessions: ${followed.map((session) => `${session.id} “${clip(session.title, 60)}”`).join(", ")}${notNested}`,
      ...(recorded.length < wanted.length
        ? [`    note: the running Ensemble service is older than this plugin and recorded only the first of them (${recorded[0]}); the others are not linked in the panel. Restarting the service updates it.`]
        : []),
    ];
  }
  return recorded[0] ? [`    nested under session ${recorded[0]}`] : [];
}
