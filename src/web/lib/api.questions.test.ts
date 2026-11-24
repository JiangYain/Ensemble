import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import { api, ApiError, token } from "./api";

/** 回答 / 不回答一个提问的两个调用：地址、请求体、令牌，以及出错时服务端附带的事实怎样原样交到调用方手里。 */

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 假的服务：按给定的状态与内容回应，并记下收到的请求。 */
function serve(status: number, body: unknown, raw?: string) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string> | undefined) }, body: init?.body as string | undefined });
      return new Response(raw ?? JSON.stringify(body), { status });
    }),
  );
  return sent;
}

const RECEIPT = {
  questionId: "qst_b",
  status: "answered",
  outcome: { at: "2026-01-01T00:00:00.000Z", by: { kind: "user", label: "You" }, answers: [["web"]], delivery: "handed_off" },
  summary: { id: "ses_a" },
};

describe("api.answerQuestion", () => {
  it("posts the answer to the question's own address, with the token, and returns the receipt", async () => {
    const sent = serve(200, RECEIPT);
    const receipt = await api.answerQuestion("ses_a", "qst_b", { answer: "web" });

    expect(receipt).toEqual(RECEIPT);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: "/api/sessions/ses_a/questions/qst_b/answer", method: "POST", body: JSON.stringify({ answer: "web" }) });
    expect(sent[0]?.headers[TOKEN_HEADER]).toBe(token);
    expect(sent[0]?.headers["content-type"]).toBe("application/json");
  });

  it("sends `answers` for a question with several parts, as given", async () => {
    const sent = serve(200, RECEIPT);
    await api.answerQuestion("ses_a", "qst_b", { answers: ["web", ["linux", "win"]] });
    expect(JSON.parse(sent[0]?.body ?? "null")).toEqual({ answers: ["web", ["linux", "win"]] });
  });

  it("percent-encodes both ids, so a strange id cannot change the address", async () => {
    const sent = serve(200, RECEIPT);
    await api.answerQuestion("ses/../x", "qst b?", { answer: "web" });
    expect(sent[0]?.url).toBe("/api/sessions/ses%2F..%2Fx/questions/qst%20b%3F/answer");
  });

  it("raises an ApiError that keeps the status, the code and the facts the server attached (who answered first, why it expired)", async () => {
    serve(409, {
      error: {
        code: "conflict",
        message: "This question was already answered by Codex.",
        details: { questionId: "qst_b", status: "answered", resolvedBy: "Codex", resolvedByKind: "agent", resolvedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const failure = await api.answerQuestion("ses_a", "qst_b", { answer: "web" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      code: "conflict",
      status: 409,
      message: "This question was already answered by Codex.",
      details: { status: "answered", resolvedBy: "Codex", resolvedByKind: "agent" },
    });
  });

  it("keeps the not-waiting facts of an expired question", async () => {
    serve(409, { error: { code: "conflict", message: "The harness is no longer waiting for this question.", details: { questionId: "qst_b", status: "expired", reason: "not_waiting" } } });
    const failure = (await api.answerQuestion("ses_a", "qst_b", { answer: "web" }).catch((error: unknown) => error)) as ApiError;
    expect(failure.details).toEqual({ questionId: "qst_b", status: "expired", reason: "not_waiting" });
  });

  it("has no details when the server attached none, and falls back to the status when the body is not an error body", async () => {
    serve(422, { error: { code: "question_unsupported", message: "This harness cannot receive replies to its questions." } });
    const plain = (await api.answerQuestion("ses_a", "qst_b", { answer: "web" }).catch((error: unknown) => error)) as ApiError;
    expect(plain).toMatchObject({ code: "question_unsupported", status: 422 });
    expect(plain.details).toBeUndefined();

    serve(502, undefined, "<html>bad gateway</html>");
    const opaque = (await api.answerQuestion("ses_a", "qst_b", { answer: "web" }).catch((error: unknown) => error)) as ApiError;
    expect(opaque).toMatchObject({ code: "http_error", status: 502, message: "HTTP 502" });
    expect(opaque.details).toBeUndefined();
  });

  it("says the service cannot be reached when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const failure = await api.answerQuestion("ses_a", "qst_b", { answer: "web" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "network", status: 0 });
    expect(failure).toBeInstanceOf(ApiError);
  });
});

describe("api.declineQuestion", () => {
  it("posts to the decline address with an empty body when there is no note", async () => {
    const sent = serve(200, { ...RECEIPT, status: "declined" });
    const receipt = await api.declineQuestion("ses_a", "qst_b");
    expect(receipt.status).toBe("declined");
    expect(sent[0]).toMatchObject({ url: "/api/sessions/ses_a/questions/qst_b/decline", method: "POST", body: "{}" });
    expect(sent[0]?.headers[TOKEN_HEADER]).toBe(token);
  });

  it("passes the user's note along", async () => {
    const sent = serve(200, { ...RECEIPT, status: "declined" });
    await api.declineQuestion("ses_a", "qst_b", { note: "Pick whatever is simplest" });
    expect(JSON.parse(sent[0]?.body ?? "null")).toEqual({ note: "Pick whatever is simplest" });
  });

  it("raises the same ApiError with the standing outcome when the answer got there first", async () => {
    serve(409, { error: { code: "conflict", message: "This question was already answered by You.", details: { questionId: "qst_b", status: "answered", resolvedBy: "You", resolvedByKind: "user" } } });
    const failure = (await api.declineQuestion("ses_a", "qst_b").catch((error: unknown) => error)) as ApiError;
    expect(failure).toMatchObject({ code: "conflict", status: 409, details: { status: "answered", resolvedByKind: "user" } });
  });
});
