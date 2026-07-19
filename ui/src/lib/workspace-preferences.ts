import type {
  DesktopFileLaunchTargetId,
  DesktopIdeTarget,
  DesktopWorkspaceLaunchTarget,
} from "./desktop-shell";
import { normalizeRequestedPath } from "./workspace-path-policy";

const WORKSPACE_LAUNCH_TARGET_STORAGE_KEY = "rudder.workspace.launchTargetId";
const WORKSPACE_UNSUPPORTED_FILE_LAUNCH_TARGET_STORAGE_KEY = "rudder.workspace.unsupportedFileLaunchTargetId";
const WORKSPACE_OPEN_FILE_TABS_STORAGE_PREFIX = "rudder.workspace.openFileTabs";
const WORKSPACE_OPEN_FILE_TABS_LIMIT = 24;
const WORKSPACE_LAUNCH_TARGET_IDS = [
  "cursor",
  "vscode",
  "windsurf",
  "zed",
  "webstorm",
  "intellij",
  "xcode",
  "terminal",
  "warp",
  "commandPrompt",
  "powershell",
  "finder",
] as const satisfies readonly DesktopWorkspaceLaunchTarget["id"][];

export type WorkspaceFileOpenTarget = {
  fileTarget: true;
  id: DesktopFileLaunchTargetId;
  label: string;
  kind: "app" | "ide";
  workspaceTarget?: DesktopWorkspaceLaunchTarget;
};

export type WorkspaceOpenTargetId = DesktopWorkspaceLaunchTarget["id"] | WorkspaceFileOpenTarget["id"];
export type WorkspaceUnsupportedFileLaunchTarget = WorkspaceFileOpenTarget | DesktopWorkspaceLaunchTarget;

const DEFAULT_FILE_OPEN_TARGET: WorkspaceFileOpenTarget = {
  fileTarget: true,
  id: "defaultApp",
  label: "Default app",
  kind: "app",
};

export function isWorkspaceLaunchTargetId(value: string | null): value is DesktopWorkspaceLaunchTarget["id"] {
  return WORKSPACE_LAUNCH_TARGET_IDS.includes(value as DesktopWorkspaceLaunchTarget["id"]);
}

export function isWorkspaceIdeLaunchTarget(
  target: DesktopWorkspaceLaunchTarget,
): target is DesktopWorkspaceLaunchTarget & { id: DesktopIdeTarget["id"]; kind: "ide" } {
  return target.kind === "ide" && target.id !== "xcode";
}

export function isWorkspaceFileOpenTarget(
  target: DesktopWorkspaceLaunchTarget | WorkspaceFileOpenTarget,
): target is WorkspaceFileOpenTarget {
  return "fileTarget" in target;
}

export function workspaceFileOpenTargets(targets: DesktopWorkspaceLaunchTarget[]): WorkspaceFileOpenTarget[] {
  return [
    DEFAULT_FILE_OPEN_TARGET,
    ...targets.filter(isWorkspaceIdeLaunchTarget).map((target) => ({
      fileTarget: true as const,
      id: target.id,
      label: target.label,
      kind: "ide" as const,
      workspaceTarget: target,
    })),
  ];
}

export function workspaceUnsupportedFileLaunchTargets(
  targets: DesktopWorkspaceLaunchTarget[],
  capabilities: { canOpenFile: boolean; canOpenLocation: boolean },
): WorkspaceUnsupportedFileLaunchTarget[] {
  if (!capabilities.canOpenFile) return [];
  const fileTargets = workspaceFileOpenTargets(targets);
  if (!capabilities.canOpenLocation) return fileTargets;
  return [
    ...fileTargets,
    ...targets.filter((target) => target.kind === "folder" || target.kind === "terminal"),
  ];
}

export function resolveWorkspaceUnsupportedFileLaunchTarget(
  targets: WorkspaceUnsupportedFileLaunchTarget[],
  storedId: string | null,
) {
  return targets.find((target) => target.id === storedId)
    ?? targets.find((target) => target.id === "defaultApp")
    ?? null;
}

