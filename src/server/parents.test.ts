import { describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import { EnsembleError } from "./errors";
import { missingParents, normalizeParents } from "./parents";

function rejection(run: () => unknown): EnsembleError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnsembleError) return error;
    throw error;
  }
  throw new Error("expected the call to be rejected");
}

describe("normalizeParents", () => {
  it("means no parent when neither field is given, or when parentSessionId is null", () => {
    expect(normalizeParents({})).toEqual([]);
    expect(normalizeParents({ parentSessionId: undefined, parentSessionIds: undefined })).toEqual([]);
    expect(normalizeParents({ parentSessionId: null })).toEqual([]);
  });

  it("reads a single parentSessionId as one parent", () => {
    expect(normalizeParents({ parentSessionId: "ses_a" })).toEqual(["ses_a"]);
  });

  it("keeps the order of parentSessionIds, first one primary", () => {
    expect(normalizeParents({ parentSessionIds: ["ses_b", "ses_a", "ses_c"] })).toEqual(["ses_b", "ses_a", "ses_c"]);
  });

  it("silently drops duplicates, keeping the first occurrence", () => {
    expect(normalizeParents({ parentSessionIds: ["ses_a", "ses_b", "ses_a"] })).toEqual(["ses_a", "ses_b"]);
    expect(normalizeParents({ parentSessionIds: ["ses_a", "ses_a"] })).toEqual(["ses_a"]);
  });

  it("accepts both fields when they agree about the primary parent", () => {
    expect(normalizeParents({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"] })).toEqual(["ses_a", "ses_b"]);
  });

  it("rejects both fields when they disagree, rather than guessing which was meant", () => {
    const error = rejection(() => normalizeParents({ parentSessionId: "ses_b", parentSessionIds: ["ses_a", "ses_b"] }));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("first entry");
    expect(error.details).toMatchObject({ parentSessionId: "ses_b", parentSessionIds: ["ses_a", "ses_b"] });
  });

  it("rejects a null parentSessionId next to a list of parents", () => {
    const error = rejection(() => normalizeParents({ parentSessionId: null, parentSessionIds: ["ses_a"] }));
    expect(error.code).toBe("invalid_request");
  });

  it("rejects an empty list instead of reading it as no parent", () => {
    const error = rejection(() => normalizeParents({ parentSessionIds: [] }));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("at least one");
  });

  it("allows exactly the limit and rejects one more, counting after duplicates are removed", () => {
    const ids = Array.from({ length: LIMITS.maxParents }, (_, index) => `ses_${index}`);
    expect(normalizeParents({ parentSessionIds: ids })).toEqual(ids);
    expect(normalizeParents({ parentSessionIds: [...ids, ...ids] })).toEqual(ids);

    const error = rejection(() => normalizeParents({ parentSessionIds: [...ids, "ses_extra"] }));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain(String(LIMITS.maxParents));
    expect(error.details).toMatchObject({ maxParents: LIMITS.maxParents });
  });
});

describe("missingParents", () => {
  it("is undefined when nothing is missing", () => {
    expect(missingParents([])).toBeUndefined();
  });

  it("says the same thing as before when exactly one parent is missing", () => {
    const error = missingParents(["ses_gone"])!;
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Parent session ses_gone does not exist.");
    expect(error.details).toEqual({ parentSessionId: "ses_gone" });
  });

  it("names every missing parent at once", () => {
    const error = missingParents(["ses_x", "ses_y"])!;
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Parent sessions ses_x, ses_y do not exist.");
    expect(error.details).toEqual({ parentSessionIds: ["ses_x", "ses_y"] });
  });
});
