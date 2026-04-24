import type { OrganizationWorkspace, ProjectWorkspaceSourceType } from "@rudderhq/shared";
import { parseObject } from "../agent-runtimes/utils.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseOrganizationWorkspaceConfig(raw: unknown): OrganizationWorkspace | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;

  const cwd = readNonEmptyString(parsed.cwd);
  const repoUrl = readNonEmptyString(parsed.repoUrl);
  const repoRef = readNonEmptyString(parsed.repoRef);
  const defaultRef = readNonEmptyString(parsed.defaultRef) ?? repoRef;
  const sourceType = (() => {
    const explicit = readNonEmptyString(parsed.sourceType);
    if (
      explicit === "local_path" ||
      explicit === "git_repo" ||
      explicit === "remote_managed" ||
      explicit === "non_git_path"
    ) {
      return explicit as ProjectWorkspaceSourceType;
    }
    if (repoUrl) return "git_repo";
    if (cwd) return "local_path";
    return null;
  })();

  if (!sourceType) return null;
  if (!cwd && !repoUrl) return null;

  return {
    sourceType,
    cwd,
    repoUrl,
    repoRef,
    defaultRef,
  };
}

export function serializeOrganizationWorkspaceConfig(
  workspace: OrganizationWorkspace | null | undefined,
): Record<string, unknown> | null {
  if (!workspace) return null;
  const cwd = readNonEmptyString(workspace.cwd);
  const repoUrl = readNonEmptyString(workspace.repoUrl);
  const repoRef = readNonEmptyString(workspace.repoRef);
  const defaultRef = readNonEmptyString(workspace.defaultRef) ?? repoRef;
  const sourceType = workspace.sourceType ?? (repoUrl ? "git_repo" : cwd ? "local_path" : null);
  if (!sourceType || (!cwd && !repoUrl)) return null;
  return {
    sourceType,
    ...(cwd ? { cwd } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
    ...(defaultRef ? { defaultRef } : {}),
  };
}

export function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const raw = readNonEmptyString(repoUrl);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}
