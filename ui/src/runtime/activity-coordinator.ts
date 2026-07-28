import type { LiveEvent } from "@rudderhq/shared";

export type ActivityKind = "chat" | "issue" | "run" | "approval" | "system";
export type ActivityKey = `${ActivityKind}:${string}`;

export interface ActivitySummarySnapshot {
  key: ActivityKey;
  status: string | null;
  unreadCount: number | null;
  needsAttention: boolean | null;
  latestActivityAt: string | null;
  previewRevision: number;
}

export interface ActivityDetailLease {
  key: ActivityKey;
  release(): void;
}

type SummaryListener = () => void;
type LiveEventListener = (event: LiveEvent) => void;

const EMPTY_SUMMARIES = new Map<ActivityKey, ActivitySummarySnapshot>();

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function activityKeysForEvent(event: LiveEvent): ActivityKey[] {
  const payload = event.payload ?? {};
  const keys: ActivityKey[] = [];
  const runId = readString(payload.runId);
  const issueId = readString(payload.issueId);
  const conversationId = readString(payload.conversationId) ?? readString(payload.chatId);
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);

  if (runId) keys.push(`run:${runId}`);
  if (issueId) keys.push(`issue:${issueId}`);
  if (conversationId) keys.push(`chat:${conversationId}`);
  if (entityType === "run" && entityId) keys.push(`run:${entityId}`);
  if (entityType === "issue" && entityId) keys.push(`issue:${entityId}`);
  if (entityType === "chat" && entityId) keys.push(`chat:${entityId}`);
  if (entityType === "approval" && entityId) keys.push(`approval:${entityId}`);

  return Array.from(new Set(keys));
}

function statusForEvent(event: LiveEvent, key: ActivityKey): string | null {
  const payload = event.payload ?? {};
  if (event.type === "heartbeat.run.queued" && key.startsWith("run:")) return "queued";
  if (event.type === "heartbeat.run.status" && key.startsWith("run:")) {
    return readString(payload.status) ?? "updated";
  }
  if (event.type === "agent.status") return readString(payload.status);
  if (event.type === "activity.logged") {
    const entityType = readString(payload.entityType);
    const entityId = readString(payload.entityId);
    if (entityType && entityId && key !== `${entityType}:${entityId}`) return null;
    const details = payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
      ? payload.details as Record<string, unknown>
      : null;
    return readString(payload.status) ?? readString(details?.status);
  }
  return null;
}

export class ActivityCoordinator {
  readonly orgId: string | null;

  private readonly summaries = new Map<ActivityKey, ActivitySummarySnapshot>();
  private readonly summaryListeners = new Map<ActivityKey, Set<SummaryListener>>();
  private readonly liveEventListeners = new Set<LiveEventListener>();
  private readonly detailLeaseCounts = new Map<ActivityKey, number>();
  private eventCount = 0;
  private summaryNotificationCount = 0;

  constructor(orgId: string | null) {
    this.orgId = orgId;
  }

  getSummary = (key: ActivityKey): ActivitySummarySnapshot | null => (
    this.summaries.get(key) ?? null
  );

  getSummaries = (): ReadonlyMap<ActivityKey, ActivitySummarySnapshot> => (
    this.summaries.size === 0 ? EMPTY_SUMMARIES : this.summaries
  );

  subscribeSummary = (key: ActivityKey, listener: SummaryListener): (() => void) => {
    const listeners = this.summaryListeners.get(key) ?? new Set<SummaryListener>();
    listeners.add(listener);
    this.summaryListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.summaryListeners.delete(key);
    };
  };

  subscribeLiveEvents = (listener: LiveEventListener): (() => void) => {
    this.liveEventListeners.add(listener);
    return () => this.liveEventListeners.delete(listener);
  };

  acquireDetail = (key: ActivityKey): ActivityDetailLease => {
    this.detailLeaseCounts.set(key, (this.detailLeaseCounts.get(key) ?? 0) + 1);
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        const nextCount = (this.detailLeaseCounts.get(key) ?? 1) - 1;
        if (nextCount <= 0) this.detailLeaseCounts.delete(key);
        else this.detailLeaseCounts.set(key, nextCount);
      },
    };
  };

  hasDetailLease = (key: ActivityKey): boolean => (
    (this.detailLeaseCounts.get(key) ?? 0) > 0
  );

  updateSummary = (
    key: ActivityKey,
    patch: Partial<Omit<ActivitySummarySnapshot, "key">>,
  ): void => {
    const current = this.summaries.get(key);
    const next: ActivitySummarySnapshot = {
      key,
      status: patch.status !== undefined ? patch.status : current?.status ?? null,
      unreadCount: patch.unreadCount !== undefined
        ? patch.unreadCount
        : current?.unreadCount ?? null,
      needsAttention: patch.needsAttention !== undefined
        ? patch.needsAttention
        : current?.needsAttention ?? null,
      latestActivityAt: patch.latestActivityAt !== undefined
        ? patch.latestActivityAt
        : current?.latestActivityAt ?? null,
      previewRevision: patch.previewRevision !== undefined
        ? patch.previewRevision
        : current?.previewRevision ?? 0,
    };
    if (
      current
      && current.status === next.status
      && current.unreadCount === next.unreadCount
      && current.needsAttention === next.needsAttention
      && current.latestActivityAt === next.latestActivityAt
      && current.previewRevision === next.previewRevision
    ) {
      return;
    }
    this.summaries.set(key, next);
    const listeners = this.summaryListeners.get(key);
    if (!listeners) return;
    this.summaryNotificationCount += listeners.size;
    for (const listener of listeners) listener();
  };

  publishLiveEvent = (event: LiveEvent): void => {
    if (this.orgId && event.orgId !== this.orgId) return;
    this.eventCount += 1;

    for (const key of activityKeysForEvent(event)) {
      const current = this.summaries.get(key);
      const payload = event.payload ?? {};
      const status = statusForEvent(event, key);
      const unreadCount = readNumber(payload.unreadCount) ?? current?.unreadCount ?? null;
      const needsAttention = typeof payload.needsAttention === "boolean"
        ? payload.needsAttention
        : current?.needsAttention ?? null;
      const next: ActivitySummarySnapshot = {
        key,
        status: status ?? current?.status ?? null,
        unreadCount,
        needsAttention,
        latestActivityAt: event.createdAt,
        previewRevision: (current?.previewRevision ?? 0) + (
          event.type === "heartbeat.run.log" || event.type === "heartbeat.run.event" ? 0 : 1
        ),
      };
      this.updateSummary(key, next);
    }

    for (const listener of this.liveEventListeners) listener(event);
  };

  getDebugSnapshot() {
    return {
      orgId: this.orgId,
      eventCount: this.eventCount,
      summaryCount: this.summaries.size,
      summarySubscriberCount: Array.from(this.summaryListeners.values())
        .reduce((total, listeners) => total + listeners.size, 0),
      summaryNotificationCount: this.summaryNotificationCount,
      liveEventSubscriberCount: this.liveEventListeners.size,
      detailLeaseCounts: Object.fromEntries(this.detailLeaseCounts),
    };
  }
}

export const fallbackActivityCoordinator = new ActivityCoordinator(null);
