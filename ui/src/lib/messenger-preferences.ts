export type ThreadOrganizationRule = "latest" | "project" | "agent" | "kind" | "attention" | "custom";
export type MessengerThreadDensity = "comfortable" | "compact";

const THREAD_ORGANIZATION_STORAGE_KEY = "rudder.messengerThreadOrganizationByOrg";
const THREAD_DENSITY_STORAGE_KEY = "rudder.messengerThreadDensityByOrg";
const SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY = "rudder.messengerSplitIssueNotificationsByOrg";
const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = "rudder.messengerCollapsedProjectGroupsByOrg";
const COLLAPSED_THREAD_GROUPS_STORAGE_KEY = "rudder.messengerCollapsedThreadGroupsByOrg";
const MESSENGER_PROJECT_GROUP_ORDER_STORAGE_PREFIX = "rudder.messengerProjectGroupOrder";
const MESSENGER_THREAD_GROUP_ORDER_STORAGE_PREFIX = "rudder.messengerThreadGroupOrder";
// Legacy key retained so existing local tab layouts survive the Arc-style top-level layout.
const MESSENGER_DEFAULT_THREAD_ORDER_STORAGE_PREFIX = "rudder.messengerDefaultThreadOrder";
const HIDDEN_ISSUE_THREADS_STORAGE_PREFIX = "rudder.messengerHiddenIssueThreads";
const PROJECT_ORDER_STORAGE_PREFIX = "rudder.projectOrder";
const LEGACY_MESSENGER_USER_IDS = ["local-board", "anonymous"] as const;

export const DEFAULT_THREAD_ORGANIZATION_RULE: ThreadOrganizationRule = "latest";
export const DEFAULT_THREAD_DENSITY: MessengerThreadDensity = "compact";
export const DEFAULT_SPLIT_ISSUE_NOTIFICATIONS = true;

export function isLocalManagedThreadGroupRule(
  rule: ThreadOrganizationRule,
): rule is "project" | "agent" | "kind" {
  return rule === "project" || rule === "agent" || rule === "kind";
}

export function isLocallyCollapsedThreadGroupRule(
  rule: ThreadOrganizationRule,
): rule is "project" | "agent" | "kind" | "custom" {
  return isLocalManagedThreadGroupRule(rule) || rule === "custom";
}

export function isManagedThreadGroupRule(
  rule: ThreadOrganizationRule,
): rule is "project" | "agent" | "kind" | "custom" {
  return isLocalManagedThreadGroupRule(rule) || rule === "custom";
}

function readOrganizationPreference(orgId: string | null | undefined, storageKey: string): unknown {
  if (!orgId || typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return parsed[orgId];
  } catch {
    return undefined;
  }
}

function writeOrganizationPreference(orgId: string, storageKey: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, [orgId]: value }));
  } catch {
    // In-memory state remains authoritative when local storage is unavailable.
  }
}

export function readThreadOrganizationRule(orgId: string | null | undefined): ThreadOrganizationRule {
  const value = readOrganizationPreference(orgId, THREAD_ORGANIZATION_STORAGE_KEY);
  return value === "latest"
    || value === "project"
    || value === "agent"
    || value === "kind"
    || value === "attention"
    || value === "custom"
    ? value
    : DEFAULT_THREAD_ORGANIZATION_RULE;
}

export function writeThreadOrganizationRule(orgId: string, rule: ThreadOrganizationRule) {
  writeOrganizationPreference(orgId, THREAD_ORGANIZATION_STORAGE_KEY, rule);
}

export function readThreadDensity(orgId: string | null | undefined): MessengerThreadDensity {
  const value = readOrganizationPreference(orgId, THREAD_DENSITY_STORAGE_KEY);
  return value === "comfortable" || value === "compact" ? value : DEFAULT_THREAD_DENSITY;
}

export function writeThreadDensity(orgId: string, density: MessengerThreadDensity) {
  writeOrganizationPreference(orgId, THREAD_DENSITY_STORAGE_KEY, density);
}

export function readSplitIssueNotifications(orgId: string | null | undefined): boolean {
  const value = readOrganizationPreference(orgId, SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY);
  return typeof value === "boolean" ? value : DEFAULT_SPLIT_ISSUE_NOTIFICATIONS;
}

export function writeSplitIssueNotifications(orgId: string, enabled: boolean) {
  writeOrganizationPreference(orgId, SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY, enabled);
}

function readCollapsedProjectGroups(orgId: string | null | undefined): Set<string> {
  const value = readOrganizationPreference(orgId, COLLAPSED_PROJECT_GROUPS_STORAGE_KEY);
  return new Set(normalizeStringList(value));
}

function writeCollapsedProjectGroups(orgId: string, groups: Set<string>) {
  writeOrganizationPreference(orgId, COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, Array.from(groups));
}

export function readCollapsedThreadGroups(
  orgId: string | null | undefined,
  rule: ThreadOrganizationRule,
): Set<string> {
  if (!isLocallyCollapsedThreadGroupRule(rule)) return new Set();
  if (rule === "project") return readCollapsedProjectGroups(orgId);
  const value = readOrganizationPreference(orgId, COLLAPSED_THREAD_GROUPS_STORAGE_KEY);
  const groups = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[rule]
    : undefined;
  return new Set(normalizeStringList(groups));
}

