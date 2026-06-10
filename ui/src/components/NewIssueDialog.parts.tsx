import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent, type DragEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pickTextColorForSolidBg } from "@/lib/color-contrast";
import { findIssueLabelExactMatch, normalizeIssueLabelName, pickIssueLabelColor } from "@/lib/issue-labels";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { organizationSkillsApi } from "../api/organizationSkills";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import {
  buildNewIssueCreateRequest,
  clearIssueAutosave,
  createIssueDraft,
  deleteIssueDraft,
  hasMeaningfulIssueDraft,
  readIssueAutosave,
  readNewIssuePreferences,
  readSavedIssueDraft,
  resolveDefaultNewIssueProjectId,
  resolveDraftBackedNewIssueValues,
  saveNewIssuePreferences,
  saveIssueAutosave,
  type IssueDraft,
  updateIssueDraft,
} from "../lib/new-issue-dialog";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import { buildMarkdownMentionOptions } from "../lib/markdown-mention-options";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { useToast } from "../context/ToastContext";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  parseAssigneeValue,
} from "../lib/assignees";
import { useLocation, useNavigate } from "@/lib/router";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  MoreHorizontal,
  ChevronRight,
  ChevronDown,
  CircleDot,
  Minus,
  CheckCircle2,
  Tag,
  Calendar,
  FileText,
  Loader2,
  Paperclip,
  X,
  Plus,
  ListTree,
} from "lucide-react";
import { cn } from "../lib/utils";
import { extractProviderIdWithFallback } from "../lib/model-utils";
import { CODEX_LOCAL_REASONING_EFFORT_OPTIONS, withDefaultThinkingEffortOption } from "../lib/runtime-thinking-effort";
import { resolveRuntimeModels } from "../lib/runtime-models";
import { issueStatusText, issueStatusTextDefault } from "../lib/status-colors";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { AgentMenuLabel } from "./AssigneeLabel";
import { IssueLabelChip } from "./IssueLabelChip";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { PriorityBarsIcon, PriorityPickerOption, priorityPickerContentClassName } from "./PriorityIcon";
import { priorityOptions } from "../lib/priorities";

export const DEBOUNCE_MS = 800;

export type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

export const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local"]);
export const STAGED_FILE_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";
export const ISSUE_METADATA_SELECTOR_CLASSNAME = "h-auto min-h-12 w-full py-2";

export type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

export function buildCreatedIssueDetailHref(input: {
  issue: { id: string; identifier: string | null };
  orgId: string;
  organizations: Array<{ id: string; issuePrefix?: string | null }>;
}): string {
  const issueRef = input.issue.identifier ?? input.issue.id;
  const organizationPrefix = input.organizations
    .find((organization) => organization.id === input.orgId)
    ?.issuePrefix
    ?.trim();
  return organizationPrefix ? `/${organizationPrefix}/issues/${issueRef}` : `/issues/${issueRef}`;
}

export function buildIssueDetailSourceHref(openContextLocation: { pathname: string; search: string } | null): string {
  if (!openContextLocation) return "/issues";
  return `${openContextLocation.pathname}${openContextLocation.search}`;
}

export const ISSUE_THINKING_EFFORT_OPTIONS = {
  claude_local: [
    { value: "", label: "Default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  codex_local: withDefaultThinkingEffortOption("Default", CODEX_LOCAL_REASONING_EFFORT_OPTIONS),
  opencode_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "max", label: "Max" },
  ],
} as const;

export function buildAssigneeAdapterOverrides(input: {
  agentRuntimeType: string | null | undefined;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
}): Record<string, unknown> | null {
  const agentRuntimeType = input.agentRuntimeType ?? null;
  if (!agentRuntimeType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(agentRuntimeType)) {
    return null;
  }

  const agentRuntimeConfig: Record<string, unknown> = {};
  if (input.modelOverride) agentRuntimeConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    if (agentRuntimeType === "codex_local") {
      agentRuntimeConfig.modelReasoningEffort = input.thinkingEffortOverride;
    } else if (agentRuntimeType === "opencode_local") {
      agentRuntimeConfig.variant = input.thinkingEffortOverride;
    } else if (agentRuntimeType === "claude_local") {
      agentRuntimeConfig.effort = input.thinkingEffortOverride;
    } else if (agentRuntimeType === "opencode_local") {
      agentRuntimeConfig.variant = input.thinkingEffortOverride;
    }
  }
  if (agentRuntimeType === "claude_local" && input.chrome) {
    agentRuntimeConfig.chrome = true;
  }

  const overrides: Record<string, unknown> = {};
  if (Object.keys(agentRuntimeConfig).length > 0) {
    overrides.agentRuntimeConfig = agentRuntimeConfig;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

export function isTextDocumentFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".txt") ||
    file.type === "text/markdown" ||
    file.type === "text/plain"
  );
}

export function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

export function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

export function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function createUniqueDocumentKey(baseKey: string, stagedFiles: StagedIssueFile[]) {
  const existingKeys = new Set(
    stagedFiles
      .filter((file) => file.kind === "document")
      .map((file) => file.documentKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (!existingKeys.has(baseKey)) return baseKey;
  let suffix = 2;
  while (existingKeys.has(`${baseKey}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseKey}-${suffix}`;
}

export function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

export const statuses = [
  { value: "backlog", label: "Backlog", color: issueStatusText.backlog ?? issueStatusTextDefault },
  { value: "todo", label: "Todo", color: issueStatusText.todo ?? issueStatusTextDefault },
  { value: "in_progress", label: "In Progress", color: issueStatusText.in_progress ?? issueStatusTextDefault },
  { value: "in_review", label: "In Review", color: issueStatusText.in_review ?? issueStatusTextDefault },
  { value: "done", label: "Done", color: issueStatusText.done ?? issueStatusTextDefault },
];

export const priorities = priorityOptions;

export function defaultProjectWorkspaceIdForProject(project: {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
  codebase?: { scope?: string | null } | null;
} | null | undefined) {
  if (!project) return "";
  if (project.codebase?.scope === "organization" || project.codebase?.scope === "none") {
    return project.executionWorkspacePolicy?.defaultProjectWorkspaceId ?? "";
  }
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? "";
}
