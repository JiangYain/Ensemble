import { describe, expect, it } from "vitest";
import { newDelivery } from "@shared/delivery";
import { AGENT, USER, testMeta, testOrigin } from "@shared/testing";
import type { Message, SessionMeta } from "@shared/types";
import { makeEnv } from "./testing";

function setup(overrides: Partial<SessionMeta> = {}) {
  const env = makeEnv([]);
  const meta = testMeta(overrides);
  env.hub.emit(meta.id, { kind: "session.created", data: { meta }, source: "ensemble" });
  return { notices: env.notices, meta };
}

function messageOf(kind: Message["kind"]): Message {
  const at = "2026-01-01T00:00:01.000Z";
  return { id: "msg_1", sessionId: "ses_test", kind, author: USER, text: "Skip the slow ones", createdAt: at, delivery: newDelivery(at), sync: { toOrigin: "pending" } };
}

describe("NoticeCenter.syncIntervention", () => {
  it("tells the delegating agent what the user did, naming the session", () => {
    const { notices, meta } = setup();
    const session = '"Refactor the parser" (pi, ses_test)';

    notices.syncIntervention(meta, "intervention", { message: messageOf("steer") });
    notices.syncIntervention(meta, "intervention", { message: messageOf("follow_up") });
    notices.syncIntervention(meta, "cancel", { by: USER });
    notices.syncIntervention(meta, "stop", { by: USER });

    expect(notices.peek(meta.origin.key).map((notice) => notice.summary)).toEqual([
      `The user sent a correction directly to delegated session ${session} from the Ensemble panel.`,
      `The user sent a follow-up instruction directly to delegated session ${session} from the Ensemble panel.`,
      `The user requested an interruption or cancelled queued work in delegated session ${session} from the Ensemble panel.`,
      `The user closed delegated session ${session} from the Ensemble panel.`,
    ]);
  });

  it("carries the user's message so the agent sees the actual words", () => {
    const { notices, meta } = setup();
    notices.syncIntervention(meta, "intervention", { message: messageOf("steer") });
    expect(notices.peek(meta.origin.key)[0]).toMatchObject({ kind: "intervention", text: "Skip the slow ones", messageId: "msg_1" });
  });

  it("stays silent for sessions the user started themselves", () => {
    const { notices, meta } = setup({ origin: testOrigin({ key: "console:ui", kind: "user", host: "console", hostLabel: "Console" }) });
    notices.syncIntervention(meta, "cancel", { by: USER });
    expect(notices.pendingCount()).toBe(0);
  });

  it("ignores actions that were not taken by the user", () => {
    const { notices, meta } = setup();
    notices.syncIntervention(meta, "stop", { by: AGENT });
    notices.syncIntervention(meta, "stop", { by: { kind: "system", label: "Ensemble" } });
    expect(notices.pendingCount()).toBe(0);
  });
});
