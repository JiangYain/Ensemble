import type { SessionSummary } from "./types";

/** A finished run may still have a steering call that can turn into a follow-up. */
export function isSessionSettled(summary: Pick<SessionSummary, "phase" | "messages">): boolean {
  switch (summary.phase) {
    case "done":
    case "failed":
    case "cancelled":
      return summary.messages.pending === 0;
    case "stopped":
    case "lost":
      return true;
    default:
      return false;
  }
}
