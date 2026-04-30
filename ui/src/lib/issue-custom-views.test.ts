// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIssueCustomView,
  deleteIssueCustomView,
  ISSUE_CUSTOM_VIEWS_CHANGED_EVENT,
  readIssueCustomViews,
  updateIssueCustomViewState,
} from "./issue-custom-views";

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

const boardState = {
  statuses: ["in_review"],
  priorities: [],
  assignees: [],
  labels: [],
  projects: [],
  displayProperties: ["identifier", "assignee"],
  sortField: "updated" as const,
  sortDir: "desc" as const,
  groupBy: "none" as const,
  viewMode: "board" as const,
  collapsedGroups: [],
};

describe("issue custom view helpers", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("creates and reads organization-scoped custom issue boards", () => {
    let eventDetail: unknown = null;
    window.addEventListener(ISSUE_CUSTOM_VIEWS_CHANGED_EVENT, (event) => {
      eventDetail = (event as CustomEvent).detail;
    }, { once: true });

    const created = createIssueCustomView("org-1", "Review board", boardState);

    expect(readIssueCustomViews("org-1")).toEqual([created]);
    expect(readIssueCustomViews("org-2")).toEqual([]);
    expect(eventDetail).toMatchObject({ orgId: "org-1" });
  });

  it("updates and deletes a custom issue board", () => {
    const created = createIssueCustomView("org-1", "Review board", boardState);
    const updated = updateIssueCustomViewState("org-1", created.id, {
      ...boardState,
      statuses: ["blocked"],
    });

    expect(updated?.state.statuses).toEqual(["blocked"]);
    expect(readIssueCustomViews("org-1")[0]?.state.statuses).toEqual(["blocked"]);

    deleteIssueCustomView("org-1", created.id);
    expect(readIssueCustomViews("org-1")).toEqual([]);
  });
});
