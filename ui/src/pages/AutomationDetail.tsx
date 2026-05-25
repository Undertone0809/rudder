import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Play,
  RefreshCw,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { automationsApi, type AutomationTriggerResponse, type RotateAutomationTriggerResponse } from "../api/automations";
import { heartbeatsApi } from "../api/heartbeats";
import { LiveRunWidget } from "../components/LiveRunWidget";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { organizationSkillsApi } from "../api/organizationSkills";
import { projectsApi } from "../api/projects";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import { buildAutomationTriggerPatch } from "../lib/automation-trigger-patch";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { buildMarkdownMentionOptions } from "../lib/markdown-mention-options";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { ScheduleEditor, describeSchedule } from "../components/ScheduleEditor";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { useDialog } from "../context/DialogContext";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { ActivityEvent, AutomationRunSummary, AutomationTrigger } from "@rudderhq/shared";
import { concurrencyPolicies, catchUpPolicies, signingModes, concurrencyPolicyDescriptions, catchUpPolicyDescriptions, SecretMessage, addUniqueId, removeId, autoResizeTextarea, formatActivityDetailValue, getActivityDetailString, humanizeToken, triggerKindLabel, runSourceLabel, getLocalTimezone, formatAutomationTimestamp, summarizeTrigger, automationRiskLabel, SidebarSection, SidebarRow, SidebarPropertyRow, SidebarSelectValue, TriggerEditor } from "./AutomationDetail.parts";

