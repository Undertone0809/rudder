// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_ISSUES_CHANGED_EVENT,
  readRecentIssueIds,
  recentIssuesStorageKey,
  recordRecentIssue,
  resolveRecentIssues,
} from "./recent-issues";

function createStorageMock(): Pick<Storage, "clear" | "getItem" | "removeItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.has(key) ? values.get(key)! : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("recent issues helpers", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("falls back to legacy recent issues when no org-scoped entry exists", () => {
    window.localStorage.setItem("rudder:recent-issues", JSON.stringify(["issue-2", "issue-1"]));

    expect(readRecentIssueIds("org-1")).toEqual(["issue-2", "issue-1"]);
  });

  it("prefers the org-scoped recent issues entry over the legacy key", () => {
    window.localStorage.setItem("rudder:recent-issues", JSON.stringify(["legacy-issue"]));
    window.localStorage.setItem(
      recentIssuesStorageKey("org-1"),
      JSON.stringify(["org-issue-2", "org-issue-1"]),
    );

    expect(readRecentIssueIds("org-1")).toEqual(["org-issue-2", "org-issue-1"]);
  });

  it("records a recent issue once and keeps it at the front", () => {
    let eventDetail: unknown = null;
    window.addEventListener(RECENT_ISSUES_CHANGED_EVENT, (event) => {
      eventDetail = (event as CustomEvent).detail;
    }, { once: true });

    const next = recordRecentIssue("org-1", "issue-2", ["issue-3", "issue-2", "issue-1"]);

    expect(next).toEqual(["issue-2", "issue-3", "issue-1"]);
    expect(readRecentIssueIds("org-1")).toEqual(["issue-2", "issue-3", "issue-1"]);
    expect(eventDetail).toEqual({ orgId: "org-1", issueIds: ["issue-2", "issue-3", "issue-1"] });
  });

  it("resolves only currently visible issues while preserving recency order", () => {
    const visible = resolveRecentIssues(
      ["issue-3", "missing-issue", "issue-1", "issue-3"],
      [
        { id: "issue-1", title: "First" },
        { id: "issue-3", title: "Third" },
      ],
    );

    expect(visible).toEqual([
      { id: "issue-3", title: "Third" },
      { id: "issue-1", title: "First" },
    ]);
  });
});
