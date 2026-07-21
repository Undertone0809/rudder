import type { Agent, ChatConversation, MessengerThreadSummary, Project } from "@rudderhq/shared";
import { isLocalManagedThreadGroupRule, type ThreadOrganizationRule } from "./messenger-preferences";
import { resolveSourceBadge } from "./source-badge";

export type StandardThreadOrganizationRule = Exclude<ThreadOrganizationRule, "custom" | "latest">;

const PROJECT_PINNED_SECTION_KEY = "project:pinned";

interface ThreadGroup {
  key: string;
  label: string;
  sortLabel?: string;
  projectIcon?: string | null;
  projectColor?: string | null;
}

export interface OrganizedThreadEntry {
  thread: MessengerThreadSummary;
  conversation: ChatConversation | null;
  customGroupId?: string | null;
}

export interface OrganizedThreadSection {
  key: string;
  label: string | null;
  icon?: string | null;
  projectIcon?: string | null;
  projectColor?: string | null;
  isPinned?: boolean;
  pending?: boolean;
  entries: OrganizedThreadEntry[];
  childSections?: OrganizedThreadSection[];
}

export interface CustomThreadGroupLayoutInput {
  id: string;
  name: string;
  icon?: string | null;
  pinned: boolean;
  entries: OrganizedThreadEntry[];
}