export function AutomationDetail() {
  const { automationId } = useParams<{ automationId: string }>();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const { confirm } = useDialog();
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const hydratedAutomationIdRef = useRef<string | null>(null);
  const lastSubmittedEditKeyRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const copiedSecretResetRef = useRef<number | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [copiedSecretField, setCopiedSecretField] = useState<"url" | "secret" | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [newTriggerOpen, setNewTriggerOpen] = useState(false);
  const [savingTriggerIds, setSavingTriggerIds] = useState<string[]>([]);
  const [deletingTriggerIds, setDeletingTriggerIds] = useState<string[]>([]);
  const [rotatingTriggerIds, setRotatingTriggerIds] = useState<string[]>([]);
  const [triggerSaveErrors, setTriggerSaveErrors] = useState<Record<string, string>>({});
  const [newTrigger, setNewTrigger] = useState({
    kind: "schedule",
    cronExpression: "0 10 * * *",
    signingMode: "bearer",
    replayWindowSec: "300",
  });
  const [editDraft, setEditDraft] = useState({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    outputMode: "track_issue",
    chatConversationId: "",
  });

  const { data: automation, isLoading, error } = useQuery({
    queryKey: queryKeys.automations.detail(automationId!),
    queryFn: () => automationsApi.get(automationId!),
    enabled: !!automationId,
  });
  const activeIssueId = automation?.activeIssue?.id;
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(activeIssueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(activeIssueId!),
    enabled: !!activeIssueId,
    refetchInterval: 3000,
  });
  const hasLiveRun = (liveRuns ?? []).length > 0;
  const { data: automationRuns } = useQuery({
    queryKey: queryKeys.automations.runs(automationId!),
    queryFn: () => automationsApi.listRuns(automationId!),
    enabled: !!automationId,
    refetchInterval: hasLiveRun ? 3000 : false,
  });
  const relatedActivityIds = useMemo(
    () => ({
      triggerIds: automation?.triggers.map((trigger) => trigger.id) ?? [],
      runIds: automationRuns?.map((run) => run.id) ?? [],
    }),
    [automation?.triggers, automationRuns],
  );
  const { data: activity } = useQuery({
    queryKey: [
      ...queryKeys.automations.activity(selectedOrganizationId!, automationId!),
      relatedActivityIds.triggerIds.join(","),
      relatedActivityIds.runIds.join(","),
    ],
    queryFn: () => automationsApi.activity(selectedOrganizationId!, automationId!, relatedActivityIds),
    enabled: !!selectedOrganizationId && !!automationId && !!automation,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId!),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: assigneeOrganizationSkills } = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId) && Boolean(editDraft.assigneeAgentId),
  });
  const { data: assigneeSkillSnapshot } = useQuery({
    queryKey: queryKeys.agents.skills(editDraft.assigneeAgentId || "__none__"),
    queryFn: () => agentsApi.skills(editDraft.assigneeAgentId, selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId) && Boolean(editDraft.assigneeAgentId),
  });

  const automationDefaults = useMemo(
    () =>
      automation
        ? {
            title: automation.title,
            description: automation.description ?? "",
            projectId: automation.projectId ?? "",
            assigneeAgentId: automation.assigneeAgentId,
            priority: automation.priority,
            concurrencyPolicy: automation.concurrencyPolicy,
            catchUpPolicy: automation.catchUpPolicy,
            outputMode: automation.outputMode,
            chatConversationId: automation.chatConversationId ?? "",
          }
        : null,
    [automation],
  );
  const isEditDirty = useMemo(() => {
    if (!automationDefaults) return false;
    return (
      editDraft.title !== automationDefaults.title ||
      editDraft.description !== automationDefaults.description ||
      editDraft.projectId !== automationDefaults.projectId ||
      editDraft.assigneeAgentId !== automationDefaults.assigneeAgentId ||
      editDraft.priority !== automationDefaults.priority ||
      editDraft.concurrencyPolicy !== automationDefaults.concurrencyPolicy ||
      editDraft.catchUpPolicy !== automationDefaults.catchUpPolicy ||
      editDraft.outputMode !== automationDefaults.outputMode ||
      editDraft.chatConversationId !== automationDefaults.chatConversationId
    );
  }, [editDraft, automationDefaults]);
  const canAutoSaveAutomation = Boolean(
    editDraft.title.trim() &&
    editDraft.assigneeAgentId,
  );
  const editDraftKey = useMemo(
    () => JSON.stringify({
      title: editDraft.title,
      description: editDraft.description.trim() || null,
      projectId: editDraft.projectId || null,
      assigneeAgentId: editDraft.assigneeAgentId,
      priority: editDraft.priority,
      concurrencyPolicy: editDraft.concurrencyPolicy,
      catchUpPolicy: editDraft.catchUpPolicy,
      outputMode: editDraft.outputMode,
      chatConversationId: editDraft.outputMode === "chat_output" ? editDraft.chatConversationId || null : null,
    }),
    [editDraft],
  );

  useEffect(() => {
    if (!automation) return;
    setBreadcrumbs([{ label: "Automations", href: "/automations" }, { label: automation.title }]);
    if (!automationDefaults) return;

    const changedAutomation = hydratedAutomationIdRef.current !== automation.id;
    if (changedAutomation || !isEditDirty) {
      setEditDraft(automationDefaults);
      hydratedAutomationIdRef.current = automation.id;
      if (changedAutomation) lastSubmittedEditKeyRef.current = null;
    }
  }, [automation, automationDefaults, isEditDirty, setBreadcrumbs]);

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [editDraft.title, automation?.id]);

  useEffect(() => () => {
    if (copiedSecretResetRef.current) {
      window.clearTimeout(copiedSecretResetRef.current);
    }
  }, []);

  const copySecretValue = async (label: string, value: string, field: "url" | "secret") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedSecretField(field);
      if (copiedSecretResetRef.current) {
        window.clearTimeout(copiedSecretResetRef.current);
      }
      copiedSecretResetRef.current = window.setTimeout(() => {
        setCopiedSecretField((current) => current === field ? null : current);
      }, 1800);
      pushToast({ title: `${label} copied`, tone: "success" });
    } catch (error) {
      pushToast({
        title: `Failed to copy ${label.toLowerCase()}`,
        body: error instanceof Error ? error.message : "Clipboard access was denied.",
        tone: "error",
      });
    }
  };

  const saveAutomation = useMutation({
    mutationFn: (draft: typeof editDraft) => {
      return automationsApi.update(automationId!, {
        ...draft,
        projectId: draft.projectId || null,
        description: draft.description.trim() || null,
        chatConversationId: null,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
    },
    onError: (error) => {
      lastSubmittedEditKeyRef.current = null;
      pushToast({
        title: "Failed to save automation",
        body: error instanceof Error ? error.message : "Rudder could not save the automation.",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!automation || !isEditDirty || !canAutoSaveAutomation || saveAutomation.isPending) return;
    if (lastSubmittedEditKeyRef.current === editDraftKey) return;

    const draftSnapshot = editDraft;
    const timeoutId = window.setTimeout(() => {
      lastSubmittedEditKeyRef.current = editDraftKey;
      saveAutomation.mutate(draftSnapshot);
    }, 700);

    return () => window.clearTimeout(timeoutId);
  }, [
    automation,
    canAutoSaveAutomation,
    editDraft,
    editDraftKey,
    isEditDirty,
    saveAutomation,
  ]);

  const runAutomation = useMutation({
    mutationFn: () => automationsApi.run(automationId!),
    onSuccess: async (run) => {
      pushToast({ title: "Automation run started", tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
      if (run.linkedChatConversationId && run.lastChatMessageId) {
        navigate(`/messenger/chat/${run.linkedChatConversationId}`);
      }
    },
    onError: (error) => {
      pushToast({
        title: "Automation run failed",
        body: error instanceof Error ? error.message : "Rudder could not start the automation run.",
        tone: "error",
      });
    },
  });

  const deleteAutomation = useMutation({
    mutationFn: () => automationsApi.delete(automationId!),
    onSuccess: () => {
      navigate("/automations");
      pushToast({ title: "Automation deleted", tone: "success" });
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete automation",
        body: error instanceof Error ? error.message : "Rudder could not delete the automation.",
        tone: "error",
      });
    },
  });

  const updateAutomationStatus = useMutation({
    mutationFn: (status: string) => automationsApi.update(automationId!, { status }),
    onSuccess: async (_data, status) => {
      pushToast({
        title: "Automation saved",
        body: status === "paused" ? "Automation paused." : "Automation enabled.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update automation",
        body: error instanceof Error ? error.message : "Rudder could not update the automation.",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!selectedOrganizationId || !automation) {
      setHeaderActions(null);
      return;
    }

    const isEnabled = automation.status === "active";
    const statusActionLabel = isEnabled ? "Disable automation" : "Enable automation";

    setHeaderActions(
      <>
        <div className="flex h-8 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground">
          <ToggleSwitch
            checked={isEnabled}
            size="md"
            tone="success"
            aria-label={statusActionLabel}
            title={statusActionLabel}
            disabled={updateAutomationStatus.isPending}
            onClick={() => updateAutomationStatus.mutate(isEnabled ? "paused" : "active")}
          />
          <span className="min-w-5 tabular-nums">{isEnabled ? "On" : "Off"}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          aria-label="Delete automation"
          title="Delete automation"
          disabled={deleteAutomation.isPending}
          onClick={async () => {
            const confirmed = await confirm({
              title: `Delete "${automation.title}"?`,
              description: "This will permanently remove the automation and stop future runs.",
              confirmLabel: "Delete",
              tone: "destructive",
            });
            if (!confirmed) return;
            deleteAutomation.mutate();
          }}
        >
          {deleteAutomation.isPending ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="border-white/70 bg-white px-2 text-black shadow-none hover:bg-white/90 min-[420px]:min-w-[92px] min-[420px]:px-3"
          aria-label="Run now"
          disabled={runAutomation.isPending || !isEnabled}
          onClick={() => runAutomation.mutate()}
        >
          <Play className="h-3.5 w-3.5" />
          <span className="hidden min-[420px]:inline">{runAutomation.isPending ? "Starting..." : "Run now"}</span>
        </Button>
      </>,
    );

    return () => setHeaderActions(null);
  }, [
    automation?.id,
    automation?.status,
    automation?.title,
    deleteAutomation.isPending,
    runAutomation.isPending,
    selectedOrganizationId,
    setHeaderActions,
    updateAutomationStatus.isPending,
  ]);

  const createTrigger = useMutation({
    mutationFn: async (): Promise<AutomationTriggerResponse> => {
      const existingOfKind = (automation?.triggers ?? []).filter((t) => t.kind === newTrigger.kind).length;
      const autoLabel = existingOfKind > 0 ? `${newTrigger.kind}-${existingOfKind + 1}` : newTrigger.kind;
      return automationsApi.createTrigger(automationId!, {
        kind: newTrigger.kind,
        label: autoLabel,
        ...(newTrigger.kind === "schedule"
          ? { cronExpression: newTrigger.cronExpression.trim(), timezone: getLocalTimezone() }
          : {}),
        ...(newTrigger.kind === "webhook"
          ? {
            signingMode: newTrigger.signingMode,
            replayWindowSec: Number(newTrigger.replayWindowSec || "300"),
          }
          : {}),
      });
    },
    onSuccess: async (result) => {
      if (result.secretMaterial) {
        setSecretMessage({
          title: "Webhook trigger created",
          webhookUrl: result.secretMaterial.webhookUrl,
          webhookSecret: result.secretMaterial.webhookSecret,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
      setNewTriggerOpen(false);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to add trigger",
        body: error instanceof Error ? error.message : "Rudder could not create the trigger.",
        tone: "error",
      });
    },
  });

  const updateTrigger = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => automationsApi.updateTrigger(id, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update trigger",
        body: error instanceof Error ? error.message : "Rudder could not update the trigger.",
        tone: "error",
      });
    },
  });
  const saveTriggerDraft = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setSavingTriggerIds((current) => addUniqueId(current, id));
      setTriggerSaveErrors((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      updateTrigger.mutate(
        { id, patch },
        {
          onError: (error) => {
            setTriggerSaveErrors((current) => ({
              ...current,
              [id]: error instanceof Error ? error.message : "Rudder could not update the trigger.",
            }));
          },
          onSettled: () => {
            setSavingTriggerIds((current) => removeId(current, id));
          },
        },
      );
    },
    [updateTrigger],
  );

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => automationsApi.deleteTrigger(id),
    onSuccess: async (_result, id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
      setTriggerSaveErrors((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete trigger",
        body: error instanceof Error ? error.message : "Rudder could not delete the trigger.",
        tone: "error",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateAutomationTriggerResponse> => automationsApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: "Webhook secret rotated",
        webhookUrl: result.secretMaterial.webhookUrl,
        webhookSecret: result.secretMaterial.webhookSecret,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to rotate webhook secret",
        body: error instanceof Error ? error.message : "Rudder could not rotate the webhook secret.",
        tone: "error",
      });
    },
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [automation?.id]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: formatChatAgentLabel(agent),
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const currentAssignee = editDraft.assigneeAgentId ? agentById.get(editDraft.assigneeAgentId) ?? null : null;
  const currentProject = editDraft.projectId ? projectById.get(editDraft.projectId) ?? null : null;
  const triggerById = useMemo(
    () => new Map((automation?.triggers ?? []).map((trigger) => [trigger.id, trigger])),
    [automation?.triggers],
  );
  const skillMentionOptions = useMemo(
    () => buildAgentSkillMentionOptions({
      agent: currentAssignee,
      orgUrlKey: selectedOrganization?.urlKey ?? "organization",
      organizationSkills: assigneeOrganizationSkills,
      skillSnapshot: assigneeSkillSnapshot,
    }),
    [assigneeOrganizationSkills, assigneeSkillSnapshot, currentAssignee, selectedOrganization?.urlKey],
  );
  const mentionOptions = useMemo(
    () => buildMarkdownMentionOptions({
      agents,
      projects,
      issues,
      skillMentionOptions,
    }),
    [agents, issues, projects, skillMentionOptions],
  );
  const automationActivityItems = useMemo(() => {
    const runIds = new Set((automationRuns ?? []).map((run) => run.id));
    const items: Array<{
      id: string;
      title: string;
      details: ReactNode[];
      createdAt: Date | string;
      sortAt: number;
    }> = [];

    const detailText = (text: string | null | undefined, key: string) =>
      text ? <span key={key}>{text}</span> : null;

    const describeAgent = (agentId: string | null) => {
      if (!agentId) return null;
      const agent = agentById.get(agentId);
      if (agent) return formatChatAgentLabel(agent);
      if (automation?.assignee?.id === agentId) return automation.assignee.name;
      return "Selected agent";
    };

    const describeProject = (projectId: string | null) => {
      if (!projectId) return null;
      const project = projectById.get(projectId);
      if (project) return project.name;
      if (automation?.project?.id === projectId) return automation.project.name;
      return "Selected project";
    };

    const describeTrigger = (
      triggerId: string | null | undefined,
      fallback: Pick<AutomationTrigger, "kind" | "cronExpression" | "label"> | null,
    ) => {
      const trigger = triggerId ? triggerById.get(triggerId) : null;
      const source = trigger ?? fallback;
      if (!source) return null;
      const summary = summarizeTrigger(source);
      const kind = triggerKindLabel(source.kind);
      return summary && summary !== kind ? `${kind}: ${summary}` : kind;
    };

    const formatRunActivityTitle = (source: string, status: string) => {
      const sourceLabel = runSourceLabel(source);
      switch (status) {
        case "issue_created":
          return `${sourceLabel} opened an execution issue`;
        case "running":
          return `${sourceLabel} is in progress`;
        case "failed":
          return `${sourceLabel} failed`;
        case "coalesced":
          return `${sourceLabel} joined an active execution`;
        case "skipped":
          return `${sourceLabel} skipped`;
        case "completed":
          return `${sourceLabel} completed`;
        default:
          return `${sourceLabel} ${humanizeToken(status)}`;
      }
    };

    const formatTriggerContext = (triggerDescription: string | null) => {
      if (!triggerDescription) return null;
      return triggerDescription.startsWith("Schedule trigger: ")
        ? `for ${triggerDescription.replace("Schedule trigger: ", "")}`
        : triggerDescription;
    };

    const pushEventItem = (event: ActivityEvent) => {
      const details = event.details ?? null;
      const eventDetails: ReactNode[] = [];
      let title = event.action.replaceAll(".", " ");
      let useFallbackDetail = false;

      if (event.action === "automation.created") {
        const createdTitle = getActivityDetailString(details, "title");
        title = createdTitle
          ? `Created "${createdTitle}"`
          : "Created automation";
        eventDetails.push(detailText(`Assigned to ${describeAgent(getActivityDetailString(details, "assigneeAgentId")) ?? "agent"}`, "assignee"));
      } else if (event.action === "automation.updated") {
        const updatedTitle = getActivityDetailString(details, "title");
        title = updatedTitle
          ? `Updated automation settings for "${updatedTitle}"`
          : "Updated automation settings";
      } else if (event.action === "automation.deleted") {
        const deletedTitle = getActivityDetailString(details, "title");
        title = deletedTitle
          ? `Deleted "${deletedTitle}"`
          : "Deleted automation";
      } else if (event.action === "automation.trigger_created") {
        const trigger = triggerById.get(event.entityId);
        const triggerKind = trigger?.kind ?? getActivityDetailString(details, "kind");
        title = `Added ${triggerKindLabel(triggerKind).toLowerCase()}`;
        eventDetails.push(detailText(
          formatTriggerContext(describeTrigger(event.entityId, {
            kind: getActivityDetailString(details, "kind") ?? "trigger",
            cronExpression: trigger?.cronExpression ?? null,
            label: trigger?.label ?? null,
          })),
          "trigger",
        ));
      } else if (event.action === "automation.trigger_updated") {
        const trigger = triggerById.get(event.entityId);
        const triggerKind = trigger?.kind ?? getActivityDetailString(details, "kind");
        title = `Updated ${triggerKindLabel(triggerKind).toLowerCase()}`;
        eventDetails.push(detailText(
          formatTriggerContext(describeTrigger(event.entityId, {
            kind: getActivityDetailString(details, "kind") ?? "trigger",
            cronExpression: null,
            label: null,
          })),
          "trigger",
        ));
      } else if (event.action === "automation.trigger_deleted") {
        title = `Removed ${triggerKindLabel(getActivityDetailString(details, "kind")).toLowerCase()}`;
      } else if (event.action === "automation.trigger_secret_rotated") {
        title = "Webhook secret rotated";
      } else if (event.action === "automation.run_triggered") {
        const source = getActivityDetailString(details, "source") ?? "run";
        const status = getActivityDetailString(details, "status") ?? "started";
        title = formatRunActivityTitle(source, status);
        const triggerDescription = describeTrigger(getActivityDetailString(details, "triggerId"), null);
        eventDetails.push(detailText(formatTriggerContext(triggerDescription), "trigger"));
      } else {
        useFallbackDetail = true;
        Object.entries(details ?? {})
          .filter(([key]) => !["automationId", "triggerId", "assigneeAgentId", "projectId"].includes(key))
          .slice(0, 2)
          .forEach(([key, value]) => {
            eventDetails.push(
              <span key={key}>
                <span className="text-muted-foreground/70">{key.replaceAll("_", " ")}:</span>{" "}
                {formatActivityDetailValue(value)}
              </span>,
            );
          });
      }

      const resolvedDetails = eventDetails.filter(Boolean);
      items.push({
        id: `event:${event.id}`,
        title,
        details: resolvedDetails.length > 0 || !useFallbackDetail
          ? resolvedDetails
          : [<span key="fallback">Activity recorded</span>],
        createdAt: event.createdAt,
        sortAt: new Date(event.createdAt).getTime(),
      });
    };

    for (const run of (automationRuns ?? automation?.recentRuns ?? []) as AutomationRunSummary[]) {
      const details: ReactNode[] = [];
      const triggerDescription = describeTrigger(
        run.triggerId,
        run.trigger ? { ...run.trigger, cronExpression: null } : null,
      );
      const triggerContext = formatTriggerContext(triggerDescription);
      if (triggerContext) details.push(<span key="trigger">{triggerContext}</span>);
      if (run.linkedIssue) {
        details.push(
          <Link key="issue" to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className="whitespace-nowrap font-medium text-foreground hover:underline">
            {run.linkedIssue.identifier ?? run.linkedIssue.title}
          </Link>,
        );
      }
      if (run.linkedChatConversation) {
        details.push(
          <Link key="chat" to={`/messenger/chat/${run.linkedChatConversation.id}`} className="whitespace-nowrap font-medium text-foreground hover:underline">
            {run.linkedChatConversation.title}
          </Link>,
        );
      }
      if (run.failureReason) details.push(<span key="failure">{run.failureReason}</span>);

      items.push({
        id: `run:${run.id}`,
        title: formatRunActivityTitle(run.source, run.status),
        details,
        createdAt: run.triggeredAt,
        sortAt: new Date(run.triggeredAt).getTime(),
      });
    }

    for (const event of activity ?? []) {
      if (event.action === "automation.updated") {
        continue;
      }
      if (event.action === "automation.run_triggered" && event.entityType === "automation_run" && runIds.has(event.entityId)) {
        continue;
      }
      pushEventItem(event);
    }

    return items.sort((a, b) => b.sortAt - a.sortAt).slice(0, 10);
  }, [activity, agentById, automation, automationRuns, projectById, triggerById]);

  if (!selectedOrganizationId) {
    return <EmptyState icon={Repeat} message="Select an organization to view automations." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error || !automation) {
    return (
      <p className="pt-6 text-sm text-destructive">
        {error instanceof Error ? error.message : "Automation not found"}
      </p>
    );
  }

  const automationEnabled = automation.status === "active";
  const automationLabel = automationEnabled ? "Active" : "Paused";
  const editSyncLabel = saveAutomation.isPending
    ? "Saving..."
    : !canAutoSaveAutomation
      ? "Needs fields"
      : isEditDirty
        ? "Autosaving..."
        : "In sync";
  const editSyncClassName = saveAutomation.isPending || isEditDirty
    ? "text-amber-600"
    : "text-muted-foreground";
  const nextTrigger = [...automation.triggers]
    .filter((trigger) => trigger.enabled)
    .sort((a, b) => {
      const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    })[0] ?? automation.triggers[0] ?? null;
  const latestRun = automationRuns?.[0] ?? automation.recentRuns[0] ?? null;
  const activeIssueLabel = automation.activeIssue?.identifier ?? automation.activeIssue?.id.slice(0, 8) ?? null;
  const canCreateTrigger = newTrigger.kind !== "schedule" || newTrigger.cronExpression.trim().length > 0;
  const riskLabel = automationRiskLabel({
    status: automation.status,
    triggerCount: automation.triggers.length,
    hasAssignee: Boolean(editDraft.assigneeAgentId),
    hasLiveRun,
    latestRunStatus: latestRun?.status,
  });

  return (
    <div className="pb-8" data-testid="automation-detail-shell">
      {secretMessage && (
        <div className="relative mb-4 rounded-md border border-blue-500/30 bg-blue-500/5 p-4 pr-12 text-sm">
          <div className="mb-3">
            <p className="font-medium">{secretMessage.title}</p>
            <p className="text-xs text-muted-foreground">Save this now. Rudder will not show the secret value again.</p>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute right-4 top-4"
            aria-label="Dismiss secret notice"
            onClick={() => {
              setSecretMessage(null);
              setCopiedSecretField(null);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input value={secretMessage.webhookUrl} readOnly className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook URL", secretMessage.webhookUrl, "url")}>
                {copiedSecretField === "url" ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                {copiedSecretField === "url" ? "Copied" : "URL"}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input value={secretMessage.webhookSecret} readOnly className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook secret", secretMessage.webhookSecret, "secret")}>
                {copiedSecretField === "secret" ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                {copiedSecretField === "secret" ? "Copied" : "Secret"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 px-4 pt-3 sm:px-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:px-6 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <main className="min-w-0 space-y-6">
          <section className="max-w-none space-y-3">
            <textarea
              ref={titleInputRef}
              className="min-h-[34px] w-full resize-none overflow-hidden bg-transparent text-[1.45rem] font-semibold leading-tight outline-none placeholder:text-muted-foreground/50 sm:text-[1.6rem]"
              placeholder="Automation title"
              rows={1}
              value={editDraft.title}
              onChange={(event) => {
                setEditDraft((current) => ({ ...current, title: event.target.value }));
                autoResizeTextarea(event.target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  descriptionEditorRef.current?.focus();
                  return;
                }
                if (event.key === "Tab" && !event.shiftKey) {
                  event.preventDefault();
                  if (editDraft.assigneeAgentId) {
                    if (editDraft.projectId) {
                      descriptionEditorRef.current?.focus();
                    } else {
                      projectSelectorRef.current?.focus();
                    }
                  } else {
                    assigneeSelectorRef.current?.focus();
                  }
                }
              }}
            />

            <div
              data-testid="automation-overview-strip"
              className="border-y border-border/60 bg-transparent py-2.5"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn(
                    "h-2 w-2 rounded-full",
                    automationEnabled ? "bg-emerald-500" : "bg-muted-foreground/45",
                  )} />
                  <span className="text-foreground">{automationLabel}</span>
                </span>
                {hasLiveRun ? (
                  <span className="inline-flex items-center gap-1.5 text-blue-700 dark:text-blue-300">
                    <span className="h-2 w-2 rounded-full bg-blue-500" />
                    In progress
                  </span>
                ) : null}
                <span className="min-w-0">
                  <span className="text-muted-foreground">Repeats</span>{" "}
                  <span className="text-foreground">{summarizeTrigger(nextTrigger)}</span>
                </span>
                <span className="min-w-0">
                  <span className="text-muted-foreground">Next</span>{" "}
                  <span className="text-foreground">{formatAutomationTimestamp(nextTrigger?.nextRunAt, "-")}</span>
                </span>
                {automation.activeIssue && activeIssueLabel ? (
                  <span className="min-w-0">
                    <span className="text-muted-foreground">Issue</span>{" "}
                      <Link
                        to={`/issues/${activeIssueLabel}`}
                        className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        {activeIssueLabel}
                      </Link>
                  </span>
                ) : null}
              </div>
            </div>

            <MarkdownEditor
              ref={descriptionEditorRef}
              value={editDraft.description}
              onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
              mentions={mentionOptions}
              placeholder="Add instructions..."
              bordered
              className="bg-background/40"
              contentClassName="min-h-[180px] text-[15px] leading-7 text-foreground/90 md:min-h-[240px]"
            />
          </section>

          <section aria-label="Activity" className="space-y-3 border-t border-border/70 pt-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Activity</span>
            </div>
            {hasLiveRun && activeIssueId && automation ? (
              <LiveRunWidget issueId={activeIssueId} orgId={automation.orgId} />
            ) : null}
            {automationActivityItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">No activity yet.</p>
            ) : (
              <div data-testid="automation-activity-list" className="relative space-y-1 before:absolute before:bottom-2 before:left-[7.5px] before:top-2 before:w-px before:bg-border/70">
                {automationActivityItems.map((item) => (
                  <div
                    key={item.id}
                    data-testid="automation-activity-row"
                    className="grid min-h-8 grid-cols-[16px_minmax(0,1fr)] gap-x-2 rounded-sm py-1 text-xs text-muted-foreground sm:grid-cols-[16px_minmax(0,1fr)_auto] sm:items-center"
                  >
                    <span aria-hidden="true" className="relative z-10 row-span-2 flex h-full min-h-6 w-4 items-start justify-center pt-[7px] sm:row-span-1 sm:items-center sm:pt-0">
                      <span className="h-2 w-2 rounded-full border border-background bg-muted-foreground/40 shadow-[0_0_0_2px_hsl(var(--background))]" />
                    </span>
                    <span data-testid="automation-activity-summary" className="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden whitespace-nowrap">
                      <span className="min-w-0 truncate text-foreground/90">{item.title}</span>
                      {item.details.length > 0 && (
                        <span
                          data-testid="automation-activity-details"
                          className="inline-flex min-w-0 items-baseline gap-x-1.5 overflow-hidden text-muted-foreground"
                        >
                          {item.details.map((detail, i) => (
                            <span key={i} className="min-w-0 truncate">
                              {i > 0 && <span className="mr-1.5 text-border">·</span>}
                              {detail}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span data-testid="automation-activity-time" className="col-start-2 shrink-0 text-muted-foreground/70 sm:col-start-auto">
                      {timeAgo(item.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>

        <aside className="min-w-0 border-t border-border/70 pt-4 lg:sticky lg:top-20 lg:self-start lg:border-t-0 lg:pt-0">
          <div data-testid="automation-configuration-card" className="min-w-0 space-y-6 rounded-md border border-border/70 bg-card/85 p-4 shadow-sm">
            <SidebarSection title="Configuration">
              <SidebarPropertyRow label="Assignee">
                <div data-testid="automation-detail-agent-control" className="min-w-0 flex-1">
                  <InlineEntitySelector
                    ref={assigneeSelectorRef}
                    value={editDraft.assigneeAgentId}
                    options={assigneeOptions}
                    placeholder="Select assignee"
                    noneLabel="No assignee"
                    searchPlaceholder="Search assignees..."
                    emptyMessage="No assignees found."
                    className="-mx-1 min-h-7 w-full justify-between border-0 bg-transparent px-1 py-0.5 text-sm font-medium shadow-none hover:bg-accent/50"
                    onChange={(assigneeAgentId) => {
                      if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                      setEditDraft((current) => ({ ...current, assigneeAgentId }));
                    }}
                    onConfirm={() => {
                      if (editDraft.projectId) {
                        descriptionEditorRef.current?.focus();
                      } else {
                        projectSelectorRef.current?.focus();
                      }
                    }}
                    renderTriggerValue={(option) =>
                      option ? (
                        <SidebarSelectValue>
                          {currentAssignee ? (
                            <>
                              <AgentIcon icon={currentAssignee.icon} role={currentAssignee.role} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate">{option.label}</span>
                            </>
                          ) : (
                            <span className="truncate">{option.label}</span>
                          )}
                        </SidebarSelectValue>
                      ) : (
                        <SidebarSelectValue>
                          <span className="text-muted-foreground">Select assignee</span>
                        </SidebarSelectValue>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const assignee = agentById.get(option.id);
                      return (
                        <>
                          {assignee ? <AgentIcon icon={assignee.icon} role={assignee.role} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                          <span className="truncate">{option.label}</span>
                        </>
                      );
                    }}
                  />
                </div>
              </SidebarPropertyRow>

              <SidebarPropertyRow label="Output">
                <Select
                  value={editDraft.outputMode}
                  onValueChange={(outputMode) => setEditDraft((current) => ({
                    ...current,
                    outputMode,
                    chatConversationId: outputMode === "chat_output" ? current.chatConversationId : "",
                  }))}
                >
                  <SelectTrigger size="sm" className="-mx-1 h-7 w-fit border-0 bg-transparent px-1 py-0.5 text-sm shadow-none hover:bg-accent/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="track_issue">Track as issue</SelectItem>
                    <SelectItem value="chat_output">Send to chat</SelectItem>
                  </SelectContent>
                </Select>
              </SidebarPropertyRow>
              <SidebarPropertyRow label="Repeats">
                <span className="min-w-0 truncate text-sm text-foreground" title={summarizeTrigger(nextTrigger)}>
                  {summarizeTrigger(nextTrigger)}
                </span>
              </SidebarPropertyRow>

              <SidebarPropertyRow label="Next run">
                <span className="min-w-0 truncate text-sm text-muted-foreground" title={formatAutomationTimestamp(nextTrigger?.nextRunAt, "-")}>
                  {formatAutomationTimestamp(nextTrigger?.nextRunAt, "-")}
                </span>
              </SidebarPropertyRow>

              <SidebarPropertyRow label="Project">
                <div data-testid="automation-detail-project-control" className="min-w-0 flex-1">
                  <InlineEntitySelector
                    ref={projectSelectorRef}
                    value={editDraft.projectId}
                    options={projectOptions}
                    placeholder="No project"
                    noneLabel="No project"
                    searchPlaceholder="Search projects..."
                    emptyMessage="No projects found."
                    className="-mx-1 min-h-7 w-full justify-between border-0 bg-transparent px-1 py-0.5 text-sm font-medium shadow-none hover:bg-accent/50"
                    onChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}
                    onConfirm={() => descriptionEditorRef.current?.focus()}
                    renderTriggerValue={(option) =>
                      option && currentProject ? (
                        <SidebarSelectValue>
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-sm"
                            style={projectColorBackgroundStyle(currentProject.color)}
                          />
                          <span className="truncate">{option.label}</span>
                        </SidebarSelectValue>
                      ) : (
                        <SidebarSelectValue>
                          <span className="text-muted-foreground">No project</span>
                        </SidebarSelectValue>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const project = projectById.get(option.id);
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
              </SidebarPropertyRow>
            </SidebarSection>

            <Collapsible
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              data-testid="automation-delivery-rules-section"
              className="overflow-hidden rounded-md border border-border/70 bg-background/35"
            >
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span>Delivery rules</span>
                {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t border-border/60 p-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Concurrency</Label>
                    <Select
                      value={editDraft.concurrencyPolicy}
                      onValueChange={(concurrencyPolicy) => setEditDraft((current) => ({ ...current, concurrencyPolicy }))}
                    >
                      <SelectTrigger size="sm" className="w-full bg-background/60">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {concurrencyPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-4 text-muted-foreground">{concurrencyPolicyDescriptions[editDraft.concurrencyPolicy]}</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Catch-up</Label>
                    <Select
                      value={editDraft.catchUpPolicy}
                      onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}
                    >
                      <SelectTrigger size="sm" className="w-full bg-background/60">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catchUpPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-4 text-muted-foreground">{catchUpPolicyDescriptions[editDraft.catchUpPolicy]}</p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            <SidebarSection title="Triggers">
              <Popover open={newTriggerOpen} onOpenChange={setNewTriggerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="automation-trigger-menu-trigger group w-full justify-center rounded-md bg-background/55 shadow-none"
                    data-testid="automation-add-trigger-button"
                  >
                    Add trigger
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  data-testid="automation-add-trigger-card"
                  align="end"
                  side="left"
                  sideOffset={8}
                  className="automation-trigger-menu-content glass-popover w-[min(320px,calc(100vw-2rem))] space-y-3 rounded-md p-3 text-foreground"
                >
                  <div className="px-1 text-sm font-medium text-muted-foreground">Schedule</div>
                  <ScheduleEditor
                    variant="compact"
                    value={newTrigger.cronExpression}
                    onChange={(cronExpression) => setNewTrigger((current) => ({ ...current, kind: "schedule", cronExpression }))}
                  />
                  <Button
                    className="w-full justify-center"
                    size="sm"
                    onClick={() => createTrigger.mutate()}
                    disabled={createTrigger.isPending || !canCreateTrigger}
                  >
                    {createTrigger.isPending ? "Adding..." : "Create trigger"}
                  </Button>
                </PopoverContent>
              </Popover>

              <div data-testid="automation-triggers-list" className="space-y-3">
                {automation.triggers.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border/80 px-3 py-4 text-sm text-muted-foreground">
                    No triggers configured yet.
                  </div>
                ) : (
                  automation.triggers.map((trigger) => (
                    <TriggerEditor
                      key={trigger.id}
                      trigger={trigger}
                      onSave={saveTriggerDraft}
                      onRotate={(id) => {
                        setRotatingTriggerIds((current) => addUniqueId(current, id));
                        rotateTrigger.mutate(id, {
                          onSettled: () => setRotatingTriggerIds((current) => removeId(current, id)),
                        });
                      }}
                      onDelete={(id) => {
                        setDeletingTriggerIds((current) => addUniqueId(current, id));
                        deleteTrigger.mutate(id, {
                          onSettled: () => setDeletingTriggerIds((current) => removeId(current, id)),
                        });
                      }}
                      isSaving={savingTriggerIds.includes(trigger.id)}
                      isDeleting={deletingTriggerIds.includes(trigger.id)}
                      isRotating={rotatingTriggerIds.includes(trigger.id)}
                      saveError={triggerSaveErrors[trigger.id] ?? null}
                    />
                  ))
                )}
              </div>
            </SidebarSection>

            <SidebarSection title="Run status">
              <SidebarRow label="Last ran">
                <span className="truncate">{latestRun ? timeAgo(latestRun.triggeredAt) : "-"}</span>
              </SidebarRow>
              <SidebarRow label="Edits">
                <span className={editSyncClassName}>{editSyncLabel}</span>
              </SidebarRow>
              <SidebarRow label="Risk">
                <span className="truncate">{riskLabel}</span>
              </SidebarRow>
              {hasLiveRun ? (
                <SidebarRow label="Run">
                  <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300">
                    In progress
                  </Badge>
                </SidebarRow>
              ) : null}
            </SidebarSection>

          </div>
        </aside>
      </div>

    </div>
  );
}
