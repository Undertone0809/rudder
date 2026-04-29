import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent, type DragEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pickTextColorForPillBg, pickTextColorForSolidBg } from "@/lib/color-contrast";
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
import { projectColorBackgroundStyle } from "../lib/project-colors";
import {
  buildNewIssueCreateRequest,
  clearIssueAutosave,
  createIssueDraft,
  deleteIssueDraft,
  hasMeaningfulIssueDraft,
  readIssueAutosave,
  readSavedIssueDraft,
  resolveDefaultNewIssueProjectId,
  resolveDraftBackedNewIssueValues,
  saveIssueAutosave,
  type IssueDraft,
} from "../lib/new-issue-dialog";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { useToast } from "../context/ToastContext";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  parseAssigneeValue,
} from "../lib/assignees";
import { useLocation } from "@/lib/router";
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
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Tag,
  Calendar,
  FileText,
  Loader2,
  Paperclip,
  X,
  Plus,
} from "lucide-react";
import { cn } from "../lib/utils";
import { extractProviderIdWithFallback } from "../lib/model-utils";
import { CODEX_LOCAL_REASONING_EFFORT_OPTIONS, withDefaultThinkingEffortOption } from "../lib/runtime-thinking-effort";
import { resolveRuntimeModels } from "../lib/runtime-models";
import { issueStatusText, issueStatusTextDefault, priorityColor, priorityColorDefault } from "../lib/status-colors";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { AgentIcon } from "./AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";

const DEBOUNCE_MS = 800;

type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local"]);
const STAGED_FILE_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";

