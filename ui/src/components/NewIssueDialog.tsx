import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useI18n } from "@/context/I18nContext";
import { pickTextColorForSolidBg } from "@/lib/color-contrast";
import { findIssueLabelExactMatch, normalizeIssueLabelName, pickIssueLabelColor } from "@/lib/issue-labels";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { useLocation, useNavigate } from "@/lib/router";
import type { IssueAssigneeAgentRuntimeOverrides } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileText,
  ListTree,
  Loader2,
  Minus,
  MoreHorizontal,
  Paperclip,
  Plus,
  Tag,
  Target,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { agentsApi, type AgentRuntimeModel } from "../api/agents";
import { assetsApi } from "../api/assets";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { organizationSkillsApi } from "../api/organizationSkills";
import { organizationsApi } from "../api/orgs";
import { projectsApi } from "../api/projects";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useCurrentUserAvatar } from "../hooks/useCurrentUserAvatar";
import { useExperimentalGoalsEnabled } from "../hooks/useExperimentalGoalsEnabled";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  parseAssigneeValue,
} from "../lib/assignees";
import { buildMarkdownMentionOptions } from "../lib/markdown-mention-options";
import {
  buildNewIssueCreateRequest,
  clearIssueAutosave,
  createIssueDraft,
  deleteIssueDraft,
  hasMeaningfulIssueDraft,
  readIssueAutosave,
  readNewIssuePreferences,
  readSavedIssueDraft,
  resolveCreatedIssueNavigation,
  resolveDefaultNewIssueProjectId,
  resolveDraftBackedNewIssueValues,
  saveIssueAutosave,
  saveNewIssuePreferences,
  updateIssueDraft,
  type IssueDraft,
} from "../lib/new-issue-dialog";
import { usePluginMentionCatalog } from "../lib/plugin-mentions";
import { priorityOptions } from "../lib/priorities";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { resolveRuntimeModels } from "../lib/runtime-models";
import {
  claudeLocalThinkingEffortOptionsForModel,
  codexLocalReasoningEffortOptionsForModel,
  cursorLocalThinkingEffortOptionsForModel,
  openCodeLocalVariantOptionsForModel,
  piLocalThinkingEffortOptionsForModel,
  withDefaultThinkingEffortOption,
} from "../lib/runtime-thinking-effort";
import { issueStatusText, issueStatusTextDefault } from "../lib/status-colors";
import { cn } from "../lib/utils";
import { AgentMenuLabel, AssigneeLabel } from "./AssigneeLabel";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { IssueLabelChip } from "./IssueLabelChip";
import { IssueRuntimeSelector } from "./IssueRuntimeSelector";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { PriorityBarsIcon, PriorityPickerOption, priorityPickerContentClassName } from "./PriorityIcon";
import { ProjectIcon } from "./ProjectIdentity";

const DEBOUNCE_MS = 800;

type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local", "pi_local", "cursor"]);
const STAGED_FILE_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";
const ISSUE_METADATA_SELECTOR_CLASSNAME = "h-auto min-h-12 w-full py-2";
type IssueCreationMode = "manual" | "agent";

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

