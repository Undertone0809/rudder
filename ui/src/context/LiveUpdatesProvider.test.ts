// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";

describe("LiveUpdatesProvider issue invalidation", () => {
  it("refreshes App Builder state for a verified-source activity", () => {
    const invalidations: unknown[] = [];
    __liveUpdatesTestUtils.invalidateActivityQueries(
      {
        invalidateQueries: (input: unknown) => invalidations.push(input),
      } as never,
      "organization-1",
      { entityType: "app_builder_app", entityId: "app-1" },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.appBuilder.organization("organization-1"),
    });
  });

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
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.chats.workManifests("organization-1"),
    });
  });

  it("refreshes the opened Run detail and event backfill on status changes", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.handleLiveEvent(
      queryClient as never,
      "organization-1",
      "/ORG/agents/agent-1/runs/run-1",
      {
        type: "heartbeat.run.status",
        orgId: "organization-1",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          status: "succeeded",
        },
      } as never,
      () => null,
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: true, chatNotifications: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.runDetail("run-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.runEvents("run-1"),
    });
  });
});

describe("LiveUpdatesProvider agent workspace invalidation", () => {
  it("refreshes agent Library folders when agent activity changes their ownership", () => {
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
        entityType: "agent",
        entityId: "agent-1",
      },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.organizations.workspaceFiles("organization-1", "agents"),
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

  it("does not push issue toasts for title and description-only updates", () => {
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
          action: "issue.updated",
          actorType: "user",
          actorId: "user-2",
          details: {
            identifier: "ORG-1",
            title: "Renamed issue",
            description: "New description",
            _previous: { title: "Old issue", description: "Old description" },
          },
        },
      } as never,
      (toast) => {
        toasts.push(toast);
        return "toast-1";
      },
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: true, chatNotifications: true },
    );

    expect(toasts).toEqual([]);
  });

  it("refreshes issue queries without a toast for quiet issue content updates", () => {
    const toasts: unknown[] = [];
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.handleLiveEvent(
      queryClient as never,
      "organization-1",
      "/ORG/dashboard",
      {
        type: "issue.content_updated",
        orgId: "organization-1",
        payload: {
          entityType: "issue",
          entityId: "issue-1",
          details: {
            identifier: "ORG-1",
            title: "Renamed issue",
            description: "New description",
          },
        },
      } as never,
      (toast) => {
        toasts.push(toast);
        return "toast-1";
      },
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: true, chatNotifications: true },
    );

    expect(toasts).toEqual([]);
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.activityRoot("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.threadPreview("organization-1"),
    });
  });

  it("refreshes Messenger and sidebar queries without a toast for automation issue-created notifications", () => {
    const toasts: unknown[] = [];
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.handleLiveEvent(
      queryClient as never,
      "organization-1",
      "/ORG/dashboard",
      {
        type: "activity.logged",
        orgId: "organization-1",
        payload: {
          entityType: "issue",
          entityId: "issue-1",
          action: "automation.issue_created_notification",
          actorType: "system",
          actorId: "automation-issue-notifier",
          details: {
            identifier: "ORG-1",
            title: "Automation created issue",
            userId: "user-1",
            source: "automation.issue_created_notification",
          },
        },
      } as never,
      (toast) => {
        toasts.push(toast);
        return "toast-1";
      },
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: true, chatNotifications: true },
    );

    expect(toasts).toEqual([]);
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.sidebarBadges("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.threads("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.threadPages("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.threadPreview("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.issues("organization-1"),
    });
  });

  it("refreshes Messenger and sidebar queries without a toast for Agent issue-created notifications", () => {
    const toasts: unknown[] = [];
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.handleLiveEvent(
      queryClient as never,
      "organization-1",
      "/ORG/dashboard",
      {
        type: "activity.logged",
        orgId: "organization-1",
        payload: {
          entityType: "issue",
          entityId: "issue-1",
          action: "agent.issue_created_notification",
          actorType: "agent",
          actorId: "agent-issue-notifier",
          details: {
            identifier: "ORG-1",
            title: "Agent created issue",
            userId: "user-1",
            source: "agent.issue_created_notification",
          },
        },
      } as never,
      (toast) => {
        toasts.push(toast);
        return "toast-1";
      },
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: true, chatNotifications: true },
    );

    expect(toasts).toEqual([]);
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.sidebarBadges("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.threads("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.threadPages("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.threadPreview("organization-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.messenger.issues("organization-1"),
    });
  });

  it("labels field-level issue update toasts for goals, projects, and unknown fields", () => {
    const toasts: Array<{ body?: string; title?: string }> = [];
    const gate = { cooldownHits: new Map(), suppressUntil: 0 };
    const queryClient = {
      invalidateQueries: () => {},
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("issue-1"))) {
          return {
            id: "issue-1",
            identifier: "ORG-1",
            title: "Issue update activity is too coarse",
          };
        }
        return undefined;
      },
    };

    for (const [field, value] of [
      ["goalId", "goal-new"],
      ["projectId", "project-new"],
      ["customWorkflowId", "workflow-new"],
    ]) {
      __liveUpdatesTestUtils.handleLiveEvent(
        queryClient as never,
        "organization-1",
        "/ORG/dashboard",
        {
          type: "activity.logged",
          orgId: "organization-1",
          payload: {
            entityType: "issue",
            entityId: "issue-1",
            action: "issue.updated",
            actorType: "user",
            actorId: "user-2",
            details: {
              [field]: value,
              _references: { related: { id: "reference-1", title: "Ignored reference" } },
              _previous: { [field]: `${value}-previous` },
            },
          },
        } as never,
        (toast) => {
          toasts.push(toast);
          return `toast-${toasts.length}`;
        },
        gate,
        { userId: "user-1", agentId: null },
        { issueNotifications: true, chatNotifications: true },
      );
    }

    expect(toasts.map((toast) => toast.body)).toEqual([
      "Issue update activity is too coarse - goal changed",
      "Issue update activity is too coarse - project changed",
      "Issue update activity is too coarse - custom workflow changed",
    ]);
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

  it("does not push live update toasts while Messenger is the visible surface", () => {
    const toasts: unknown[] = [];

    __liveUpdatesTestUtils.handleLiveEvent(
      createQueryClientStub() as never,
      "organization-1",
      "/ORG/messenger/system/failed-runs",
      {
        type: "heartbeat.run.status",
        orgId: "organization-1",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          status: "failed",
          error: "The run failed.",
        },
      } as never,
      (toast) => {
        toasts.push(toast);
        return "toast-1";
      },
      { cooldownHits: new Map(), suppressUntil: 0 },
      { userId: "user-1", agentId: null },
      { issueNotifications: true, chatNotifications: true },
    );

    __liveUpdatesTestUtils.handleLiveEvent(
      createQueryClientStub() as never,
      "organization-1",
      "/ORG/messenger/chat/chat-1",
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
      { issueNotifications: true, chatNotifications: true },
    );

    expect(toasts).toEqual([]);
  });

  it("keeps technical run failures out of terminal status toasts", () => {
    const toast = __liveUpdatesTestUtils.buildRunStatusToast(
      {
        runId: "run-1",
        agentId: "agent-1",
        status: "failed",
        error: "Process adapter missing command",
      },
      () => "Goal HTTP Agent",
    );

    expect(toast).toMatchObject({
      title: "Goal HTTP Agent run failed",
      body: "The Agent could not complete its latest action.",
    });
    expect(JSON.stringify(toast)).not.toContain("Process adapter missing command");
  });
});

describe("LiveUpdatesProvider chat invalidation", () => {
  it("does not restart chat-list requests for streaming progress updates", () => {
    const invalidateQueries = vi.fn(() => Promise.resolve());
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "organization-1",
      {
        entityType: "chat",
        entityId: "chat-1",
        action: "chat.message_updated",
        details: { messageId: "message-1", status: "streaming" },
      },
    );

    expect(invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.chats.detail("organization-1", "chat-1") },
      { cancelRefetch: false },
    );
    expect(invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.chats.messages("organization-1", "chat-1") },
      { cancelRefetch: false },
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith(
      { queryKey: queryKeys.chats.list("organization-1", "active") },
      expect.anything(),
    );
  });

  it("refreshes chat lists once a progress update reaches a terminal state", () => {
    const invalidateQueries = vi.fn(() => Promise.resolve());
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "organization-1",
      {
        entityType: "chat",
        entityId: "chat-1",
        action: "chat.message_updated",
        details: { messageId: "message-1", status: "completed" },
      },
    );

    expect(invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.chats.list("organization-1", "active") },
      { cancelRefetch: false },
    );
  });
});