export function writeCollapsedThreadGroups(
  orgId: string,
  rule: ThreadOrganizationRule,
  groups: Set<string>,
) {
  if (!isLocallyCollapsedThreadGroupRule(rule)) return;
  if (rule === "project") {
    writeCollapsedProjectGroups(orgId, groups);
    return;
  }
  const value = readOrganizationPreference(orgId, COLLAPSED_THREAD_GROUPS_STORAGE_KEY);
  const organizationGroups = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  writeOrganizationPreference(orgId, COLLAPSED_THREAD_GROUPS_STORAGE_KEY, {
    ...organizationGroups,
    [rule]: Array.from(groups),
  });
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function messengerUserStorageId(userId: string | null | undefined) {
  const trimmed = userId?.trim();
  return trimmed || "anonymous";
}

function isValidStringListJson(raw: string) {
  try {
    return Array.isArray(JSON.parse(raw))
      && (JSON.parse(raw) as unknown[]).every((item) => typeof item === "string");
  } catch {
    return false;
  }
}

function isValidWatermarkJson(raw: string) {
  try {
    const value = JSON.parse(raw) as unknown;
    return Boolean(value)
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
  } catch {
    return false;
  }
}

/**
 * Account sign-in changes the local preference namespace from the trusted
 * `local-board`/anonymous identity to the account UUID. Copying only when the
 * destination is absent preserves account-era edits and keeps the legacy keys
 * available to an older app after an automatic rollback.
 */
export function copyLegacyMessengerLocalPreferences(
  orgId: string,
  targetUserId: string | null | undefined,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
) {
  const targetId = messengerUserStorageId(targetUserId);
  if (targetId === "anonymous" || targetId === "local-board") return [];

  const copied: string[] = [];
  const specs = [
    { prefix: PROJECT_ORDER_STORAGE_PREFIX, suffix: `${orgId}`, valid: isValidStringListJson },
    { prefix: MESSENGER_PROJECT_GROUP_ORDER_STORAGE_PREFIX, suffix: `${orgId}`, valid: isValidStringListJson },
    { prefix: MESSENGER_THREAD_GROUP_ORDER_STORAGE_PREFIX, suffix: `agent:${orgId}`, valid: isValidStringListJson },
    { prefix: MESSENGER_THREAD_GROUP_ORDER_STORAGE_PREFIX, suffix: `kind:${orgId}`, valid: isValidStringListJson },
    { prefix: MESSENGER_DEFAULT_THREAD_ORDER_STORAGE_PREFIX, suffix: `${orgId}`, valid: isValidStringListJson },
    { prefix: HIDDEN_ISSUE_THREADS_STORAGE_PREFIX, suffix: `${orgId}`, valid: isValidWatermarkJson },
  ];
  for (const spec of specs) {
    const targetKey = `${spec.prefix}:${spec.suffix}:${targetId}`;
    if (storage.getItem(targetKey) !== null) continue;
    for (const legacyId of LEGACY_MESSENGER_USER_IDS) {
      const source = storage.getItem(`${spec.prefix}:${spec.suffix}:${legacyId}`);
      if (source === null || !spec.valid(source)) continue;
      try {
        storage.setItem(targetKey, source);
        copied.push(targetKey);
      } catch {
        // The server-side state recovery remains usable when storage is restricted.
      }
      break;
    }
  }
  return copied;
}

export function getMessengerProjectGroupOrderStorageKey(
  orgId: string,
  userId: string | null | undefined,
) {
  return `${MESSENGER_PROJECT_GROUP_ORDER_STORAGE_PREFIX}:${orgId}:${messengerUserStorageId(userId)}`;
}

export function getMessengerThreadGroupOrderStorageKey(
  orgId: string,
  userId: string | null | undefined,
  rule: ThreadOrganizationRule,
) {
  if (rule === "project") return getMessengerProjectGroupOrderStorageKey(orgId, userId);
  return `${MESSENGER_THREAD_GROUP_ORDER_STORAGE_PREFIX}:${rule}:${orgId}:${messengerUserStorageId(userId)}`;
}

export function getMessengerDefaultThreadOrderStorageKey(
  orgId: string,
  userId: string | null | undefined,
) {
  return `${MESSENGER_DEFAULT_THREAD_ORDER_STORAGE_PREFIX}:${orgId}:${messengerUserStorageId(userId)}`;
}

export function getHiddenIssueThreadsStorageKey(
  orgId: string,
  userId: string | null | undefined,
) {
  return `${HIDDEN_ISSUE_THREADS_STORAGE_PREFIX}:${orgId}:${messengerUserStorageId(userId)}`;
}

export function readStringList(storageKey: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? normalizeStringList(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeStringList(storageKey: string, values: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(normalizeStringList(values)));
  } catch {
    // In-memory order remains authoritative when local storage is unavailable.
  }
}

export function readHiddenIssueThreadWatermarks(storageKey: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        entry[0].length > 0 && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function writeHiddenIssueThreadWatermarks(
  storageKey: string,
  watermarks: Record<string, string>,
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(watermarks));
  } catch {
    // In-memory hidden state remains authoritative when local storage is unavailable.
  }
}
