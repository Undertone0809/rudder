import type { Agent, ChatConversation, MessengerThreadSummary, Project } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  applyManualCustomEntryOrder,
  compareCustomLayoutSections,
  customGroupIdFromSectionKey,
  customGroupSectionKey,
  dedupeThreadSummariesByKey,
  flattenThreadSections,
  locallyReadThreadSummary,
  nextDefaultThreadOrderKeysAfterMove,
  organizeCustomThreadDirectory,
  organizeThreadEntries,
  projectSectionKeyToStoredId,
  sortCustomLayoutSections,
  storedProjectSectionIdToKey,
  type OrganizedThreadEntry,
  type OrganizedThreadSection,
} from "./messenger-thread-organization";

function thread(
  threadKey: string,
  overrides: Partial<MessengerThreadSummary> = {},
): MessengerThreadSummary {
  return {
    threadKey,
    kind: threadKey.startsWith("chat:") ? "chat" : "issues",
    title: threadKey,
    subtitle: null,
    preview: null,
    latestActivityAt: "2026-07-17T08:00:00.000Z" as unknown as Date,
    lastReadAt: null,
    unreadCount: 0,
    needsAttention: false,
    isPinned: false,
    href: `/messenger/${threadKey}`,
    ...overrides,
  };
}

function conversation(
  id: string,
  overrides: Partial<ChatConversation> = {},
): ChatConversation {
  return {
    id,
    orgId: "org-1",
    preferredAgentId: null,
    routedAgentId: null,
    contextLinks: [],
    chatRuntime: null,
    isPinned: false,
    updatedAt: new Date("2026-07-17T08:00:00.000Z"),
    lastMessageAt: new Date("2026-07-17T08:00:00.000Z"),
    ...overrides,
  } as ChatConversation;
}

function entry(
  threadKey: string,
  overrides: Partial<MessengerThreadSummary> = {},
  chat: ChatConversation | null = null,
): OrganizedThreadEntry {
  return { thread: thread(threadKey, overrides), conversation: chat };
}