const ISSUE_THINKING_EFFORT_OPTIONS = {
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

function isTextDocumentFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".txt") ||
    file.type === "text/markdown" ||
    file.type === "text/plain"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createUniqueDocumentKey(baseKey: string, stagedFiles: StagedIssueFile[]) {
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

const priorities = [
  { value: "critical", label: "Critical", icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
  { value: "high", label: "High", icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
  { value: "medium", label: "Medium", icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
  { value: "low", label: "Low", icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
];

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

export function NewIssueDialog() {
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const { organizations, selectedOrganizationId, selectedOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const location = useLocation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [labelSearch, setLabelSearch] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectWorkspaceId, setProjectWorkspaceId] = useState("");
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedIssueFile[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [activeSavedIssueDraftId, setActiveSavedIssueDraftId] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openContextLocationRef = useRef<{ pathname: string; search: string } | null>(null);

  const effectiveCompanyId = dialogCompanyId ?? selectedOrganizationId;
  const dialogCompany = organizations.find((c) => c.id === effectiveCompanyId) ?? selectedOrganization;

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
  const currentAssignee = selectedAssigneeAgentId
    ? (agents ?? []).find((agent) => agent.id === selectedAssigneeAgentId) ?? null
    : null;

  const assigneeAdapterType = currentAssignee?.agentRuntimeType ?? null;
  const supportsAssigneeOverrides = Boolean(
    assigneeAdapterType && ISSUE_OVERRIDE_ADAPTER_TYPES.has(assigneeAdapterType),
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

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: formatChatAgentLabel(agent),
        kind: "agent",
        agentId: agent.id,
        agentIcon: agent.icon,
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    options.push(...skillMentionOptions);
    return options;
  }, [agents, orderedProjects, skillMentionOptions]);

  const { data: assigneeAgentRuntimeModels } = useQuery({
    queryKey:
      effectiveCompanyId && assigneeAdapterType
        ? queryKeys.agents.adapterModels(effectiveCompanyId, assigneeAdapterType)
        : ["agents", "none", "adapter-models", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModels(effectiveCompanyId!, assigneeAdapterType!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && supportsAssigneeOverrides,
  });

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
          if (stagedFile.kind === "document") {
            const body = await stagedFile.file.text();
            await issuesApi.upsertDocument(issue.id, stagedFile.documentKey ?? "document", {
              title: stagedFile.documentKey === "plan" ? null : stagedFile.title ?? null,
              format: "markdown",
              body,
              baseRevisionId: null,
            });
          } else {
            await issuesApi.uploadAttachment(orgId, issue.id, stagedFile.file);
          }
        } catch {
          failures.push(stagedFile.file.name);
        }
      }

      return { issue, orgId, failures };
    },
    onSuccess: ({ issue, orgId, failures }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(orgId) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (failures.length > 0) {
        const prefix = (organizations.find((organization) => organization.id === orgId)?.issuePrefix ?? "").trim();
        const issueRef = issue.identifier ?? issue.id;
        pushToast({
          title: `Created ${issueRef} with upload warnings`,
          body: `${failures.length} staged ${failures.length === 1 ? "file" : "files"} could not be added.`,
          tone: "warn",
          action: prefix
            ? { label: `Open ${issueRef}`, href: `/${prefix}/issues/${issueRef}` }
            : undefined,
        });
      }
      clearIssueAutosave();
      deleteIssueDraft(activeSavedIssueDraftId);
      reset();
      closeNewIssue();
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
    (draft: IssueDraft) => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        saveIssueAutosave(draft);
      }, DEBOUNCE_MS);
    },
    [],
  );

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newIssueOpen) return;
    if (!hasMeaningfulIssueDraft({
      title,
      description,
      status,
      priority,
      labelIds: selectedLabelIds,
      assigneeValue,
      projectId,
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
      projectId,
      projectWorkspaceId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
    });
  }, [
    title,
    description,
    status,
    priority,
    selectedLabelIds,
    assigneeValue,
    projectId,
    projectWorkspaceId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    effectiveCompanyId,
    newIssueOpen,
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

    const savedDraft = readSavedIssueDraft(newIssueDefaults.draftId, selectedOrganizationId);
    const draft = savedDraft ?? readIssueAutosave(selectedOrganizationId);
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
        defaultAssigneeValue: assigneeValueFromSelection(newIssueDefaults),
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
      setProjectId(restoredProjectId);
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
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
    } else if (draft && hasMeaningfulIssueDraft(draft)) {
      const restoredValues = resolveDraftBackedNewIssueValues({
        defaults: newIssueDefaults,
        draft,
        defaultProjectId,
        defaultAssigneeValue: assigneeValueFromSelection(newIssueDefaults),
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
      setProjectId(restoredProjectId);
      setProjectWorkspaceId(draft.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(restoredProject));
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
    } else {
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      setTitle("");
      setDescription("");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setSelectedLabelIds(newIssueDefaults.labelIds ?? []);
      setLabelSearch("");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
    }
  }, [newIssueOpen, newIssueDefaults, orderedProjects, selectedOrganizationId]);

  useEffect(() => {
    if (!supportsAssigneeOverrides) {
      setAssigneeOptionsOpen(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      return;
    }

    const validThinkingValues =
      assigneeAdapterType === "codex_local"
        ? ISSUE_THINKING_EFFORT_OPTIONS.codex_local
        : assigneeAdapterType === "opencode_local"
          ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
          : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
    if (!validThinkingValues.some((option) => option.value === assigneeThinkingEffort)) {
      setAssigneeThinkingEffort("");
    }
  }, [supportsAssigneeOverrides, assigneeAdapterType, assigneeThinkingEffort]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("todo");
    setPriority("");
    setSelectedLabelIds([]);
    setLabelSearch("");
    setAssigneeValue("");
    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeOptionsOpen(false);
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setExpanded(false);
    setDialogCompanyId(null);
    setStagedFiles([]);
    setIsFileDragOver(false);
    setCompanyOpen(false);
    setActiveSavedIssueDraftId(null);
  }

  function handleCompanyChange(orgId: string) {
    if (orgId === effectiveCompanyId) return;
    setDialogCompanyId(orgId);
    setAssigneeValue("");
    setProjectId("");
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
      projectId,
      projectWorkspaceId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
    });
    if (!savedDraft) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
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

  function handleSubmit() {
    if (!effectiveCompanyId || !title.trim() || createIssue.isPending) return;
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
        projectId,
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
        if (isTextDocumentFile(file)) {
          const baseName = fileBaseName(file.name);
          const documentKey = createUniqueDocumentKey(slugifyDocumentKey(baseName), next);
          next.push({
            id: `${file.name}:${file.size}:${file.lastModified}:${documentKey}`,
            file,
            kind: "document",
            documentKey,
            title: titleizeFilename(baseName),
          });
          continue;
        }
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
          <span
            key={label.id}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border"
            style={{
              borderColor: label.color,
              backgroundColor: `${label.color}22`,
              color: pickTextColorForPillBg(label.color, 0.13),
            }}
          >
            {label.name}
          </span>
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
  const assigneeOptionsTitle =
    assigneeAdapterType === "claude_local"
      ? "Claude options"
      : assigneeAdapterType === "codex_local"
        ? "Codex options"
        : assigneeAdapterType === "opencode_local"
          ? "OpenCode options"
        : "Agent options";
  const thinkingEffortOptions =
    assigneeAdapterType === "codex_local"
      ? ISSUE_THINKING_EFFORT_OPTIONS.codex_local
      : assigneeAdapterType === "opencode_local"
        ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
      : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...currentUserAssigneeOption(currentUserId),
      ...sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: formatChatAgentLabel(agent),
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
  const canSaveDraft = hasMeaningfulIssueDraft({
    title,
    description,
    status,
    priority,
    labelIds: selectedLabelIds,
    assigneeValue,
    projectId,
    projectWorkspaceId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
  });
  const createIssueErrorMessage =
    createIssue.error instanceof Error ? createIssue.error.message : "Failed to create issue. Try again.";
  const stagedDocuments = stagedFiles.filter((file) => file.kind === "document");
  const stagedAttachments = stagedFiles.filter((file) => file.kind === "attachment");

  const handleProjectChange = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId);
    const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(nextProject));
  }, [orderedProjects]);
  const modelOverrideOptions = useMemo<InlineEntityOption[]>(
    () => {
      const models = resolveRuntimeModels(
        assigneeAdapterType ?? "",
        assigneeAgentRuntimeModels,
      );
      return [...models]
        .sort((a, b) => {
          const providerA = extractProviderIdWithFallback(a.id);
          const providerB = extractProviderIdWithFallback(b.id);
          const byProvider = providerA.localeCompare(providerB);
          if (byProvider !== 0) return byProvider;
          return a.id.localeCompare(b.id);
        })
        .map((model) => ({
          id: model.id,
          label: model.label,
          searchText: `${model.id} ${extractProviderIdWithFallback(model.id)}`,
        }));
    },
    [assigneeAdapterType, assigneeAgentRuntimeModels],
  );

  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open && !createIssue.isPending) closeNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          "p-0 gap-0 flex flex-col max-h-[calc(100dvh-2rem)]",
          expanded
            ? "sm:max-w-2xl h-[calc(100dvh-2rem)]"
            : "sm:max-w-lg"
        )}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (createIssue.isPending) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (createIssue.isPending) {
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
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity",
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
            <span>New issue</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              disabled={createIssue.isPending}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => closeNewIssue()}
              disabled={createIssue.isPending}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

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
            readOnly={createIssue.isPending}
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

        <div className="px-4 pb-2 shrink-0">
          <div className="overflow-x-auto overscroll-x-contain">
            <div className="inline-flex items-center gap-2 text-sm text-muted-foreground flex-wrap sm:flex-nowrap sm:min-w-max">
              <span>For</span>
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={assigneeValue}
                options={assigneeOptions}
                placeholder="Assignee"
                disablePortal
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                onChange={(value) => {
                  const nextAssignee = parseAssigneeValue(value);
                  if (nextAssignee.assigneeAgentId) {
                    trackRecentAssignee(nextAssignee.assigneeAgentId);
                  }
                  setAssigneeValue(value);
                }}
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
                      <>
                        <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">Assignee</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
              <span>in</span>
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={projectId}
                options={projectOptions}
                placeholder="Project"
                disablePortal
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                onChange={handleProjectChange}
                onConfirm={() => {
                  descriptionEditorRef.current?.focus();
                }}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={projectColorBackgroundStyle(currentProject.color)}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Project</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = orderedProjects.find((item) => item.id === option.id);
                  return (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={projectColorBackgroundStyle(project?.color)}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
          </div>
        </div>

        {supportsAssigneeOverrides && (
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
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">Model</div>
                  <InlineEntitySelector
                    value={assigneeModelOverride}
                    options={modelOverrideOptions}
                    placeholder="Default model"
                    disablePortal
                    noneLabel="Default model"
                    searchPlaceholder="Search models..."
                    emptyMessage="No models found."
                    onChange={setAssigneeModelOverride}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">Thinking effort</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {thinkingEffortOptions.map((option) => (
                      <button
                        key={option.value || "default"}
                        className={cn(
                          "px-2 py-1 rounded-md text-xs border border-border hover:bg-accent/50 transition-colors",
                          assigneeThinkingEffort === option.value && "bg-accent"
                        )}
                        onClick={() => setAssigneeThinkingEffort(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                {assigneeAdapterType === "claude_local" && (
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
                )}
              </div>
            )}
          </div>
        )}

        {/* Description */}
        <div
          className={cn("px-4 pb-2 overflow-y-auto min-h-0 border-t border-border/60 pt-3", expanded ? "flex-1" : "")}
          onDragEnter={handleFileDragEnter}
          onDragOver={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
        >
          <div
            className={cn(
              "rounded-md transition-colors",
              isFileDragOver && "bg-accent/20",
            )}
          >
            <MarkdownEditor
              ref={descriptionEditorRef}
              value={description}
              onChange={setDescription}
              placeholder="Add description..."
              bordered={false}
              mentions={mentionOptions}
              contentClassName={cn("text-sm text-muted-foreground pb-12", expanded ? "min-h-[220px]" : "min-h-[120px]")}
              imageUploadHandler={async (file) => {
                const asset = await uploadDescriptionImage.mutateAsync(file);
                return asset.contentPath;
              }}
            />
          </div>
          {stagedFiles.length > 0 ? (
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
                          disabled={createIssue.isPending}
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
                          disabled={createIssue.isPending}
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
                    <currentPriority.icon className={cn("h-3 w-3", currentPriority.color)} />
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
            <PopoverContent className="w-36 p-1" align="start">
              {priorities.map((p) => (
                <button
                  key={p.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    p.value === priority && "bg-accent"
                  )}
                  onClick={() => { setPriority(p.value); setPriorityOpen(false); }}
                >
                  <p.icon className={cn("h-3 w-3", p.color)} />
                  {p.label}
                </button>
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
                disabled={createIssue.isPending}
              >
                {labelsTrigger}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
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
              <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
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
            </PopoverContent>
          </Popover>

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
            disabled={createIssue.isPending}
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

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "text-muted-foreground disabled:opacity-100",
              !canSaveDraft && "disabled:border-border/40 disabled:bg-muted/20 disabled:text-muted-foreground/70",
            )}
            onClick={saveDraftIssue}
            disabled={createIssue.isPending || !canSaveDraft}
          >
            Save Draft
          </Button>
          <div className="flex items-center gap-3">
            <div className="min-h-5 text-right">
              {createIssue.isPending ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Creating issue...
                </span>
              ) : createIssue.isError ? (
                <span className="text-xs text-destructive">{createIssueErrorMessage}</span>
              ) : null}
            </div>
            <Button
              size="sm"
              className="min-w-[8.5rem] disabled:opacity-100"
              disabled={!title.trim() || createIssue.isPending}
              onClick={handleSubmit}
              aria-busy={createIssue.isPending}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{createIssue.isPending ? "Creating..." : "Create Issue"}</span>
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