export function readStoredWorkspaceUnsupportedFileLaunchTargetId(): WorkspaceOpenTargetId | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(WORKSPACE_UNSUPPORTED_FILE_LAUNCH_TARGET_STORAGE_KEY);
  if (value === "defaultApp") return value;
  return isWorkspaceLaunchTargetId(value) ? value : null;
}

export function writeStoredWorkspaceUnsupportedFileLaunchTargetId(targetId: WorkspaceOpenTargetId) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_UNSUPPORTED_FILE_LAUNCH_TARGET_STORAGE_KEY, targetId);
}

export function readStoredWorkspaceLaunchTargetId() {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(WORKSPACE_LAUNCH_TARGET_STORAGE_KEY);
  return isWorkspaceLaunchTargetId(value) ? value : null;
}

export function writeStoredWorkspaceLaunchTargetId(targetId: DesktopWorkspaceLaunchTarget["id"]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_LAUNCH_TARGET_STORAGE_KEY, targetId);
}

export function workspaceLaunchMenuOpeningId(targetId: WorkspaceOpenTargetId | null) {
  return targetId && isWorkspaceLaunchTargetId(targetId) ? targetId : null;
}

export function isWorkspaceCloseCurrentTabShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented) return false;
  if (event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return event.key.toLowerCase() === "w";
}

export function normalizeWorkspaceOpenFilePaths(paths: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    const filePath = normalizeRequestedPath(path ?? null);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    normalized.push(filePath);
  }
  return normalized.slice(-WORKSPACE_OPEN_FILE_TABS_LIMIT);
}

function workspaceOpenFileTabsStorageKey(orgId: string) {
  return `${WORKSPACE_OPEN_FILE_TABS_STORAGE_PREFIX}:${orgId}`;
}

export function normalizeWorkspaceOpenFileTabState(
  openFilePaths: Array<string | null | undefined>,
  selectedFilePath: string | null | undefined,
) {
  const normalizedOpenFilePaths = normalizeWorkspaceOpenFilePaths([...openFilePaths, selectedFilePath]);
  const normalizedSelectedFilePath = normalizeRequestedPath(selectedFilePath ?? null);
  return {
    openFilePaths: normalizedOpenFilePaths,
    selectedFilePath: normalizedSelectedFilePath && normalizedOpenFilePaths.includes(normalizedSelectedFilePath)
      ? normalizedSelectedFilePath
      : normalizedOpenFilePaths[0] ?? null,
  };
}

export function readStoredWorkspaceOpenFileTabState(orgId: string | null | undefined) {
  if (!orgId || typeof window === "undefined") {
    return normalizeWorkspaceOpenFileTabState([], null);
  }
  try {
    const raw = window.sessionStorage?.getItem(workspaceOpenFileTabsStorageKey(orgId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      return normalizeWorkspaceOpenFileTabState(parsed, parsed[0]);
    }
    if (parsed && typeof parsed === "object") {
      const stored = parsed as { openFilePaths?: unknown; selectedFilePath?: unknown };
      return normalizeWorkspaceOpenFileTabState(
        Array.isArray(stored.openFilePaths) ? stored.openFilePaths as Array<string | null | undefined> : [],
        typeof stored.selectedFilePath === "string" ? stored.selectedFilePath : null,
      );
    }
  } catch {
    return normalizeWorkspaceOpenFileTabState([], null);
  }
  return normalizeWorkspaceOpenFileTabState([], null);
}

export function writeStoredWorkspaceOpenFileTabState(
  orgId: string | null | undefined,
  filePaths: string[],
  selectedFilePath: string | null,
) {
  if (!orgId || typeof window === "undefined") return;
  try {
    const state = normalizeWorkspaceOpenFileTabState(filePaths, selectedFilePath);
    window.sessionStorage?.setItem(
      workspaceOpenFileTabsStorageKey(orgId),
      JSON.stringify(state),
    );
  } catch {
    // Session restoration is a convenience; tab state still works in memory.
  }
}

export function appendWorkspaceOpenFilePath(current: string[], filePath: string) {
  return current.includes(filePath)
    ? current
    : normalizeWorkspaceOpenFilePaths([...current, filePath]);
}
