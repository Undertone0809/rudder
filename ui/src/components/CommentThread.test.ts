import { describe, expect, it } from "vitest";
import { shouldOfferReopen } from "./CommentThread";

describe("CommentThread reopen gating", () => {
  it("only offers reopen for done issues", () => {
    expect(shouldOfferReopen("done")).toBe(true);
    expect(shouldOfferReopen("todo")).toBe(false);
    expect(shouldOfferReopen("in_progress")).toBe(false);
    expect(shouldOfferReopen("cancelled")).toBe(false);
    expect(shouldOfferReopen(undefined)).toBe(false);
  });
});