function buildAssigneeAdapterOverrides(input: {
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
    } else if (agentRuntimeType === "pi_local") {
      agentRuntimeConfig.thinking = input.thinkingEffortOverride;
    } else if (agentRuntimeType === "cursor") {
      agentRuntimeConfig.effort = input.thinkingEffortOverride;
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

function runtimeEffortKeyForAssignee(runtimeType: string | null): string | null {
  if (runtimeType === "codex_local") return "modelReasoningEffort";
  if (runtimeType === "opencode_local") return "variant";
  if (runtimeType === "claude_local") return "effort";
  if (runtimeType === "pi_local") return "thinking";
  if (runtimeType === "cursor") return "effort";
  return null;
}

function readAssigneeRuntimeOverrides(
  overrides: IssueAssigneeAgentRuntimeOverrides | null,
  runtimeType: string | null,
) {
  const config = overrides?.agentRuntimeConfig ?? {};
  const effortKey = runtimeEffortKeyForAssignee(runtimeType);
  const model = typeof config.model === "string" ? config.model : "";
  const effortValue = effortKey ? config[effortKey] : undefined;
  const legacyEffortValue = effortKey === "modelReasoningEffort" ? config.reasoningEffort : undefined;
  const thinkingEffort = typeof (effortValue ?? legacyEffortValue) === "string"
    ? String(effortValue ?? legacyEffortValue)
    : "";
  return {
    modelOverride: model,
    thinkingEffortOverride: thinkingEffort,
    chrome: runtimeType === "claude_local" && config.chrome === true,
  };
}

function thinkingOptionsForAssignee(
  runtimeType: string | null,
  model: string,
  metadata: AgentRuntimeModel | undefined,
) {
  if (runtimeType === "codex_local") {
    return withDefaultThinkingEffortOption(
      "Default",
      codexLocalReasoningEffortOptionsForModel(model, metadata),
    );
  }
  if (runtimeType === "claude_local") return claudeLocalThinkingEffortOptionsForModel(model, metadata);
  if (runtimeType === "opencode_local") return openCodeLocalVariantOptionsForModel(model, metadata);
  if (runtimeType === "pi_local") return piLocalThinkingEffortOptionsForModel(model, metadata);
  if (runtimeType === "cursor") return cursorLocalThinkingEffortOptionsForModel(model, metadata);
  return [];
}

function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

const statuses = [
  { value: "backlog", label: "Backlog", color: issueStatusText.backlog ?? issueStatusTextDefault },
  { value: "todo", label: "Todo", color: issueStatusText.todo ?? issueStatusTextDefault },
  { value: "in_progress", label: "In Progress", color: issueStatusText.in_progress ?? issueStatusTextDefault },
  { value: "in_review", label: "In Review", color: issueStatusText.in_review ?? issueStatusTextDefault },
  { value: "done", label: "Done", color: issueStatusText.done ?? issueStatusTextDefault },
];

const priorities = priorityOptions;

function defaultProjectWorkspaceIdForProject(project: {
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

function createAgentIssueIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `agent-issue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function shouldRotateAgentIssueIdempotencyKey(error: unknown) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

export function NewIssueDialog() {
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const { organizations, selectedOrganizationId, selectedOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creationMode, setCreationMode] = useState<IssueCreationMode>("manual");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [labelSearch, setLabelSearch] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [reviewerValue, setReviewerValue] = useState("");
  const [projectId, setProjectId] = useState("");
  const [goalId, setGoalId] = useState("");
  const [projectWorkspaceId, setProjectWorkspaceId] = useState("");
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedIssueFile[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [activeSavedIssueDraftId, setActiveSavedIssueDraftId] = useState<string | null>(null);
  const [documentSessionId, setDocumentSessionId] = useState(0);
  const [redirectingIssueRef, setRedirectingIssueRef] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftSaveRef = useRef<{ draft: IssueDraft; savedDraftId: string | null } | null>(null);
  const agentIssueIdempotencyKeyRef = useRef<string | null>(null);
  const agentIssueSubmissionInFlightRef = useRef(false);
  const openContextLocationRef = useRef<{ pathname: string; search: string } | null>(null);
  const previousAssigneeAgentIdRef = useRef<string | null>(null);
  const effectiveCompanyId = dialogCompanyId ?? selectedOrganizationId;
  const dialogCompany = organizations.find((c) => c.id === effectiveCompanyId) ?? selectedOrganization;
  const requestedSavedIssueDraftId = newIssueDefaults.draftId ?? null;

  // Popover states
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const stageFileInputRef = useRef<HTMLInputElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const { enabled: goalsEnabled } = useExperimentalGoalsEnabled();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(effectiveCompanyId!),
    queryFn: () => agentsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(effectiveCompanyId!),
    queryFn: () => projectsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(effectiveCompanyId!),
    queryFn: () => goalsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen && goalsEnabled,
  });
  useEffect(() => {
    if (!goalsEnabled) setGoalId("");
  }, [goalsEnabled]);
  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(effectiveCompanyId!),
    queryFn: () => issuesApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(effectiveCompanyId!),
    queryFn: () => issuesApi.listLabels(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const currentUserAvatarUrl = useCurrentUserAvatar();
  const activeProjects = useMemo(
    () => (projects ?? []).filter((p) => !p.archivedAt),
    [projects],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    orgId: effectiveCompanyId,
    userId: currentUserId,
  });
  const selectedAssignee = useMemo(() => parseAssigneeValue(assigneeValue), [assigneeValue]);
  const selectedAssigneeAgentId = selectedAssignee.assigneeAgentId;
  const selectedAssigneeUserId = selectedAssignee.assigneeUserId;
  const selectedReviewer = useMemo(() => parseAssigneeValue(reviewerValue), [reviewerValue]);
  const selectedReviewerAgentId = selectedReviewer.assigneeAgentId;
  const selectedReviewerUserId = selectedReviewer.assigneeUserId;
  const currentAssignee = selectedAssigneeAgentId
    ? (agents ?? []).find((agent) => agent.id === selectedAssigneeAgentId) ?? null
    : null;
  const currentReviewer = selectedReviewerAgentId
    ? (agents ?? []).find((agent) => agent.id === selectedReviewerAgentId) ?? null
    : null;

  const assigneeAdapterType = currentAssignee?.agentRuntimeType ?? null;
  const configuredAssigneeModel = typeof currentAssignee?.agentRuntimeConfig?.model === "string"
    ? currentAssignee.agentRuntimeConfig.model
    : "";
  const effectiveAssigneeModel = assigneeModelOverride || configuredAssigneeModel;
  const supportsAssigneeOverrides = Boolean(
    assigneeAdapterType && ISSUE_OVERRIDE_ADAPTER_TYPES.has(assigneeAdapterType),
  );

  const { data: assigneeAgentRuntimeModels } = useQuery({
    queryKey:
      effectiveCompanyId && assigneeAdapterType
        ? queryKeys.agents.adapterModels(effectiveCompanyId, assigneeAdapterType)
        : ["agents", "none", "adapter-models", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModels(effectiveCompanyId!, assigneeAdapterType!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && supportsAssigneeOverrides,
    retry: false,
  });
  const assigneeModelMetadata = assigneeAgentRuntimeModels?.find(
    (candidate) => candidate.id === effectiveAssigneeModel,
  );

  const { data: assigneeOrganizationSkills } = useQuery({
    queryKey: queryKeys.organizationSkills.list(effectiveCompanyId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(effectiveCompanyId!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && Boolean(selectedAssigneeAgentId),
  });

  const { data: assigneeSkillSnapshot } = useQuery({
    queryKey: queryKeys.agents.skills(selectedAssigneeAgentId ?? "__none__"),
    queryFn: () => agentsApi.skills(selectedAssigneeAgentId!, effectiveCompanyId!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && Boolean(selectedAssigneeAgentId),
  });
  const pluginMentions = usePluginMentionCatalog(effectiveCompanyId);

  const { data: libraryDocuments } = useQuery({
    queryKey: queryKeys.organizations.libraryDocuments(effectiveCompanyId ?? "__none__"),
    queryFn: () => organizationsApi.listLibraryDocuments(effectiveCompanyId!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen,
  });

  const [libraryFileMentionQuery, setLibraryFileMentionQuery] = useState<string | null>(null);
  const normalizedLibraryFileMentionQuery = libraryFileMentionQuery?.trim() ?? "";
  const { data: libraryMentionFiles } = useQuery({
    queryKey: [
      "organizations",
      effectiveCompanyId ?? "__none__",
      "workspace-mention-files",
      normalizedLibraryFileMentionQuery,
    ] as const,
    queryFn: () => organizationsApi.listWorkspaceMentionFiles(effectiveCompanyId!, {
      query: normalizedLibraryFileMentionQuery,
      limit: normalizedLibraryFileMentionQuery ? 50 : 200,
    }),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen,
  });

  useEffect(() => {
    if (!newIssueOpen) {
      openContextLocationRef.current = null;
      return;
    }
    if (!openContextLocationRef.current) {
      openContextLocationRef.current = {
        pathname: location.pathname,
        search: location.search,
      };
    }
  }, [location.pathname, location.search, newIssueOpen]);

  useEffect(() => {
    if (!newIssueOpen) return;
    setCreationMode("manual");
    agentIssueIdempotencyKeyRef.current = createAgentIssueIdempotencyKey();
  }, [newIssueOpen]);

  const skillMentionOptions = useMemo(
    () => buildAgentSkillMentionOptions({
      agent: currentAssignee,
      orgUrlKey: dialogCompany?.urlKey ?? selectedOrganization?.urlKey ?? "organization",
      organizationSkills: assigneeOrganizationSkills,
      skillSnapshot: assigneeSkillSnapshot,
    }),
    [
      assigneeOrganizationSkills,
      assigneeSkillSnapshot,
      currentAssignee,
      dialogCompany?.urlKey,
      selectedOrganization?.urlKey,
    ],
  );

  const mentionOptions = useMemo<MentionOption[]>(
    () => buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      issues: allIssues,
      libraryDocuments,
      libraryFiles: libraryMentionFiles?.entries,
      skillMentionOptions,
      pluginMentionOptions: pluginMentions.options,
      currentUserId,
    }),
    [
      agents,
      allIssues,
      currentUserId,
      libraryDocuments,
      libraryMentionFiles?.entries,
      orderedProjects,
      pluginMentions.options,
      skillMentionOptions,
    ],
  );

  const clearPendingDraftSave = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    pendingDraftSaveRef.current = null;
  }, []);

  const flushPendingDraftSave = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const pendingSave = pendingDraftSaveRef.current;
    pendingDraftSaveRef.current = null;
    if (!pendingSave) return;

    if (pendingSave.savedDraftId) {
      updateIssueDraft(pendingSave.savedDraftId, pendingSave.draft);
      return;
    }
    saveIssueAutosave(pendingSave.draft);
  }, []);

  const createIssue = useMutation({
    mutationFn: async ({
      orgId,
      stagedFiles: pendingStagedFiles,
      ...data
    }: { orgId: string; stagedFiles: StagedIssueFile[] } & Record<string, unknown>) => {
      const issue = await issuesApi.create(orgId, data);
      const failures: string[] = [];

      for (const stagedFile of pendingStagedFiles) {
        try {
          await issuesApi.uploadAttachment(orgId, issue.id, stagedFile.file);
        } catch {
          failures.push(stagedFile.file.name);
        }
      }

      return { issue, orgId, failures };
    },
    onSuccess: async ({ issue, orgId, failures }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(orgId) });
      queryClient.setQueryData(queryKeys.issues.detail(issue.identifier ?? issue.id), issue);
      queryClient.setQueryData(queryKeys.issues.detail(issue.id), issue);
      clearPendingDraftSave();
      saveNewIssuePreferences(orgId, {
        assigneeValue,
        reviewerValue,
        projectId,
      });
      const issueRef = issue.identifier ?? issue.id;
      const issueNavigation = resolveCreatedIssueNavigation({
        issue,
        orgId,
        organizations,
        openContextLocation: openContextLocationRef.current,
      });
      if (failures.length > 0) {
        pushToast({
          title: `Created ${issueRef} with upload warnings`,
          body: `${failures.length} staged ${failures.length === 1 ? "file" : "files"} could not be added.`,
          tone: "warn",
          action: { label: `Open ${issueRef}`, href: issueNavigation.detailHref },
        });
      }
      setRedirectingIssueRef(issueRef);
      await new Promise((resolve) => setTimeout(resolve, 340));
      clearIssueAutosave();
      deleteIssueDraft(activeSavedIssueDraftId);
      reset();
      closeNewIssue();
      const transitionDocument = document as ViewTransitionDocument;
      if (transitionDocument.startViewTransition) {
        await transitionDocument.startViewTransition(() => {
          navigate(issueNavigation.detailHref, {
            state: createIssueDetailLocationState(
              issueNavigation.breadcrumbLabel,
              issueNavigation.breadcrumbHref,
            ),
          });
        }).finished.catch(() => undefined);
      } else {
        navigate(issueNavigation.detailHref, {
          state: createIssueDetailLocationState(
            issueNavigation.breadcrumbLabel,
            issueNavigation.breadcrumbHref,
          ),
        });
      }
    },
  });
  const createAgentIssueRequest = useMutation({
    mutationFn: async ({
      orgId,
      agentId,
      instruction,
      projectId: requestProjectId,
      goalId: requestGoalId,
      parentId,
      contextSnapshot,
      idempotencyKey,
    }: {
      orgId: string;
      agentId: string;
      instruction: string;
      projectId: string | null;
      goalId: string | null;
      parentId: string | null;
      contextSnapshot: Record<string, unknown>;
      idempotencyKey: string;
    }) => issuesApi.createAgentIssueRequest(orgId, {
      agentId,
      instruction,
      projectId: requestProjectId,
      goalId: requestGoalId,
      parentId,
      contextSnapshot,
      idempotencyKey,
    }),
    onSuccess: () => {
      clearPendingDraftSave();
      clearIssueAutosave();
      deleteIssueDraft(activeSavedIssueDraftId);
      pushToast({
        title: t("newIssue.agentRequest.accepted"),
        tone: "success",
      });
      reset();
      closeNewIssue();
    },
    onError: (error) => {
      // A received terminal HTTP response means the server has rejected this
      // key; keep network/transport failures replayable for idempotency.
      if (shouldRotateAgentIssueIdempotencyKey(error)) {
        agentIssueIdempotencyKeyRef.current = createAgentIssueIdempotencyKey();
      }
    },
    onSettled: () => {
      agentIssueSubmissionInFlightRef.current = false;
    },
  });
  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(effectiveCompanyId!, data),
    onSuccess: async (created) => {
      if (!effectiveCompanyId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(effectiveCompanyId) });
      setSelectedLabelIds((current) => [...new Set([...current, created.id])]);
      setLabelSearch("");
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!effectiveCompanyId) throw new Error("No organization selected");
      return assetsApi.uploadImage(effectiveCompanyId, file, "issues/drafts");
    },
  });

  // Debounced draft saving
  const scheduleSave = useCallback(
    (draft: IssueDraft, savedDraftId: string | null = null) => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      pendingDraftSaveRef.current = { draft, savedDraftId };
      draftTimer.current = setTimeout(flushPendingDraftSave, DEBOUNCE_MS);
    },
    [flushPendingDraftSave],
  );

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newIssueOpen) return;
    if (creationMode !== "manual") return;
    if (!hasMeaningfulIssueDraft({
      title,
      description,
      status,
      priority,
      labelIds: selectedLabelIds,
      assigneeValue,
      reviewerValue,
      projectId,
      goalId,
      projectWorkspaceId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
    })) {
      return;
    }
    scheduleSave({
      orgId: effectiveCompanyId,
      title,
      description,
      status,
      priority,
      labelIds: selectedLabelIds,
      assigneeValue,
      reviewerValue,
      projectId,
      goalId,
      projectWorkspaceId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
    }, activeSavedIssueDraftId);
  }, [
    title,
    description,
    status,
    priority,
    selectedLabelIds,
    assigneeValue,
    reviewerValue,
    projectId,
    goalId,
    projectWorkspaceId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    effectiveCompanyId,
    creationMode,
    newIssueOpen,
    activeSavedIssueDraftId,
    scheduleSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newIssueOpen) return;
    setDialogCompanyId(selectedOrganizationId);
    const openContextLocation = openContextLocationRef.current ?? {
      pathname: location.pathname,
      search: location.search,
    };
    const defaultProjectId = resolveDefaultNewIssueProjectId({
      explicitProjectId: newIssueDefaults.projectId,
      pathname: openContextLocation.pathname,
      search: openContextLocation.search,
      projects: orderedProjects,
    });
    const rememberedPreferences = readNewIssuePreferences(selectedOrganizationId);
    const rememberedProjectId = rememberedPreferences?.projectId
      && orderedProjects.some((project) => project.id === rememberedPreferences.projectId)
      ? rememberedPreferences.projectId
      : "";
    const preferredProjectId = defaultProjectId || rememberedProjectId;
    const explicitAssigneeValue = assigneeValueFromSelection(newIssueDefaults);
    const explicitReviewerValue = assigneeValueFromSelection({
      assigneeAgentId: newIssueDefaults.reviewerAgentId,
      assigneeUserId: newIssueDefaults.reviewerUserId,
    });
    const preferredAssigneeValue = explicitAssigneeValue || rememberedPreferences?.assigneeValue || "";
    const preferredReviewerValue = explicitReviewerValue || rememberedPreferences?.reviewerValue || "";

    const savedDraft = readSavedIssueDraft(requestedSavedIssueDraftId, selectedOrganizationId);
    const draft = savedDraft ?? (requestedSavedIssueDraftId ? null : readIssueAutosave(selectedOrganizationId));
    if (savedDraft) {
      setActiveSavedIssueDraftId(savedDraft.id);
    } else {
      setActiveSavedIssueDraftId(null);
    }
    if (savedDraft && hasMeaningfulIssueDraft(savedDraft)) {
      const restoredValues = resolveDraftBackedNewIssueValues({
        defaults: {},
        draft: savedDraft,
        defaultProjectId,
        defaultAssigneeValue: explicitAssigneeValue,
        defaultReviewerValue: explicitReviewerValue,
      });
      const restoredProjectId = restoredValues.projectId;
      const restoredProject = orderedProjects.find((project) => project.id === restoredProjectId);
      setTitle(savedDraft.title);
      setDescription(savedDraft.description);
      setStatus(restoredValues.status);
      setPriority(restoredValues.priority);
      setSelectedLabelIds(restoredValues.labelIds);
      setLabelSearch("");
      setAssigneeValue(restoredValues.assigneeValue);
      setReviewerValue(restoredValues.reviewerValue);
      setProjectId(restoredProjectId);
      setGoalId(restoredValues.goalId);
      setProjectWorkspaceId(savedDraft.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(restoredProject));
      setAssigneeModelOverride(savedDraft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(savedDraft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(savedDraft.assigneeChrome ?? false);
    } else if (newIssueDefaults.title) {
      setTitle(newIssueDefaults.title);
      setDescription(newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setSelectedLabelIds(newIssueDefaults.labelIds ?? []);
      setLabelSearch("");
      const defaultProject = orderedProjects.find((project) => project.id === preferredProjectId);
      setProjectId(preferredProjectId);
      setGoalId(newIssueDefaults.goalId ?? "");
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(preferredAssigneeValue);
      setReviewerValue(preferredReviewerValue);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
    } else if (draft && hasMeaningfulIssueDraft(draft)) {
      const restoredValues = resolveDraftBackedNewIssueValues({
        defaults: newIssueDefaults,
        draft,
        defaultProjectId,
        defaultAssigneeValue: explicitAssigneeValue,
        defaultReviewerValue: explicitReviewerValue,
      });
      const restoredProjectId = restoredValues.projectId;
      const restoredProject = orderedProjects.find((project) => project.id === restoredProjectId);
      setTitle(draft.title);
      setDescription(draft.description);
      setStatus(restoredValues.status);
      setPriority(restoredValues.priority);
      setSelectedLabelIds(restoredValues.labelIds);
      setLabelSearch("");
      setAssigneeValue(restoredValues.assigneeValue);
      setReviewerValue(restoredValues.reviewerValue);
      setProjectId(restoredProjectId);
      setGoalId(restoredValues.goalId);
      setProjectWorkspaceId(draft.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(restoredProject));
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
    } else {
      const defaultProject = orderedProjects.find((project) => project.id === preferredProjectId);
      setTitle("");
      setDescription("");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setSelectedLabelIds(newIssueDefaults.labelIds ?? []);
      setLabelSearch("");
      setProjectId(preferredProjectId);
      setGoalId(newIssueDefaults.goalId ?? "");
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(preferredAssigneeValue);
      setReviewerValue(preferredReviewerValue);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
    }
  }, [newIssueOpen, newIssueDefaults, orderedProjects, requestedSavedIssueDraftId, selectedOrganizationId]);
  useEffect(() => {
    if (!newIssueOpen) {
      previousAssigneeAgentIdRef.current = null;
      return;
    }
    const previousAgentId = previousAssigneeAgentIdRef.current;
    if (previousAgentId !== null && previousAgentId !== selectedAssigneeAgentId) {
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
    }
    previousAssigneeAgentIdRef.current = selectedAssigneeAgentId;
  }, [newIssueOpen, selectedAssigneeAgentId]);
  useEffect(() => {
    if (!assigneeModelOverride || !assigneeAgentRuntimeModels) return;
    const availableModels = resolveRuntimeModels(assigneeAdapterType ?? "", assigneeAgentRuntimeModels);
    if (availableModels.some((model) => model.id === assigneeModelOverride)) return;
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
  }, [assigneeAdapterType, assigneeAgentRuntimeModels, assigneeModelOverride]);
  useEffect(() => {
    if (!supportsAssigneeOverrides) {
      setAssigneeOptionsOpen(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      return;
    }
    const validThinkingValues = thinkingOptionsForAssignee(
      assigneeAdapterType,
      effectiveAssigneeModel,
      assigneeModelMetadata,
    );
    if (!validThinkingValues.some((option) => option.value === assigneeThinkingEffort)) {
      setAssigneeThinkingEffort("");
    }
  }, [
    assigneeAdapterType,
    assigneeModelMetadata,
    assigneeThinkingEffort,
    effectiveAssigneeModel,
    supportsAssigneeOverrides,
  ]);

  useEffect(() => {
    return () => {
      flushPendingDraftSave();
    };
  }, [flushPendingDraftSave]);

  function reset() {
    setDocumentSessionId((current) => current + 1);
    setTitle("");
    setDescription("");
    setCreationMode("manual");
    setStatus("todo");
    setPriority("");
    setSelectedLabelIds([]);
    setLabelSearch("");
    setAssigneeValue("");
    setReviewerValue("");
    setProjectId("");
    setGoalId("");
    setProjectWorkspaceId("");
    setAssigneeOptionsOpen(false);
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setDialogCompanyId(null);
    setStagedFiles([]);
    setIsFileDragOver(false);
    setCompanyOpen(false);
    setActiveSavedIssueDraftId(null);
    setRedirectingIssueRef(null);
    agentIssueIdempotencyKeyRef.current = null;
    agentIssueSubmissionInFlightRef.current = false;
  }

  function handleCloseNewIssue() {
    flushPendingDraftSave();
    if (creationMode === "agent") setDescription("");
    setCreationMode("manual");
    setDocumentSessionId((current) => current + 1);
    agentIssueIdempotencyKeyRef.current = null;
    agentIssueSubmissionInFlightRef.current = false;
    closeNewIssue();
  }

  function handleCompanyChange(orgId: string) {
    if (isCreatingOrRedirecting) return;
    if (orgId === effectiveCompanyId) return;
    setDialogCompanyId(orgId);
    setAssigneeValue("");
    setReviewerValue("");
    setProjectId("");
    setGoalId("");
    setProjectWorkspaceId("");
    setSelectedLabelIds([]);
    setLabelSearch("");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
  }

  function saveDraftIssue() {
    const savedDraft = createIssueDraft({
      orgId: effectiveCompanyId,
      title,
      description,
      status,
      priority,
      labelIds: selectedLabelIds,
      assigneeValue,
      reviewerValue,
      projectId,
      goalId,
      projectWorkspaceId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
    });
    if (!savedDraft) return;
    clearPendingDraftSave();
    deleteIssueDraft(activeSavedIssueDraftId);
    clearIssueAutosave();
    pushToast({
      title: "Saved to Draft Issues",
      body: "Open Draft Issues from the Issues sidebar to continue it.",
      tone: "success",
    });
    reset();
    closeNewIssue();
  }

  function changeCreationMode(nextMode: IssueCreationMode) {
    if (isCreatingOrRedirecting || nextMode === creationMode) return;
    if (nextMode === "agent") clearPendingDraftSave();
    setCreationMode(nextMode);
  }

  function handleSubmit() {
    if (!effectiveCompanyId || isCreatingOrRedirecting) return;
    if (creationMode === "agent") {
      if (agentIssueSubmissionInFlightRef.current) return;
      const instruction = description.trim();
      if (!selectedAssigneeAgentId || !instruction) return;
      agentIssueSubmissionInFlightRef.current = true;
      createAgentIssueRequest.mutate({
        orgId: effectiveCompanyId,
        agentId: selectedAssigneeAgentId,
        instruction,
        projectId: projectId || null,
        goalId: goalId || null,
        parentId: newIssueDefaults.parentId ?? null,
        contextSnapshot: {
          source: "new-issue-dialog",
          pathname: openContextLocationRef.current?.pathname ?? location.pathname,
          search: openContextLocationRef.current?.search ?? location.search,
        },
        idempotencyKey: agentIssueIdempotencyKeyRef.current ??= createAgentIssueIdempotencyKey(),
      });
      return;
    }
    if (!hasIssueTitle) return;
    setRedirectingIssueRef(null);
    const assigneeAgentRuntimeOverrides = buildAssigneeAdapterOverrides({
      agentRuntimeType: assigneeAdapterType,
      modelOverride: assigneeModelOverride,
      thinkingEffortOverride: assigneeThinkingEffort,
      chrome: assigneeChrome,
    });
    createIssue.mutate({
      orgId: effectiveCompanyId,
      stagedFiles,
      ...buildNewIssueCreateRequest({
        title,
        description,
        parentId: newIssueDefaults.parentId,
        status,
        priority,
        assigneeAgentId: selectedAssigneeAgentId,
        assigneeUserId: selectedAssigneeUserId,
        reviewerAgentId: selectedReviewerAgentId,
        reviewerUserId: selectedReviewerUserId,
        projectId,
        goalId,
        labelIds: selectedLabelIds,
        projectWorkspaceId,
        assigneeAgentRuntimeOverrides,
      }),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function stageFiles(files: File[]) {
    if (files.length === 0) return;
    setStagedFiles((current) => {
      const next = [...current];
      for (const file of files) {
        next.push({
          id: `${file.name}:${file.size}:${file.lastModified}`,
          file,
          kind: "attachment",
        });
      }
      return next;
    });
  }

  function handleStageFilesPicked(evt: ChangeEvent<HTMLInputElement>) {
    stageFiles(Array.from(evt.target.files ?? []));
    if (stageFileInputRef.current) {
      stageFileInputRef.current.value = "";
    }
  }

  function handleFileDragEnter(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    setIsFileDragOver(true);
  }

  function handleFileDragOver(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleFileDragLeave(evt: DragEvent<HTMLDivElement>) {
    if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
    setIsFileDragOver(false);
  }

  function handleFileDrop(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.files.length) return;
    evt.preventDefault();
    setIsFileDragOver(false);
    stageFiles(Array.from(evt.dataTransfer.files));
  }

  function removeStagedFile(id: string) {
    setStagedFiles((current) => current.filter((file) => file.id !== id));
  }

  const currentStatus = statuses.find((s) => s.value === status) ?? statuses[1]!;
  const currentPriority = priorities.find((p) => p.value === priority);
  const selectedLabels = useMemo(
    () => (labels ?? []).filter((label) => selectedLabelIds.includes(label.id)),
    [labels, selectedLabelIds],
  );
  const normalizedLabelQuery = normalizeIssueLabelName(labelSearch);
  const visibleLabels = useMemo(
    () =>
      (labels ?? []).filter((label) => {
        if (!normalizedLabelQuery) return true;
        return label.name.toLowerCase().includes(normalizedLabelQuery.toLowerCase());
      }),
    [labels, normalizedLabelQuery],
  );
  const exactLabelMatch = useMemo(
    () => findIssueLabelExactMatch(labels ?? [], normalizedLabelQuery),
    [labels, normalizedLabelQuery],
  );
  const shouldShowCreateLabelOption =
    normalizedLabelQuery.length > 0 &&
    visibleLabels.length === 0 &&
    !exactLabelMatch;
  const createLabelColor = pickIssueLabelColor(normalizedLabelQuery);
  const labelsTrigger = selectedLabels.length > 0 ? (
    <>
      <Tag className="h-3 w-3" />
      <div className="flex items-center gap-1 flex-wrap">
        {selectedLabels.slice(0, 2).map((label) => (
          <IssueLabelChip key={label.id} label={label} />
        ))}
        {selectedLabels.length > 2 ? (
          <span className="text-[11px] text-muted-foreground">+{selectedLabels.length - 2}</span>
        ) : null}
      </div>
    </>
  ) : (
    <>
      <Tag className="h-3 w-3" />
      Labels
    </>
  );
  const createLabelFromSearch = useCallback(() => {
    if (!effectiveCompanyId || !shouldShowCreateLabelOption || createLabel.isPending) return;
    createLabel.mutate({
      name: normalizedLabelQuery,
      color: createLabelColor,
    });
  }, [
    createLabel,
    createLabelColor,
    effectiveCompanyId,
    normalizedLabelQuery,
    shouldShowCreateLabelOption,
  ]);
  const currentProject = orderedProjects.find((project) => project.id === projectId);
  const currentGoal = (goals ?? []).find((goal) => goal.id === goalId) ?? null;
  const assigneeOptionsTitle =
    assigneeAdapterType === "claude_local"
      ? "Claude options"
      : assigneeAdapterType === "codex_local"
        ? "Codex options"
        : assigneeAdapterType === "opencode_local"
        ? "OpenCode options"
        : assigneeAdapterType === "pi_local"
          ? "Pi options"
          : assigneeAdapterType === "cursor"
            ? "Cursor options"
        : "Agent options";
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...currentUserAssigneeOption(currentUserId),
      ...sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agents, currentUserId, recentAssigneeIds],
  );
  const agentCreationOptions = useMemo<InlineEntityOption[]>(
    () => sortAgentsByRecency(
      (agents ?? []).filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval"),
      recentAssigneeIds,
    ).map((agent) => ({
      id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
      label: agent.name,
      searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
    })),
    [agents, recentAssigneeIds],
  );
  const agentCreationAgent = currentAssignee;
  const reviewerOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...currentUserAssigneeOption(currentUserId),
      ...sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agents, currentUserId, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const goalOptions = useMemo<InlineEntityOption[]>(
    () =>
      (goals ?? []).map((goal) => ({
        id: goal.id,
        label: goal.title,
        searchText: `${goal.title} ${goal.description ?? ""} ${goal.status}`,
      })),
    [goals],
  );
  const canSaveDraft = hasMeaningfulIssueDraft({
    title,
    description,
    status,
    priority,
    labelIds: selectedLabelIds,
    assigneeValue,
    reviewerValue,
    projectId,
    goalId,
    projectWorkspaceId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
  });
  const createIssueErrorMessage =
    createIssue.error instanceof Error ? createIssue.error.message : "Failed to create issue. Try again.";
  const createAgentIssueErrorMessage =
    createAgentIssueRequest.error instanceof Error
      ? createAgentIssueRequest.error.message
      : "Failed to send the Agent request. Try again.";
  const isCreatingOrRedirecting =
    createIssue.isPending || createAgentIssueRequest.isPending || Boolean(redirectingIssueRef);
  const hasIssueTitle = title.trim().length > 0;
  const hasAgentInstruction = Boolean(selectedAssigneeAgentId) && description.trim().length > 0;
  const canSubmit = creationMode === "agent" ? hasAgentInstruction : hasIssueTitle;
  const handleAssigneeChange = useCallback((value: string) => {
    const nextAssignee = parseAssigneeValue(value);
    if (nextAssignee.assigneeAgentId) {
      trackRecentAssignee(nextAssignee.assigneeAgentId);
    }
    setAssigneeValue(value);
  }, []);
  const labelPickerScrollRef = useScrollbarActivityRef();
  const isSubIssueDraft = Boolean(newIssueDefaults.parentId);
  const parentIssueSnapshot = newIssueDefaults.parentIssue;
  const parentIssueRef =
    parentIssueSnapshot?.identifier?.trim()
    || parentIssueSnapshot?.id?.slice(0, 8)
    || newIssueDefaults.parentId?.slice(0, 8)
    || null;
  const parentIssueTitle = parentIssueSnapshot?.title?.trim() || null;
  const stagedDocuments = stagedFiles.filter((file) => file.kind === "document");
  const stagedAttachments = stagedFiles.filter((file) => file.kind === "attachment");
  const labelPickerContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search labels..."
        value={labelSearch}
        onChange={(event) => setLabelSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !shouldShowCreateLabelOption) return;
          event.preventDefault();
          createLabelFromSearch();
        }}
        autoFocus
      />
      <div ref={labelPickerScrollRef} className="scrollbar-auto-hide max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {visibleLabels.map((label) => {
          const selected = selectedLabelIds.includes(label.id);
          return (
            <button
              key={label.id}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                selected && "bg-accent",
              )}
              onClick={() =>
                setSelectedLabelIds((current) =>
                  current.includes(label.id)
                    ? current.filter((id) => id !== label.id)
                    : [...current, label.id],
                )}
            >
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
              <span className="truncate">{label.name}</span>
            </button>
          );
        })}
        {shouldShowCreateLabelOption ? (
          <>
            {visibleLabels.length > 0 ? <div className="my-1 border-t border-border" /> : null}
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left"
              disabled={createLabel.isPending}
              onClick={createLabelFromSearch}
            >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border/70 text-muted-foreground">
                <Plus className="h-2.5 w-2.5" />
              </span>
              <span className="truncate">
                {createLabel.isPending ? "Creating..." : `Create label "${normalizedLabelQuery}"`}
              </span>
              <span
                className="ml-auto h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: createLabelColor }}
                aria-hidden="true"
              />
            </button>
          </>
        ) : null}
      </div>
    </>
  );

  const handleProjectChange = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId);
    const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(nextProject));
  }, [orderedProjects]);
  const assigneeRuntimeOverrides = useMemo<IssueAssigneeAgentRuntimeOverrides | null>(
    () => buildAssigneeAdapterOverrides({
      agentRuntimeType: assigneeAdapterType,
      modelOverride: assigneeModelOverride,
      thinkingEffortOverride: assigneeThinkingEffort,
      chrome: assigneeChrome,
    }) as IssueAssigneeAgentRuntimeOverrides | null,
    [assigneeAdapterType, assigneeChrome, assigneeModelOverride, assigneeThinkingEffort],
  );
  const descriptionEditor = (
    <MarkdownEditor
      ref={descriptionEditorRef}
      engine="codemirror"
      documentIdentity={`new-issue:${effectiveCompanyId ?? "none"}:${activeSavedIssueDraftId ?? documentSessionId}`}
      value={description}
      onChange={(value) => {
        if (!isCreatingOrRedirecting) setDescription(value);
      }}
      readOnly={isCreatingOrRedirecting}
      ariaLabel={creationMode === "agent" ? "Instruction" : undefined}
      placeholder={creationMode === "agent" ? "Describe the Issue you want the Agent to create..." : "Add description..."}
      bordered={false}
      mentions={mentionOptions}
      onMentionQueryChange={setLibraryFileMentionQuery}
      contentClassName={cn(
        "text-sm text-muted-foreground pb-12",
        creationMode === "agent" ? "min-h-[180px]" : "min-h-[88px]",
      )}
      imageUploadHandler={isCreatingOrRedirecting
        ? undefined
        : async (file) => {
            const asset = await uploadDescriptionImage.mutateAsync(file);
            return asset.contentPath;
          }}
    />
  );
  const applyAssigneeRuntimeOverrides = useCallback((nextOverrides: IssueAssigneeAgentRuntimeOverrides | null) => {
    const next = readAssigneeRuntimeOverrides(nextOverrides, assigneeAdapterType);
    setAssigneeModelOverride(next.modelOverride);
    setAssigneeThinkingEffort(next.thinkingEffortOverride);
    setAssigneeChrome(next.chrome);
  }, [assigneeAdapterType]);

  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open && !isCreatingOrRedirecting) handleCloseNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          "motion-new-issue-dialog p-0 gap-0 flex flex-col max-h-[calc(100dvh-2rem)] sm:max-w-[920px]",
          redirectingIssueRef && "motion-new-issue-dialog--created",
        )}
        data-redirecting={redirectingIssueRef ? "true" : undefined}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (isCreatingOrRedirecting) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (isCreatingOrRedirecting) {
            event.preventDefault();
            return;
          }
          // Radix Dialog's modal DismissableLayer calls preventDefault() on
          // pointerdown events that originate outside the Dialog DOM tree.
          // Popover portals render at the body level (outside the Dialog), so
          // touch events on popover content get their default prevented — which
          // kills scroll gesture recognition on mobile.  Telling Radix "this
          // event is handled" skips that preventDefault, restoring touch scroll.
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper]")) {
            event.preventDefault();
          }
        }}
        >
        <DialogTitle className="sr-only">{isSubIssueDraft ? "New sub-issue" : "New issue"}</DialogTitle>
        <div className="flex items-center justify-center border-b border-border/60 px-4 py-2 shrink-0">
          <div
            className="grid h-8 w-40 grid-cols-2 overflow-hidden rounded-lg border border-border bg-muted/30 p-0.5"
            role="tablist"
            aria-label="Issue creation mode"
          >
            {(["manual", "agent"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={creationMode === mode}
                className={cn(
                  "flex h-7 min-w-0 items-center justify-center rounded-[6px] px-3 text-xs font-medium transition-colors",
                  creationMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                disabled={isCreatingOrRedirecting}
                onClick={() => changeCreationMode(mode)}
              >
                {mode === "manual" ? "Manual" : "Agent"}
              </button>
            ))}
          </div>
        </div>
        {redirectingIssueRef ? (
          <div
            className="motion-new-issue-created-banner absolute left-1/2 top-4 z-10 inline-flex -translate-x-1/2 items-center gap-2 rounded-md border border-[color:color-mix(in_oklab,var(--accent-base)_42%,var(--border))] bg-[color:color-mix(in_oklab,var(--accent-soft)_82%,var(--surface-elevated))] px-3 py-1.5 text-xs font-medium text-foreground shadow-[var(--shadow-sm)]"
            role="status"
            aria-live="polite"
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--accent-base)]" />
            <span>Created {redirectingIssueRef}. Opening issue...</span>
          </div>
        ) : null}

        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
              <PopoverTrigger asChild>
                <button
                  disabled={isCreatingOrRedirecting}
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity disabled:cursor-wait disabled:opacity-60",
                    !dialogCompany?.brandColor && "bg-muted",
                  )}
                  style={
                    dialogCompany?.brandColor
                      ? {
                          backgroundColor: dialogCompany.brandColor,
                          color: pickTextColorForSolidBg(dialogCompany.brandColor),
                        }
                      : undefined
                  }
                >
                  {(dialogCompany?.name ?? "").slice(0, 3).toUpperCase()}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                {organizations.filter((c) => c.status !== "archived").map((c) => (
                  <button
                    key={c.id}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      c.id === effectiveCompanyId && "bg-accent",
                    )}
                    onClick={() => {
                      handleCompanyChange(c.id);
                      setCompanyOpen(false);
                    }}
                  >
                    <span
                      className={cn(
                        "px-1 py-0.5 rounded text-[10px] font-semibold leading-none",
                        !c.brandColor && "bg-muted",
                      )}
                      style={
                        c.brandColor
                          ? {
                              backgroundColor: c.brandColor,
                              color: pickTextColorForSolidBg(c.brandColor),
                            }
                          : undefined
                      }
                    >
                      {c.name.slice(0, 3).toUpperCase()}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{isSubIssueDraft ? "New sub-issue" : "New issue"}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label="Close new issue dialog"
              onClick={handleCloseNewIssue}
              disabled={isCreatingOrRedirecting}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {isSubIssueDraft ? (
          <div data-slot="new-issue-parent-context" className="border-b border-border/60 px-4 py-2.5 shrink-0">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground">
              <ListTree className="h-3.5 w-3.5 shrink-0" />
              <span className="shrink-0 font-medium">Parent</span>
              {parentIssueRef ? (
                <span className="w-20 shrink-0 truncate whitespace-nowrap rounded-sm border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground">
                  {parentIssueRef}
                </span>
              ) : null}
              {parentIssueTitle ? (
                <span className="min-w-0 flex-1 truncate text-foreground/80">{parentIssueTitle}</span>
              ) : null}
            </div>
          </div>
        ) : null}

        {creationMode === "agent" ? (
          <fieldset
            data-slot="agent-issue-composer"
            className="m-0 min-w-0 shrink-0 border-0 p-0 disabled:cursor-wait"
            disabled={isCreatingOrRedirecting}
          >
            <div className="shrink-0 px-4 pb-3 pt-4">
              <div className={cn("grid grid-cols-1 gap-2", goalsEnabled ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
                <div className="min-w-0 space-y-1">
                  <div className="text-[11px] font-medium text-muted-foreground">Agent</div>
                  <InlineEntitySelector
                    value={assigneeValue}
                    options={agentCreationOptions}
                    placeholder="Select an Agent"
                    noneLabel="Select an Agent"
                    searchPlaceholder="Search Agents..."
                    emptyMessage="No callable Agents found."
                    variant="field"
                    className={ISSUE_METADATA_SELECTOR_CLASSNAME}
                    disablePortal
                    onConfirm={() => descriptionEditorRef.current?.focus()}
                    onChange={(value) => {
                      if (!isCreatingOrRedirecting) handleAssigneeChange(value);
                    }}
                    renderTriggerValue={(option) =>
                      option && agentCreationAgent ? (
                        <AgentMenuLabel agent={agentCreationAgent} agentAvatarStyle="bare" />
                      ) : (
                        <span className="text-muted-foreground">Select an Agent</span>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const agentId = parseAssigneeValue(option.id).assigneeAgentId;
                      const agent = (agents ?? []).find((candidate) => candidate.id === agentId);
                      return agent
                        ? <AgentMenuLabel agent={agent} agentAvatarStyle="bare" />
                        : <span className="truncate">{option.label}</span>;
                    }}
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="text-[11px] font-medium text-muted-foreground">Project</div>
                  <InlineEntitySelector
                    ref={projectSelectorRef}
                    value={projectId}
                    options={projectOptions}
                    placeholder="No project"
                    disablePortal
                    noneLabel="No project"
                    searchPlaceholder="Search projects..."
                    emptyMessage="No projects found."
                    variant="field"
                    className={ISSUE_METADATA_SELECTOR_CLASSNAME}
                    onChange={(value) => {
                      if (!isCreatingOrRedirecting) handleProjectChange(value);
                    }}
                    renderTriggerValue={(option) =>
                      option && currentProject ? (
                        <>
                          <ProjectIcon color={currentProject.color} icon={currentProject.icon} size="xs" />
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">No project</span>
                      )
                    }
                  />
                </div>
                {goalsEnabled ? (
                  <div className="min-w-0 space-y-1">
                    <div className="text-[11px] font-medium text-muted-foreground">Goal</div>
                    <InlineEntitySelector
                      value={goalId}
                      options={goalOptions}
                      placeholder="No goal"
                      disablePortal
                      noneLabel="No goal"
                      searchPlaceholder="Search goals..."
                      emptyMessage="No goals found."
                      variant="field"
                      className={ISSUE_METADATA_SELECTOR_CLASSNAME}
                      onChange={(value) => {
                        if (!isCreatingOrRedirecting) setGoalId(value);
                      }}
                      renderTriggerValue={(option) =>
                        option && currentGoal ? (
                          <>
                            <Target className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{option.label}</span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">No goal</span>
                        )
                      }
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </fieldset>
        ) : (
          <>
        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <textarea
            className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50"
            placeholder="Issue title"
            rows={1}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            readOnly={isCreatingOrRedirecting}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                if (assigneeValue) {
                  // Assignee already set — skip to project or description
                  if (projectId) {
                    descriptionEditorRef.current?.focus();
                  } else {
                    projectSelectorRef.current?.focus();
                  }
                } else {
                  assigneeSelectorRef.current?.focus();
                }
              }
            }}
            autoFocus
          />
        </div>

        <div className="px-4 pb-3 shrink-0">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="min-w-0 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">Assignee</div>
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={assigneeValue}
                options={assigneeOptions}
                placeholder="Assignee"
                disablePortal
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                variant="field"
                className={ISSUE_METADATA_SELECTOR_CLASSNAME}
                keepOpenOnOptionChange={(option) => {
                  const agentId = parseAssigneeValue(option.id).assigneeAgentId;
                  const agent = agentId ? (agents ?? []).find((candidate) => candidate.id === agentId) : null;
                  return Boolean(agent && ISSUE_OVERRIDE_ADAPTER_TYPES.has(agent.agentRuntimeType));
                }}
                onChange={handleAssigneeChange}
                onConfirm={() => {
                  if (projectId) {
                    descriptionEditorRef.current?.focus();
                  } else {
                    projectSelectorRef.current?.focus();
                  }
                }}
                renderTriggerValue={(option) =>
                  option ? (
                    currentAssignee ? (
                      <AgentMenuLabel agent={currentAssignee} agentAvatarStyle="bare" />
                    ) : (
                      <AssigneeLabel kind="user" label={option.label} avatarUrl={selectedAssigneeUserId === currentUserId ? currentUserAvatarUrl : null} />
                    )
                  ) : (
                    <span className="text-muted-foreground">No assignee</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return assignee
                    ? <AgentMenuLabel agent={assignee} agentAvatarStyle="bare" />
                    : <AssigneeLabel kind="user" label={option.label} avatarUrl={parseAssigneeValue(option.id).assigneeUserId === currentUserId ? currentUserAvatarUrl : null} />;
                }}
                renderOptionAccessory={(option, isSelected) =>
                  option.id && isSelected && currentAssignee && effectiveCompanyId ? (
                    <IssueRuntimeSelector
                      agent={currentAssignee}
                      orgId={effectiveCompanyId}
                      overrides={assigneeRuntimeOverrides}
                      variant="menu"
                      onApply={applyAssigneeRuntimeOverrides}
                    />
                  ) : null
                }
              />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">Project</div>
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={projectId}
                options={projectOptions}
                placeholder="Project"
                disablePortal
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                variant="field"
                className={ISSUE_METADATA_SELECTOR_CLASSNAME}
                onChange={handleProjectChange}
                onConfirm={() => {
                  descriptionEditorRef.current?.focus();
                }}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <ProjectIcon color={currentProject.color} icon={currentProject.icon} size="xs" />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No project</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = orderedProjects.find((item) => item.id === option.id);
                  return (
                    <>
                      <ProjectIcon color={project?.color} icon={project?.icon} size="xs" />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">Reviewer</div>
              <InlineEntitySelector
                value={reviewerValue}
                options={reviewerOptions}
                placeholder="Reviewer"
                disablePortal
                noneLabel="No reviewer"
                searchPlaceholder="Search reviewers..."
                emptyMessage="No reviewers found."
                variant="field"
                className={ISSUE_METADATA_SELECTOR_CLASSNAME}
                onChange={(value) => {
                  const nextReviewer = parseAssigneeValue(value);
                  if (nextReviewer.assigneeAgentId) {
                    trackRecentAssignee(nextReviewer.assigneeAgentId);
                  }
                  setReviewerValue(value);
                }}
                onConfirm={() => {
                  descriptionEditorRef.current?.focus();
                }}
                renderTriggerValue={(option) =>
                  option ? (
                    currentReviewer ? (
                      <AgentMenuLabel agent={currentReviewer} agentAvatarStyle="bare" />
                    ) : (
                      <AssigneeLabel kind="user" label={option.label} avatarUrl={selectedReviewerUserId === currentUserId ? currentUserAvatarUrl : null} />
                    )
                  ) : (
                    <span className="text-muted-foreground">No reviewer</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const reviewer = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return reviewer
                    ? <AgentMenuLabel agent={reviewer} agentAvatarStyle="bare" />
                    : <AssigneeLabel kind="user" label={option.label} avatarUrl={parseAssigneeValue(option.id).assigneeUserId === currentUserId ? currentUserAvatarUrl : null} />;
                }}
              />
            </div>
          </div>
        </div>

        {assigneeAdapterType === "claude_local" && (
          <div className="px-4 pb-2 shrink-0">
            <button
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setAssigneeOptionsOpen((open) => !open)}
            >
              {assigneeOptionsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {assigneeOptionsTitle}
            </button>
            {assigneeOptionsOpen && (
              <div className="mt-2 rounded-md border border-border p-3 bg-muted/20 space-y-3">
                <div className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
                  <div className="text-xs text-muted-foreground">Enable Chrome (--chrome)</div>
                  <ToggleSwitch
                    checked={assigneeChrome}
                    size="sm"
                    tone="success"
                    aria-label="Enable Chrome"
                    onClick={() => setAssigneeChrome((value) => !value)}
                  />
                </div>
              </div>
            )}
          </div>
        )}

          </>
        )}

        {/* Description */}
        <div
          data-slot={creationMode === "agent" ? "agent-issue-instruction" : undefined}
          className={cn(
            "min-h-0 overflow-y-auto border-t border-border/60 px-4 pb-2 pt-3",
            creationMode === "agent" && "flex-1",
          )}
          onDragEnter={creationMode === "manual" ? handleFileDragEnter : undefined}
          onDragOver={creationMode === "manual" ? handleFileDragOver : undefined}
          onDragLeave={creationMode === "manual" ? handleFileDragLeave : undefined}
          onDrop={creationMode === "manual" ? handleFileDrop : undefined}
        >
          <div
            className={cn(
              "rounded-md transition-colors",
              creationMode === "manual" && isFileDragOver && "bg-accent/20",
            )}
          >
            {descriptionEditor}
          </div>
          {creationMode === "manual" && stagedFiles.length > 0 ? (
            <div className="mt-4 space-y-3 rounded-lg border border-border/70 p-3">
              {stagedDocuments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Documents</div>
                  <div className="space-y-2">
                    {stagedDocuments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                              {file.documentKey}
                            </span>
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            <span>{file.title || file.file.name}</span>
                            <span>•</span>
                            <span>{formatFileSize(file.file)}</span>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                          onClick={() => removeStagedFile(file.id)}
                          disabled={isCreatingOrRedirecting}
                          title="Remove document"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {stagedAttachments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Attachments</div>
                  <div className="space-y-2">
                    {stagedAttachments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Paperclip className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {file.file.type || "application/octet-stream"} • {formatFileSize(file.file)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                          onClick={() => removeStagedFile(file.id)}
                          disabled={isCreatingOrRedirecting}
                          title="Remove attachment"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Property chips bar */}
        {creationMode === "manual" ? (
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap shrink-0">
          {/* Status chip */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <CircleDot className={cn("h-3 w-3", currentStatus.color)} />
                {currentStatus.label}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {statuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  <CircleDot className={cn("h-3 w-3", s.color)} />
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Priority chip */}
          <Popover open={priorityOpen} onOpenChange={setPriorityOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                {currentPriority ? (
                  <>
                    <PriorityBarsIcon priority={currentPriority.value} className="h-3.5 w-4" />
                    {currentPriority.label}
                  </>
                ) : (
                  <>
                    <Minus className="h-3 w-3 text-muted-foreground" />
                    Priority
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className={priorityPickerContentClassName} align="start" role="menu" aria-label="Issue priority">
              {priorities.map((p) => (
                <PriorityPickerOption
                  key={p.value}
                  priority={p.value}
                  selected={p.value === priority}
                  onSelect={(nextPriority) => {
                    setPriority(nextPriority);
                    setPriorityOpen(false);
                  }}
                />
              ))}
            </PopoverContent>
          </Popover>

          {/* Labels chip */}
          <Popover open={labelsOpen} onOpenChange={setLabelsOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                  selectedLabels.length > 0 ? "text-foreground" : "text-muted-foreground",
                )}
                disabled={isCreatingOrRedirecting}
              >
                {labelsTrigger}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start" disablePortal>
              {labelPickerContent}
            </PopoverContent>
          </Popover>

          {goalsEnabled ? <InlineEntitySelector
            value={goalId}
            options={goalOptions}
            placeholder="Goal"
            disablePortal
            noneLabel="No goal"
            searchPlaceholder="Search goals..."
            emptyMessage="No goals found."
            className={cn(
              "border-border bg-transparent px-2 py-1 [font-size:0.75rem] hover:bg-accent/50",
              currentGoal ? "text-foreground" : "text-muted-foreground",
            )}
            contentClassName="w-56"
            onChange={setGoalId}
            onConfirm={() => {
              descriptionEditorRef.current?.focus();
            }}
            renderTriggerValue={(option) =>
              option && currentGoal ? (
                <>
                  <Target className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="max-w-40 truncate">{option.label}</span>
                </>
              ) : (
                <>
                  <Target className="h-3 w-3 shrink-0" />
                  Goal
                </>
              )
            }
            renderOption={(option) =>
              option.id ? (
                <>
                  <Target className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{option.label}</span>
                </>
              ) : (
                <span className="truncate">{option.label}</span>
              )
            }
          /> : null}

          <input
            ref={stageFileInputRef}
            type="file"
            accept={STAGED_FILE_ACCEPT}
            className="hidden"
            onChange={handleStageFilesPicked}
            multiple
          />
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground"
            onClick={() => stageFileInputRef.current?.click()}
            disabled={isCreatingOrRedirecting}
          >
            <Paperclip className="h-3 w-3" />
            Upload
          </button>

          {/* More (dates) */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center justify-center rounded-md border border-border p-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground">
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start">
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                Start date
              </button>
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                Due date
              </button>
            </PopoverContent>
          </Popover>
        </div>
        ) : null}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0">
          {creationMode === "agent" ? (
            <span className="min-h-8 inline-flex items-center text-xs text-muted-foreground">
              Agent request
            </span>
          ) : activeSavedIssueDraftId ? (
            <div className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved to Draft Issues
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "text-muted-foreground disabled:opacity-100",
                !canSaveDraft && "disabled:border-border/40 disabled:bg-muted/20 disabled:text-muted-foreground/70",
              )}
              onClick={saveDraftIssue}
              disabled={isCreatingOrRedirecting || !canSaveDraft}
            >
              Save Draft
            </Button>
          )}
          <div className="flex items-center gap-3">
            <div className="min-h-5 text-right">
                {redirectingIssueRef ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--accent-base)]">
                    <CheckCircle2 className="h-3 w-3" />
                    Opening issue...
                  </span>
                ) : createIssue.isPending ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {isSubIssueDraft ? "Creating sub-issue..." : "Creating issue..."}
                  </span>
                ) : createAgentIssueRequest.isPending ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Sending to Agent...
                  </span>
                ) : createIssue.isError ? (
                <span className="text-xs text-destructive">{createIssueErrorMessage}</span>
                ) : creationMode === "agent" && createAgentIssueRequest.isError ? (
                  <span className="text-xs text-destructive">{createAgentIssueErrorMessage}</span>
                ) : null}
            </div>
            <Button
              size="sm"
              className={cn(
                "min-w-[8.5rem] disabled:opacity-100",
                !canSubmit && "disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:ring-1 disabled:ring-inset disabled:ring-border/80 disabled:shadow-none",
              )}
              disabled={!canSubmit || isCreatingOrRedirecting}
              onClick={handleSubmit}
              aria-busy={isCreatingOrRedirecting}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {redirectingIssueRef ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : createIssue.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : createAgentIssueRequest.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                <span>
                  {redirectingIssueRef
                    ? "Opening..."
                    : createIssue.isPending
                      ? "Creating..."
                      : createAgentIssueRequest.isPending
                        ? "Sending..."
                        : creationMode === "agent"
                          ? "Send to Agent"
                          : isSubIssueDraft
                            ? "Create sub-issue"
                            : "Create Issue"}
                </span>
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
