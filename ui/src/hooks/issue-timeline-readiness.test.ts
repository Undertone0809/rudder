import { describe, expect, it } from "vitest";
import { resolveIssueTimelineInitialSettlement } from "./issue-timeline-readiness";

describe("Issue timeline initial readiness", () => {
  it("latches the first successful settlement", () => {
    const ready = resolveIssueTimelineInitialSettlement(
      { key: "issue-1", status: "pending" },
      "issue-1",
      { allSuccessful: true, hasError: false },
    );
    expect(ready.status).toBe("ready");
    expect(resolveIssueTimelineInitialSettlement(
      ready,
      "issue-1",
      { allSuccessful: false, hasError: true },
    )).toBe(ready);
  });

  it("latches an initial failure across a successful retry", () => {
    const failed = resolveIssueTimelineInitialSettlement(
      { key: "issue-1", status: "pending" },
      "issue-1",
      { allSuccessful: false, hasError: true },
    );
    expect(failed.status).toBe("failed");
    expect(resolveIssueTimelineInitialSettlement(
      failed,
      "issue-1",
      { allSuccessful: true, hasError: false },
    )).toBe(failed);
  });

  it("starts a fresh settlement when the Issue changes", () => {
    expect(resolveIssueTimelineInitialSettlement(
      { key: "issue-1", status: "ready" },
      "issue-2",
      { allSuccessful: false, hasError: false },
    )).toEqual({ key: "issue-2", status: "pending" });
  });
});

