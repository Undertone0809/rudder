// @vitest-environment node

import { describe, expect, it } from "vitest";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";

describe("LiveUpdatesProvider issue invalidation", () => {
  it("refreshes touched inbox queries for issue activity", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "organization-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        details: null,
      },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listTouchedByMe("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listUnreadTouchedByMe("organization-1"),
    });
  });
});

describe("LiveUpdatesProvider visible issue toast suppression", () => {
  it("suppresses activity toasts for the issue page currently in view", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          entityType: "issue",
          entityId: "issue-1",
          details: { identifier: "PAP-759" },
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          entityType: "issue",
          entityId: "issue-2",
          details: { identifier: "PAP-760" },
        },
        { isForegrounded: true },
      ),
    ).toBe(false);
  });

  it("suppresses run and agent status toasts for the assignee of the visible issue", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressRunStatusToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          runId: "run-1",
          agentId: "agent-1",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressAgentStatusToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          agentId: "agent-1",
          status: "running",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);
  });
});

describe("LiveUpdatesProvider notification preferences", () => {
  function createQueryClientStub() {
    return {
      invalidateQueries: () => {},
      getQueryData: () => undefined,
    };
  }

  it("does not push issue activity toasts when issue notifications are disabled", () => {
    const toasts: unknown[] = [];

    __liveUpdatesTestUtils.handleLiveEvent(
      createQueryClientStub() as never,
      "organization-1",
      "/ORG/dashboard",
      {
        type: "activity.logged",
        orgId: "organization-1",
        payload: {
          entityType: "issue",
          entityId: "issue-1",
          action: "issue.created",
          actorType: "user",
          actorId: "user-2",
          details: {
            identifier: "ORG-1",
            title: "New issue",
          },
        },
      } as never,
      (toast) => {
        toasts.push(toast);
        return "toast-1";
      },
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: false, chatNotifications: true },
    );

    expect(toasts).toEqual([]);
  });

  it("does not push chat toasts when chat notifications are disabled", () => {
    const toasts: unknown[] = [];

    __liveUpdatesTestUtils.handleLiveEvent(
      createQueryClientStub() as never,
      "organization-1",
      "/ORG/dashboard",
      {
        type: "activity.logged",
        orgId: "organization-1",
        payload: {
          entityType: "chat",
          entityId: "chat-1",
          action: "chat.message_added",
          details: {
            role: "assistant",
            preview: "I drafted the issue.",
            messageId: "message-1",
          },
        },
      } as never,
      (toast) => {
        toasts.push(toast);
        return "toast-1";
      },
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: true, chatNotifications: false },
    );

    expect(toasts).toEqual([]);
  });
});