export function threadConversationId(threadKey: string) {
  return threadKey.startsWith("chat:") ? threadKey.slice("chat:".length) : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function chatConversationForThreadSummary(
  thread: MessengerThreadSummary,
  orgId: string,
  conversation: ChatConversation | null | undefined,
): ChatConversation | null {
  if (thread.kind !== "chat") return null;
  const conversationId = threadConversationId(thread.threadKey);
  if (!conversationId) return null;

  const metadata = thread.metadata ?? {};
  const preferredAgentId = nonEmptyString(metadata.preferredAgentId);
  const routedAgentId = nonEmptyString(metadata.routedAgentId);
  const runtimeAgentId = nonEmptyString(metadata.runtimeAgentId);
  const latestUserMessagePreview = nonEmptyString(metadata.latestUserMessagePreview);
  const isPinned = typeof thread.isPinned === "boolean" ? thread.isPinned : Boolean(conversation?.isPinned);
  const sourceBadge = resolveSourceBadge(conversation, metadata);
  const sourceMetadata = conversation?.sourceMetadata
    ?? (sourceBadge?.key === "feishu" ? { source: "agent_integration", provider: "feishu" } : null);
  const mutability = conversation?.mutability
    ?? (sourceBadge?.key === "feishu" ? "external_bound_chat" : "native_chat");
  if (conversation) {
    return {
      ...conversation,
      mutability,
      sourceMetadata,
      title: thread.title.includes("…") ? conversation.title : thread.title,
      preferredAgentId: conversation.preferredAgentId ?? preferredAgentId,
      routedAgentId: conversation.routedAgentId ?? routedAgentId,
      chatRuntime: {
        ...conversation.chatRuntime,
        runtimeAgentId: conversation.chatRuntime?.runtimeAgentId ?? runtimeAgentId,
      },
      lastReadAt: thread.lastReadAt ?? conversation.lastReadAt,
      unreadCount: thread.unreadCount,
      isUnread: thread.unreadCount > 0,
      needsAttention: thread.needsAttention,
      isPinned,
    };
  }

  const activityAt = thread.latestActivityAt ? new Date(thread.latestActivityAt) : new Date();
  const preview = thread.preview ?? thread.subtitle ?? null;
  return {
    id: conversationId,
    orgId,
    status: "active",
    mutability,
    title: thread.title,
    summary: null,
    latestReplyPreview: preview,
    latestUserMessagePreview,
    userMessageCount: 0,
    preferredAgentId,
    routedAgentId,
    primaryIssueId: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: null,
    lastMessageAt: activityAt,
    lastReadAt: thread.lastReadAt,
    isPinned,
    isUnread: thread.unreadCount > 0,
    unreadCount: thread.unreadCount,
    needsAttention: thread.needsAttention,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: {
      sourceType: "unconfigured",
      sourceLabel: "Agent unavailable",
      runtimeAgentId,
      agentRuntimeType: null,
      model: null,
      available: false,
      error: null,
    },
    sourceMetadata,
    createdAt: activityAt,
    updatedAt: activityAt,
  };
}

export function flattenThreadSectionEntries(
  sections: OrganizedThreadSection[] | undefined,
): OrganizedThreadEntry[] {
  if (!sections?.length) return [];
  return sections.flatMap((section) => [
    ...section.entries,
    ...flattenThreadSectionEntries(section.childSections),
  ]);
}

export function flattenThreadSections(
  sections: OrganizedThreadSection[] | undefined,
): OrganizedThreadSection[] {
  if (!sections?.length) return [];
  return sections.flatMap((section) => [
    section,
    ...flattenThreadSections(section.childSections),
  ]);
}

export function projectIdFromSectionKey(sectionKey: string) {
  return sectionKey.startsWith("project:")
    && sectionKey !== "project:none"
    && sectionKey !== PROJECT_PINNED_SECTION_KEY
    ? sectionKey.slice("project:".length)
    : null;
}

function syntheticProjectSectionIdFromKey(sectionKey: string) {
  return projectIdFromSectionKey(sectionKey) ? null : `messenger-section:${sectionKey}`;
}

export function projectSectionKeyToStoredId(sectionKey: string) {
  return projectIdFromSectionKey(sectionKey) ?? syntheticProjectSectionIdFromKey(sectionKey) ?? sectionKey;
}

export function storedProjectSectionIdToKey(storedId: string) {
  if (storedId.startsWith("messenger-section:")) return storedId.slice("messenger-section:".length);
  if (storedId.startsWith("project:")) return storedId;
  return `project:${storedId}`;
}

export function threadSectionKeyToStoredId(rule: ThreadOrganizationRule, sectionKey: string) {
  return rule === "project" ? projectSectionKeyToStoredId(sectionKey) : sectionKey;
}

export function storedThreadSectionIdToKey(rule: ThreadOrganizationRule, storedId: string) {
  return rule === "project" ? storedProjectSectionIdToKey(storedId) : storedId;
}

export function customGroupSectionKey(groupId: string) {
  return `custom-group:${groupId}`;
}

export function customGroupIdFromSectionKey(sectionKey: string) {
  return sectionKey.startsWith("custom-group:") ? sectionKey.slice("custom-group:".length) : null;
}

function sortProjectThreadSections(
  sections: OrganizedThreadSection[],
  orderedProjectIds: string[],
  orderedSectionIds: string[] = [],
) {
  if (sections.length === 0) return sections;
  const pinnedSections = sections.filter((section) => section.isPinned);
  const unpinnedSections = sections.filter((section) => !section.isPinned);
  const orderIndex = new Map(orderedProjectIds.map((id, index) => [id, index]));
  const realProjectSections: OrganizedThreadSection[] = [];
  const fixedSections: OrganizedThreadSection[] = [];

  for (const section of unpinnedSections) {
    if (projectIdFromSectionKey(section.key)) realProjectSections.push(section);
    else fixedSections.push(section);
  }

  realProjectSections.sort((a, b) => {
    const aProjectId = projectIdFromSectionKey(a.key);
    const bProjectId = projectIdFromSectionKey(b.key);
    const aIndex = aProjectId ? orderIndex.get(aProjectId) : undefined;
    const bIndex = bProjectId ? orderIndex.get(bProjectId) : undefined;
    if (aIndex !== undefined || bIndex !== undefined) {
      return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return (a.label ?? "").localeCompare(b.label ?? "");
  });

  const projectSortedSections = [...realProjectSections, ...fixedSections];
  if (orderedSectionIds.length === 0) return [...pinnedSections, ...projectSortedSections];
  const sectionOrderIndex = new Map(
    orderedSectionIds.map((id, index) => [storedProjectSectionIdToKey(id), index]),
  );
  const baseIndex = new Map(projectSortedSections.map((section, index) => [section.key, index]));
  const orderedUnpinnedSections = [...projectSortedSections].sort((a, b) => {
    const aIndex = sectionOrderIndex.get(a.key);
    const bIndex = sectionOrderIndex.get(b.key);
    if (aIndex !== undefined || bIndex !== undefined) {
      return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return (baseIndex.get(a.key) ?? 0) - (baseIndex.get(b.key) ?? 0);
  });
  return [...pinnedSections, ...orderedUnpinnedSections];
}

export function sortManagedThreadSections(
  sections: OrganizedThreadSection[],
  rule: ThreadOrganizationRule,
  orderedProjectIds: string[],
  orderedSectionIds: string[] = [],
) {
  if (!isLocalManagedThreadGroupRule(rule)) return sections;
  if (rule === "project") return sortProjectThreadSections(sections, orderedProjectIds, orderedSectionIds);
  if (orderedSectionIds.length === 0) return sections;

  const sectionOrderIndex = new Map(
    orderedSectionIds.map((id, index) => [storedThreadSectionIdToKey(rule, id), index]),
  );
  const baseIndex = new Map(sections.map((section, index) => [section.key, index]));
  return [...sections].sort((a, b) => {
    const aIndex = sectionOrderIndex.get(a.key);
    const bIndex = sectionOrderIndex.get(b.key);
    if (aIndex !== undefined || bIndex !== undefined) {
      return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return (baseIndex.get(a.key) ?? 0) - (baseIndex.get(b.key) ?? 0);
  });
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveChatAgentId(
  conversation: Pick<ChatConversation, "preferredAgentId" | "routedAgentId" | "chatRuntime">,
) {
  return conversation.chatRuntime?.runtimeAgentId
    ?? conversation.routedAgentId
    ?? conversation.preferredAgentId
    ?? null;
}

function projectIdentityForGroup(projectId: string | null, projectsById: ReadonlyMap<string, Project>) {
  return projectId ? projectsById.get(projectId) ?? null : null;
}

function chatProjectGroup(
  conversation: ChatConversation | null,
  projectsById: ReadonlyMap<string, Project>,
): ThreadGroup {
  const projectLink = conversation?.contextLinks?.find((link) => link.entityType === "project") ?? null;
  const projectId = typeof projectLink?.entityId === "string" && projectLink.entityId.trim()
    ? projectLink.entityId.trim()
    : null;
  const project = projectIdentityForGroup(projectId, projectsById);
  const label = project?.name
    || projectLink?.entity?.label
    || projectLink?.entity?.identifier
    || (projectLink ? "Unknown project" : "No project");
  return projectId
    ? {
        key: `project:${projectId}`,
        label,
        sortLabel: label,
        projectIcon: project?.icon,
        projectColor: project?.color,
      }
    : { key: "project:none", label };
}

function splitIssueProjectGroup(
  thread: MessengerThreadSummary,
  projectsById: ReadonlyMap<string, Project>,
): ThreadGroup | null {
  if (thread.metadata?.splitIssue !== true) return null;
  const metadata = thread.metadata;
  const projectId = metadataString(metadata, "projectId");
  const project = projectIdentityForGroup(projectId, projectsById);
  const label = project?.name
    ?? metadataString(metadata, "projectName")
    ?? (projectId ? "Unknown project" : "No project");
  return projectId
    ? {
        key: `project:${projectId}`,
        label,
        sortLabel: label,
        projectIcon: project?.icon,
        projectColor: project?.color,
      }
    : { key: "project:none", label };
}

function entryAgentGroup(entry: OrganizedThreadEntry, agentsById: Map<string, Agent>): ThreadGroup {
  if (entry.thread.kind === "chat") {
    const agentId = entry.conversation ? resolveChatAgentId(entry.conversation) : null;
    if (!agentId) return { key: "agent:unavailable", label: "Agent unavailable" };
    const agent = agentsById.get(agentId);
    if (!agent) return { key: "agent:unavailable", label: "Agent unavailable" };
    const label = agent.name;
    return { key: `agent:${agentId}`, label, sortLabel: label };
  }

  if (entry.thread.metadata?.splitIssue === true) {
    const metadata = entry.thread.metadata;
    const agentId = metadataString(metadata, "assigneeAgentId")
      ?? metadataString(metadata, "agentId")
      ?? metadataString(metadata, "runtimeAgentId")
      ?? metadataString(metadata, "preferredAgentId");
    if (!agentId) return { key: "agent:unassigned", label: "Unassigned" };
    const label = agentsById.get(agentId)?.name
      ?? metadataString(metadata, "assigneeAgentName")
      ?? metadataString(metadata, "agentName")
      ?? "Unknown agent";
    return { key: `agent:${agentId}`, label, sortLabel: label };
  }

  return { key: "system", label: "System" };
}

export function isPinnedEntry(entry: OrganizedThreadEntry) {
  return typeof entry.thread.isPinned === "boolean"
    ? entry.thread.isPinned
    : Boolean(entry.conversation?.isPinned);
}

export function dedupeThreadSummariesByKey(threadSummaries: MessengerThreadSummary[]) {
  const seen = new Set<string>();
  return threadSummaries.filter((thread) => {
    if (seen.has(thread.threadKey)) return false;
    seen.add(thread.threadKey);
    return true;
  });
}

export function dedupeOrganizedThreadEntriesByKey(entries: OrganizedThreadEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.thread.threadKey)) return false;
    seen.add(entry.thread.threadKey);
    return true;
  });
}

export function splitIssueThreadWatermark(thread: MessengerThreadSummary) {
  if (thread.metadata?.splitIssue !== true) return null;
  return [
    thread.latestActivityAt ? new Date(thread.latestActivityAt).toISOString() : "none",
    metadataString(thread.metadata, "status") ?? "unknown",
    metadataString(thread.metadata, "activeExecutionRunId") ?? "idle",
    String(thread.unreadCount),
    thread.needsAttention ? "attention" : "settled",
  ].join("|");
}

export function threadMatchesMessengerIssueRoute(thread: MessengerThreadSummary, issueRef: string) {
  if (thread.metadata?.splitIssue !== true) return false;
  if (thread.metadata.issueId === issueRef || thread.metadata.issueIdentifier === issueRef) return true;
  const normalizedHref = thread.href.split("?")[0]?.split("#")[0] ?? thread.href;
  return normalizedHref === `/messenger/issues/${issueRef}`;
}

function entryActivityTime(entry: OrganizedThreadEntry) {
  const value = entry.thread.latestActivityAt
    ?? (entry.conversation?.lastMessageAt ?? entry.conversation?.updatedAt ?? null);
  return value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY;
}

export function compareThreadEntries(a: OrganizedThreadEntry, b: OrganizedThreadEntry) {
  if (isPinnedEntry(a) !== isPinnedEntry(b)) return isPinnedEntry(a) ? -1 : 1;
  const timeDiff = entryActivityTime(b) - entryActivityTime(a);
  if (timeDiff !== 0) return timeDiff;
  return a.thread.title.localeCompare(b.thread.title);
}

function sectionActivityTime(section: OrganizedThreadSection) {
  return section.entries.reduce(
    (latest, entry) => Math.max(latest, entryActivityTime(entry)),
    Number.NEGATIVE_INFINITY,
  );
}

export function compareCustomLayoutSections(a: OrganizedThreadSection, b: OrganizedThreadSection) {
  if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
  const timeDiff = sectionActivityTime(b) - sectionActivityTime(a);
  if (timeDiff !== 0) return timeDiff;
  return (a.label ?? a.entries[0]?.thread.title ?? a.key)
    .localeCompare(b.label ?? b.entries[0]?.thread.title ?? b.key);
}

function applyManualCustomLayoutOrder(
  sections: OrganizedThreadSection[],
  orderedSectionKeys: string[],
) {
  const sectionByKey = new Map(sections.map((section) => [section.key, section]));
  const manualSections = orderedSectionKeys
    .map((sectionKey) => sectionByKey.get(sectionKey) ?? null)
    .filter((section): section is OrganizedThreadSection => Boolean(section));
  if (manualSections.length === 0) return sections;

  const manualSectionKeys = new Set(manualSections.map((section) => section.key));
  const firstManualBaseIndex = sections.findIndex((section) => manualSectionKeys.has(section.key));
  if (firstManualBaseIndex === -1) return sections;
  return [
    ...sections.slice(0, firstManualBaseIndex).filter((section) => !manualSectionKeys.has(section.key)),
    ...manualSections,
    ...sections.slice(firstManualBaseIndex).filter((section) => !manualSectionKeys.has(section.key)),
  ];
}

export function sortCustomLayoutSections(
  sections: OrganizedThreadSection[],
  orderedSectionKeys: string[],
) {
  if (orderedSectionKeys.length === 0) return sections;
  const pinnedSections = sections.filter((section) => section.isPinned);
  const unpinnedSections = sections.filter((section) => !section.isPinned);
  return [
    ...applyManualCustomLayoutOrder(pinnedSections, orderedSectionKeys),
    ...applyManualCustomLayoutOrder(unpinnedSections, orderedSectionKeys),
  ];
}

export function applyManualCustomEntryOrder(
  entries: OrganizedThreadEntry[],
  orderedThreadKeys: string[],
) {
  if (orderedThreadKeys.length === 0) return entries;
  const entryByKey = new Map(entries.map((entry) => [entry.thread.threadKey, entry]));
  const manualEntries = orderedThreadKeys
    .map((threadKey) => entryByKey.get(threadKey) ?? null)
    .filter((entry): entry is OrganizedThreadEntry => Boolean(entry));
  if (manualEntries.length === 0) return entries;

  const manualThreadKeys = new Set(manualEntries.map((entry) => entry.thread.threadKey));
  const firstManualBaseIndex = entries.findIndex((entry) => manualThreadKeys.has(entry.thread.threadKey));
  if (firstManualBaseIndex === -1) return entries;
  return [
    ...entries.slice(0, firstManualBaseIndex).filter((entry) => !manualThreadKeys.has(entry.thread.threadKey)),
    ...manualEntries,
    ...entries.slice(firstManualBaseIndex).filter((entry) => !manualThreadKeys.has(entry.thread.threadKey)),
  ];
}

export function organizeCustomThreadDirectory(
  looseEntries: OrganizedThreadEntry[],
  groups: CustomThreadGroupLayoutInput[],
  orderedSectionKeys: string[],
): OrganizedThreadSection[] {
  const groupedThreadKeys = new Set(
    groups.flatMap((group) => group.entries.map((entry) => entry.thread.threadKey)),
  );
  const groupSections = groups.map((group) => ({
    key: customGroupSectionKey(group.id),
    label: group.name,
    icon: group.icon,
    isPinned: group.pinned,
    entries: group.entries.map((entry) => ({ ...entry, customGroupId: group.id })),
  }) satisfies OrganizedThreadSection);
  const ungroupedEntries = looseEntries
    .filter((entry) => !groupedThreadKeys.has(entry.thread.threadKey))
    .map((entry) => ({ ...entry, customGroupId: null }))
    .sort(compareThreadEntries);
  const allEntries = dedupeOrganizedThreadEntriesByKey([
    ...groupSections.flatMap((section) => section.entries),
    ...ungroupedEntries,
  ]);
  const pinnedLooseEntries = applyManualCustomEntryOrder(
    allEntries
      .filter((entry) => isPinnedEntry(entry) && entry.customGroupId === null)
      .sort(compareThreadEntries),
    orderedSectionKeys,
  );
  const looseSections = ungroupedEntries
    .filter((entry) => !isPinnedEntry(entry))
    .map((entry) => ({
      key: entry.thread.threadKey,
      label: null,
      entries: [entry],
    }) satisfies OrganizedThreadSection);
  const topLevelSections = sortCustomLayoutSections(
    [...groupSections, ...looseSections].sort(compareCustomLayoutSections),
    orderedSectionKeys.length > 0
      ? orderedSectionKeys
      : groupSections.map((section) => section.key),
  );
  const pinnedChildSections = [
    ...topLevelSections.filter((section) => section.isPinned),
    ...(pinnedLooseEntries.length > 0
      ? [{
        key: "custom:pinned:loose",
        label: null,
        entries: pinnedLooseEntries,
      } satisfies OrganizedThreadSection]
      : []),
  ];

  return [
    ...(pinnedChildSections.length > 0
      ? [{
        key: "custom:pinned",
        label: "Pinned",
        entries: [],
        childSections: pinnedChildSections,
      } satisfies OrganizedThreadSection]
      : []),
    ...topLevelSections.filter((section) => !section.isPinned),
  ];
}

export function organizeProjectThreadDirectory(
  looseEntries: OrganizedThreadEntry[],
  groups: CustomThreadGroupLayoutInput[],
  projectsById: ReadonlyMap<string, Project>,
): OrganizedThreadSection[] {
  const groupedThreadKeys = new Set<string>();
  const groupSections = groups.map((group) => ({
    key: customGroupSectionKey(group.id),
    label: group.name,
    icon: group.icon,
    isPinned: group.pinned,
    entries: group.entries
      .filter((entry) => {
        if (groupedThreadKeys.has(entry.thread.threadKey)) return false;
        groupedThreadKeys.add(entry.thread.threadKey);
        return true;
      })
      .map((entry) => ({ ...entry, customGroupId: group.id })),
  }) satisfies OrganizedThreadSection);
  const ungroupedEntries = dedupeOrganizedThreadEntriesByKey(looseEntries)
    .filter((entry) => !groupedThreadKeys.has(entry.thread.threadKey))
    .map((entry) => ({ ...entry, customGroupId: null }));
  const projectSections = organizeThreadEntries(
    ungroupedEntries,
    "project",
    new Map(),
    projectsById,
    (kind) => kind,
  );

  const attachGroups = (
    sectionKey: string,
    label: string,
    isPinned: boolean,
    childSections: OrganizedThreadSection[],
  ) => {
    if (childSections.length === 0) return;
    const sectionIndex = projectSections.findIndex((section) => section.key === sectionKey);
    if (sectionIndex === -1) {
      const section = {
        key: sectionKey,
        label,
        isPinned,
        entries: [],
        childSections,
      } satisfies OrganizedThreadSection;
      if (isPinned) projectSections.unshift(section);
      else projectSections.push(section);
      return;
    }
    const section = projectSections[sectionIndex];
    if (!section) return;
    projectSections[sectionIndex] = {
      ...section,
      childSections: [...childSections, ...section.childSections ?? []],
    };
  };

  attachGroups(
    PROJECT_PINNED_SECTION_KEY,
    "Pinned",
    true,
    groupSections.filter((section) => section.isPinned),
  );
  attachGroups(
    "project:none",
    "No project",
    false,
    groupSections.filter((section) => !section.isPinned),
  );
  return projectSections;
}

function moveArrayItem<T>(items: T[], oldIndex: number, newIndex: number) {
  const next = [...items];
  if (oldIndex < 0 || oldIndex >= next.length || newIndex < 0 || newIndex >= next.length) {
    return next;
  }
  const [moved] = next.splice(oldIndex, 1);
  if (moved === undefined) return next;
  next.splice(newIndex, 0, moved);
  return next;
}

export function nextDefaultThreadOrderKeysAfterMove(
  sectionKeys: string[],
  currentOrderKeys: string[],
  oldIndex: number,
  newIndex: number,
) {
  const movedThreadKeys = moveArrayItem(sectionKeys, oldIndex, newIndex);
  const start = Math.min(oldIndex, newIndex);
  const end = Math.max(oldIndex, newIndex);
  const affectedThreadKeys = new Set(movedThreadKeys.slice(start, end + 1));
  const visibleThreadKeys = new Set(sectionKeys);
  const currentOrderKeySet = new Set(currentOrderKeys);
  return [
    ...currentOrderKeys.filter((threadKey) => !visibleThreadKeys.has(threadKey)),
    ...movedThreadKeys.filter((threadKey) =>
      affectedThreadKeys.has(threadKey) || currentOrderKeySet.has(threadKey),
    ),
  ];
}

function groupEntries(
  entries: OrganizedThreadEntry[],
  groupForEntry: (entry: OrganizedThreadEntry) => ThreadGroup,
) {
  const sections = new Map<string, { group: ThreadGroup; entries: OrganizedThreadEntry[] }>();
  for (const entry of entries) {
    const group = groupForEntry(entry);
    const existing = sections.get(group.key);
    if (existing) existing.entries.push(entry);
    else sections.set(group.key, { group, entries: [entry] });
  }
  return Array.from(sections.values())
    .sort((a, b) => {
      if (a.group.key === "attention:needs") return -1;
      if (b.group.key === "attention:needs") return 1;
      if (a.group.key === "project:none") return 1;
      if (b.group.key === "project:none") return -1;
      if (a.group.key === "system") return 1;
      if (b.group.key === "system") return -1;
      const aIsAgentFallback = a.group.key === "agent:unavailable" || a.group.key === "agent:unassigned";
      const bIsAgentFallback = b.group.key === "agent:unavailable" || b.group.key === "agent:unassigned";
      if (aIsAgentFallback && !bIsAgentFallback) return 1;
      if (bIsAgentFallback && !aIsAgentFallback) return -1;
      return (a.group.sortLabel ?? a.group.label).localeCompare(b.group.sortLabel ?? b.group.label);
    })
    .map(({ group, entries: sectionEntries }) => ({
      key: group.key,
      label: group.label,
      projectIcon: group.projectIcon,
      projectColor: group.projectColor,
      entries: [...sectionEntries].sort(compareThreadEntries),
    }));
}

export function organizeThreadEntries(
  entries: OrganizedThreadEntry[],
  rule: StandardThreadOrganizationRule,
  agentsById: Map<string, Agent>,
  projectsById: ReadonlyMap<string, Project>,
  kindLabel: (kind: MessengerThreadSummary["kind"]) => string,
): OrganizedThreadSection[] {
  const sorted = [...entries].sort(compareThreadEntries);
  if (rule === "project") {
    const pinnedEntries = sorted.filter(isPinnedEntry);
    const projectSections = groupEntries(sorted.filter((entry) => !isPinnedEntry(entry)), (entry) => {
      const splitIssueProject = splitIssueProjectGroup(entry.thread, projectsById);
      if (splitIssueProject) return splitIssueProject;
      if (entry.thread.kind !== "chat") return { key: "system", label: "System" };
      return chatProjectGroup(entry.conversation, projectsById);
    });
    return pinnedEntries.length > 0
      ? [{
        key: PROJECT_PINNED_SECTION_KEY,
        label: "Pinned",
        isPinned: true,
        entries: pinnedEntries,
      }, ...projectSections]
      : projectSections;
  }
  if (rule === "agent") return groupEntries(sorted, (entry) => entryAgentGroup(entry, agentsById));
  if (rule === "kind") {
    return groupEntries(sorted, (entry) => ({
      key: `kind:${entry.thread.kind}`,
      label: kindLabel(entry.thread.kind),
    }));
  }
  return groupEntries(sorted, (entry) => entry.thread.unreadCount > 0 || entry.thread.needsAttention
    ? { key: "attention:needs", label: "Needs attention" }
    : { key: "attention:other", label: "Other threads" });
}

export function sectionAttentionCount(section: OrganizedThreadSection): number {
  const directAttentionCount = section.entries.filter(
    (entry) => entry.thread.unreadCount > 0 || entry.thread.needsAttention,
  ).length;
  return directAttentionCount + (section.childSections ?? []).reduce(
    (count, childSection) => count + sectionAttentionCount(childSection),
    0,
  );
}

export function locallyReadThreadSummary(
  thread: MessengerThreadSummary,
  locallyReadThreadWatermarks: ReadonlyMap<string, string>,
): MessengerThreadSummary {
  const locallyReadWatermark = locallyReadThreadWatermarks.get(thread.threadKey);
  if (!locallyReadWatermark) return thread;
  if (locallyReadWatermark !== (thread.latestActivityAt ?? "none")) return thread;
  if (thread.unreadCount === 0 && !thread.needsAttention) return thread;
  return { ...thread, unreadCount: 0, needsAttention: false };
}