describe("messenger thread organization", () => {
  it("flattens nested pinned sections without losing leaf ownership", () => {
    const leaf = { key: "custom:pinned:loose", label: null, entries: [entry("chat:pinned")] };
    const root: OrganizedThreadSection = {
      key: "custom:pinned",
      label: "Pinned",
      entries: [],
      childSections: [leaf],
    };

    expect(flattenThreadSections([root])).toEqual([root, leaf]);
  });

  it("groups chat and split-issue summaries by project with fixed sections last", () => {
    const projects = new Map<string, Project>([
      ["project-1", { id: "project-1", name: "Alpha", icon: "folder", color: "teal" } as Project],
    ]);
    const entries = [
      entry(
        "chat:alpha",
        {},
        conversation("alpha", {
          contextLinks: [{
            entityType: "project",
            entityId: "project-1",
            entity: { label: "Alpha" },
          } as ChatConversation["contextLinks"][number]],
        }),
      ),
      entry("issue:alpha", {
        kind: "issues",
        metadata: { splitIssue: true, projectId: "project-1", projectName: "Alpha" },
      }),
      entry("issues", { kind: "issues" }),
      entry("chat:none", {}, conversation("none")),
    ];

    const sections = organizeThreadEntries(entries, "project", new Map(), projects, (kind) => kind);

    expect(sections.map((section) => section.key)).toEqual(["project:project-1", "system", "project:none"]);
    expect(sections[0]?.entries.map((item) => item.thread.threadKey)).toEqual(["chat:alpha", "issue:alpha"]);
  });

  it("keeps project section storage identifiers reversible", () => {
    expect(projectSectionKeyToStoredId("project:project-1")).toBe("project-1");
    expect(storedProjectSectionIdToKey("project-1")).toBe("project:project-1");
    expect(projectSectionKeyToStoredId("project:none")).toBe("messenger-section:project:none");
    expect(storedProjectSectionIdToKey("messenger-section:project:none")).toBe("project:none");
    expect(customGroupIdFromSectionKey(customGroupSectionKey("group-1"))).toBe("group-1");
  });

  it("deduplicates summaries first-wins and clears unread only for the exact local watermark", () => {
    const first = thread("issue:1", { unreadCount: 2, needsAttention: true });
    const duplicate = thread("issue:1", { title: "duplicate" });

    expect(dedupeThreadSummariesByKey([first, duplicate])).toEqual([first]);
    expect(locallyReadThreadSummary(first, new Map([["issue:1", "2026-07-17T08:00:00.000Z"]])))
      .toMatchObject({ unreadCount: 0, needsAttention: false });
    expect(locallyReadThreadSummary(first, new Map([["issue:1", "stale"]]))).toBe(first);
  });

  it("applies manual entry order at the first affected position and preserves hidden keys", () => {
    const entries = [entry("chat:newest"), entry("chat:older"), entry("chat:oldest")];
    expect(applyManualCustomEntryOrder(entries, ["chat:oldest", "chat:older"]).map((item) => item.thread.threadKey))
      .toEqual(["chat:newest", "chat:oldest", "chat:older"]);

    expect(nextDefaultThreadOrderKeysAfterMove(
      ["chat:a", "chat:b", "chat:c"],
      ["chat:hidden", "chat:b"],
      2,
      0,
    )).toEqual(["chat:hidden", "chat:c", "chat:a", "chat:b"]);
  });

  it("never moves an unpinned custom section ahead of a pinned section", () => {
    const sections: OrganizedThreadSection[] = [
      { key: "custom-group:pinned", label: "Pinned", isPinned: true, entries: [entry("chat:pinned")] },
      { key: "custom-group:regular", label: "Regular", isPinned: false, entries: [entry("chat:regular")] },
    ];

    expect(sortCustomLayoutSections(
      sections,
      ["custom-group:regular", "custom-group:pinned"],
    ).map((section) => section.key)).toEqual(["custom-group:pinned", "custom-group:regular"]);
  });

  it("keeps an older default custom group behind newer loose threads", () => {
    const group: OrganizedThreadSection = {
      key: "custom-group:group-1",
      label: "Deep work",
      isPinned: false,
      entries: [entry("chat:grouped", { latestActivityAt: "2026-07-17T08:00:00.000Z" as unknown as Date })],
    };
    const newest: OrganizedThreadSection = {
      key: "chat:newest",
      label: null,
      entries: [entry("chat:newest", { latestActivityAt: "2026-07-17T08:02:00.000Z" as unknown as Date })],
    };
    const middle: OrganizedThreadSection = {
      key: "chat:middle",
      label: null,
      entries: [entry("chat:middle", { latestActivityAt: "2026-07-17T08:01:00.000Z" as unknown as Date })],
    };
    const activitySorted = [group, newest, middle].sort(compareCustomLayoutSections);

    expect(sortCustomLayoutSections(activitySorted, [group.key]).map((section) => section.key))
      .toEqual(["chat:newest", "chat:middle", "custom-group:group-1"]);
  });

  it("owns the Arc-style custom directory layout including pin boundaries and membership", () => {
    const sections = organizeCustomThreadDirectory(
      [
        entry("chat:grouped", { latestActivityAt: new Date("2026-07-17T08:03:00.000Z") }),
        entry("chat:loose-pinned", {
          isPinned: true,
          latestActivityAt: new Date("2026-07-17T08:01:00.000Z"),
        }),
        entry("chat:loose", { latestActivityAt: new Date("2026-07-17T08:02:00.000Z") }),
      ],
      [
        {
          id: "group-1",
          name: "Pinned group",
          icon: "folder",
          pinned: true,
          entries: [entry("chat:grouped")],
        },
      ],
      ["chat:loose-pinned", "custom-group:group-1"],
    );

    expect(sections.map((section) => section.key)).toEqual(["custom:pinned", "chat:loose"]);
    expect(sections[0]?.childSections?.map((section) => section.key)).toEqual([
      "custom-group:group-1",
      "custom:pinned:loose",
    ]);
    expect(sections[0]?.childSections?.[0]?.entries[0]).toMatchObject({
      customGroupId: "group-1",
      thread: { threadKey: "chat:grouped" },
    });
    expect(sections[0]?.childSections?.[1]?.entries.map((item) => item.thread.threadKey))
      .toEqual(["chat:loose-pinned"]);
  });

  it("groups split issues by assignee with organization-provided agent labels", () => {
    const agents = new Map<string, Agent>([
      ["agent-1", { id: "agent-1", name: "Ada" } as Agent],
    ]);
    const sections = organizeThreadEntries([
      entry("issue:1", {
        kind: "issues",
        metadata: { splitIssue: true, assigneeAgentId: "agent-1" },
      }),
      entry("issue:2", { kind: "issues", metadata: { splitIssue: true } }),
    ], "agent", agents, new Map(), (kind) => kind);

    expect(sections.map((section) => section.key)).toEqual(["agent:agent-1", "agent:none"]);
    expect(sections.map((section) => section.label)).toEqual(["Ada", "No agent"]);
  });

  it("groups thread kinds and attention state with stable labels and priority", () => {
    const entries = [
      entry("issues", { kind: "issues" }),
      entry("chat:attention", { kind: "chat", unreadCount: 1 }),
      entry("chat:settled", { kind: "chat" }),
    ];

    const kindSections = organizeThreadEntries(
      entries,
      "kind",
      new Map(),
      new Map(),
      (kind) => `Label ${kind}`,
    );
    expect(kindSections.map((section) => [section.key, section.label])).toEqual([
      ["kind:chat", "Label chat"],
      ["kind:issues", "Label issues"],
    ]);

    const attentionSections = organizeThreadEntries(
      entries,
      "attention",
      new Map(),
      new Map(),
      (kind) => kind,
    );
    expect(attentionSections.map((section) => section.key)).toEqual([
      "attention:needs",
      "attention:other",
    ]);
    expect(attentionSections[0]?.entries.map((item) => item.thread.threadKey))
      .toEqual(["chat:attention"]);
  });
});
