import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CirclePause,
  Clock3,
  Copy,
  Play,
  RefreshCw,
  Repeat,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { automationsApi, type AutomationTriggerResponse, type RotateAutomationTriggerResponse } from "../api/automations";
import { heartbeatsApi } from "../api/heartbeats";
import { LiveRunWidget } from "../components/LiveRunWidget";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildAutomationTriggerPatch } from "../lib/automation-trigger-patch";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { timeAgo } from "../lib/timeAgo";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { ScheduleEditor, describeSchedule } from "../components/ScheduleEditor";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
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
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { AutomationTrigger } from "@rudder/shared";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const triggerKinds = ["schedule", "webhook"];
const signingModes = ["bearer", "hmac_sha256"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "Keep one follow-up run queued while an active run is still working.",
  always_enqueue: "Queue every trigger occurrence, even if several runs stack up.",
  skip_if_active: "Drop overlapping trigger occurrences while the automation is already active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore schedule windows that were missed while the automation or scheduler was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};
const signingModeDescriptions: Record<string, string> = {
  bearer: "Expect a shared bearer token in the Authorization header.",
  hmac_sha256: "Expect an HMAC SHA-256 signature over the request using the shared secret.",
};

type SecretMessage = {
  title: string;
  webhookUrl: string;
  webhookSecret: string;
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function formatActivityDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((item) => formatActivityDetailValue(item)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function formatAutomationTimestamp(value: Date | string | null | undefined, fallback: string) {
  if (!value) return fallback;
  return new Date(value).toLocaleString();
}

function summarizeTrigger(trigger: Pick<AutomationTrigger, "kind" | "cronExpression" | "label"> | null): string {
  if (!trigger) return "No triggers configured";
  if (trigger.kind === "schedule" && trigger.cronExpression) {
    return describeSchedule(trigger.cronExpression);
  }
  if (trigger.kind === "webhook") {
    return trigger.label?.trim() || "Webhook trigger";
  }
  return trigger.label?.trim() || trigger.kind;
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function SidebarRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right text-foreground">{children}</div>
    </div>
  );
}

function SidebarSelectValue({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
    </>
  );
}

function TriggerEditor({
  trigger,
  onSave,
  onRotate,
  onDelete,
}: {
  trigger: AutomationTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });
  const skipNextAutosaveRef = useRef(true);

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
    skipNextAutosaveRef.current = true;
  }, [trigger]);

  const isTriggerDirty = useMemo(() => {
    if (draft.label !== (trigger.label ?? "")) return true;
    if (trigger.kind === "schedule") {
      return draft.cronExpression !== (trigger.cronExpression ?? "");
    }
    if (trigger.kind === "webhook") {
      return (
        draft.signingMode !== (trigger.signingMode ?? "bearer") ||
        draft.replayWindowSec !== String(trigger.replayWindowSec ?? 300)
      );
    }
    return false;
  }, [draft, trigger]);

  const canAutosaveTrigger =
    trigger.kind !== "schedule" || draft.cronExpression.trim().length > 0;

  useEffect(() => {
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    if (!isTriggerDirty || !canAutosaveTrigger) return;

    const timeoutId = window.setTimeout(() => {
      onSave(trigger.id, buildAutomationTriggerPatch(trigger, draft, getLocalTimezone()));
    }, 650);

    return () => window.clearTimeout(timeoutId);
  }, [canAutosaveTrigger, draft, isTriggerDirty, onSave, trigger]);

  return (
    <div className="space-y-3 rounded-md border border-border/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {trigger.kind === "schedule" ? <Clock3 className="h-3.5 w-3.5" /> : trigger.kind === "webhook" ? <Webhook className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
          {trigger.label ?? trigger.kind}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {trigger.kind === "schedule" && trigger.nextRunAt
              ? `Next: ${new Date(trigger.nextRunAt).toLocaleString()}`
              : trigger.kind === "webhook"
                ? "Webhook"
                : "API"}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete trigger"
            onClick={() => onDelete(trigger.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Label</Label>
          <Input
            value={draft.label}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>
        {trigger.kind === "schedule" && (
          <div className="md:col-span-2 space-y-1.5">
            <Label className="text-xs">Schedule</Label>
            <ScheduleEditor
              value={draft.cronExpression}
              onChange={(cronExpression) => setDraft((current) => ({ ...current, cronExpression }))}
            />
          </div>
        )}
        {trigger.kind === "webhook" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Signing mode</Label>
              <Select
                value={draft.signingMode}
                onValueChange={(signingMode) => setDraft((current) => ({ ...current, signingMode }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {signingModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Replay window (seconds)</Label>
              <Input
                value={draft.replayWindowSec}
                onChange={(event) => setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))}
              />
            </div>
          </>
        )}
      </div>

      {(trigger.lastResult || trigger.kind === "webhook") ? (
        <div className="flex flex-wrap items-center gap-2">
          {trigger.lastResult && <span className="text-xs text-muted-foreground">Last: {trigger.lastResult}</span>}
          <div className="ml-auto flex items-center gap-2">
            {trigger.kind === "webhook" && (
              <Button variant="outline" size="sm" onClick={() => onRotate(trigger.id)}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Rotate secret
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AutomationDetail() {
  const { automationId } = useParams<{ automationId: string }>();
  const { selectedOrganizationId } = useOrganization();
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
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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

  const automationDefaults = useMemo(
    () =>
      automation
        ? {
            title: automation.title,
            description: automation.description ?? "",
            projectId: automation.projectId,
            assigneeAgentId: automation.assigneeAgentId,
            priority: automation.priority,
            concurrencyPolicy: automation.concurrencyPolicy,
            catchUpPolicy: automation.catchUpPolicy,
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
      editDraft.catchUpPolicy !== automationDefaults.catchUpPolicy
    );
  }, [editDraft, automationDefaults]);
  const canAutoSaveAutomation = Boolean(
    editDraft.title.trim() &&
    editDraft.projectId &&
    editDraft.assigneeAgentId,
  );
  const editDraftKey = useMemo(
    () => JSON.stringify({
      title: editDraft.title,
      description: editDraft.description.trim() || null,
      projectId: editDraft.projectId,
      assigneeAgentId: editDraft.assigneeAgentId,
      priority: editDraft.priority,
      concurrencyPolicy: editDraft.concurrencyPolicy,
      catchUpPolicy: editDraft.catchUpPolicy,
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

  const copySecretValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
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
        description: draft.description.trim() || null,
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
    onSuccess: async () => {
      pushToast({ title: "Automation run started", tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
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
    mutationFn: () => automationsApi.update(automationId!, { status: "archived" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
      pushToast({ title: "Automation deleted", tone: "success" });
      navigate("/automations");
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

    const isArchived = automation.status === "archived";
    const isEnabled = automation.status === "active";
    const statusActionLabel = isArchived ? "Archived" : isEnabled ? "Pause automation" : "Enable automation";
    const StatusIcon = updateAutomationStatus.isPending ? RefreshCw : isEnabled ? CirclePause : Repeat;

    setHeaderActions(
      <>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={statusActionLabel}
          title={statusActionLabel}
          disabled={updateAutomationStatus.isPending || isArchived}
          onClick={() => updateAutomationStatus.mutate(isEnabled ? "paused" : "active")}
        >
          <StatusIcon className={updateAutomationStatus.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          aria-label="Delete automation"
          title="Delete automation"
          disabled={deleteAutomation.isPending || isArchived}
          onClick={() => {
            const confirmed = window.confirm(
              `Delete "${automation.title}"? It will be archived and stop new runs.`,
            );
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
          className="min-w-[92px] border-white/70 bg-white px-3 text-black shadow-none hover:bg-white/90"
          disabled={runAutomation.isPending || isArchived}
          onClick={() => runAutomation.mutate()}
        >
          <Play className="h-3.5 w-3.5" />
          {runAutomation.isPending ? "Starting..." : "Run now"}
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
      updateTrigger.mutate({ id, patch });
    },
    [updateTrigger],
  );

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => automationsApi.deleteTrigger(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.activity(selectedOrganizationId!, automationId!) }),
      ]);
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
  const automationToggleDisabled = updateAutomationStatus.isPending || automation.status === "archived";
  const automationLabel = automation.status === "archived" ? "Archived" : automationEnabled ? "Active" : "Paused";
  const automationLabelClassName = automation.status === "archived"
    ? "text-muted-foreground"
    : automationEnabled
      ? "text-emerald-400"
      : "text-muted-foreground";
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

  return (
    <div className="pb-8" data-testid="automation-detail-shell">
      {secretMessage && (
        <div className="mb-5 max-w-3xl rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 text-sm lg:ml-10 xl:ml-20">
          <div className="mb-3">
            <p className="font-medium">{secretMessage.title}</p>
            <p className="text-xs text-muted-foreground">Save this now. Rudder will not show the secret value again.</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input value={secretMessage.webhookUrl} readOnly className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook URL", secretMessage.webhookUrl)}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                URL
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input value={secretMessage.webhookSecret} readOnly className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook secret", secretMessage.webhookSecret)}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                Secret
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <main className="min-w-0 space-y-8 pt-4 lg:pl-10 xl:pl-20">
          <section className="max-w-3xl space-y-5">
            <textarea
              ref={titleInputRef}
              className="min-h-[40px] w-full resize-none overflow-hidden bg-transparent text-[1.8rem] font-semibold leading-tight outline-none placeholder:text-muted-foreground/50"
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

            <MarkdownEditor
              ref={descriptionEditorRef}
              value={editDraft.description}
              onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
              placeholder="Add instructions..."
              bordered={false}
              className="bg-transparent"
              contentClassName="min-h-[320px] text-[15px] leading-7 text-foreground/90"
            />
          </section>

          <section className="max-w-3xl space-y-4 border-t border-border/70 pt-5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-medium">Triggers</h2>
            </div>
            <div
              data-testid="automation-add-trigger-card"
              className="space-y-3 rounded-md border border-border/70 bg-muted/20 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  Add at least one trigger so the automation has a clear way to start work.
                </p>
                <Badge variant="outline" className="text-muted-foreground">
                  Triggers autosave after edits
                </Badge>
              </div>
              <div className="grid gap-3 lg:grid-cols-[150px_minmax(0,1fr)]">
                <div className="space-y-1.5">
                  <Label className="text-xs">Kind</Label>
                  <Select value={newTrigger.kind} onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {triggerKinds.map((kind) => (
                        <SelectItem key={kind} value={kind} disabled={kind === "webhook"}>
                          {kind}{kind === "webhook" ? " - coming soon" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {newTrigger.kind === "schedule" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Schedule</Label>
                    <ScheduleEditor
                      value={newTrigger.cronExpression}
                      onChange={(cronExpression) => setNewTrigger((current) => ({ ...current, cronExpression }))}
                    />
                  </div>
                )}
                {newTrigger.kind === "webhook" && (
                  <>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Signing mode</Label>
                      <Select value={newTrigger.signingMode} onValueChange={(signingMode) => setNewTrigger((current) => ({ ...current, signingMode }))}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {signingModes.map((mode) => (
                            <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">{signingModeDescriptions[newTrigger.signingMode]}</p>
                    </div>
                    <div className="space-y-1.5 lg:col-start-2">
                      <Label className="text-xs">Replay window</Label>
                      <Input value={newTrigger.replayWindowSec} onChange={(event) => setNewTrigger((current) => ({ ...current, replayWindowSec: event.target.value }))} />
                    </div>
                  </>
                )}
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => createTrigger.mutate()} disabled={createTrigger.isPending || !canCreateTrigger}>
                  {createTrigger.isPending ? "Adding..." : "Add trigger"}
                </Button>
              </div>
            </div>

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
                    onRotate={(id) => rotateTrigger.mutate(id)}
                    onDelete={(id) => deleteTrigger.mutate(id)}
                  />
                ))
              )}
            </div>
          </section>

          <section className="max-w-3xl space-y-3 border-t border-border/70 pt-5">
            <h2 className="text-sm font-medium">Activity</h2>
            {(activity ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No activity yet.</p>
            ) : (
              <div className="divide-y divide-border/70 border-y border-border/70">
                {(activity ?? []).slice(0, 8).map((event) => (
                  <div key={event.id} className="flex items-center justify-between gap-4 py-2 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-medium text-foreground/90">{event.action.replaceAll(".", " ")}</span>
                      {event.details && Object.keys(event.details).length > 0 && (
                        <span className="truncate text-muted-foreground">
                          {Object.entries(event.details).slice(0, 3).map(([key, value], i) => (
                            <span key={key}>
                              {i > 0 && <span className="mx-1 text-border">·</span>}
                              <span className="text-muted-foreground/70">{key.replaceAll("_", " ")}:</span>{" "}
                              {formatActivityDetailValue(value)}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-muted-foreground/60">{timeAgo(event.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>

        <aside className="space-y-8 border-t border-border/70 pt-5 lg:sticky lg:top-24 lg:self-start lg:border-l lg:border-t-0 lg:pl-7 lg:pr-2 lg:pt-8">
          <SidebarSection title="Status">
            <SidebarRow label="State">
              <div className="flex items-center justify-end gap-2">
                <span className={automationLabelClassName}>{automationLabel}</span>
                <ToggleSwitch
                  checked={automationEnabled}
                  size="md"
                  tone="success"
                  aria-label={automationEnabled ? "Pause automatic triggers" : "Enable automatic triggers"}
                  disabled={automationToggleDisabled}
                  onClick={() => updateAutomationStatus.mutate(automationEnabled ? "paused" : "active")}
                />
              </div>
            </SidebarRow>
            <SidebarRow label="Next run">
              <span className="truncate">{formatAutomationTimestamp(nextTrigger?.nextRunAt, "-")}</span>
            </SidebarRow>
            <SidebarRow label="Last ran">
              <span className="truncate">{latestRun ? timeAgo(latestRun.triggeredAt) : "-"}</span>
            </SidebarRow>
            <SidebarRow label="Edits">
              <span className={editSyncClassName}>{editSyncLabel}</span>
            </SidebarRow>
            {hasLiveRun ? (
              <SidebarRow label="Run">
                <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300">
                  In progress
                </Badge>
              </SidebarRow>
            ) : null}
            {automation.activeIssue && activeIssueLabel ? (
              <SidebarRow label="Issue">
                <Link to={`/issues/${activeIssueLabel}`} className="truncate text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  {activeIssueLabel}
                </Link>
              </SidebarRow>
            ) : null}
          </SidebarSection>

          <SidebarSection title="Details">
            <SidebarRow label="Assigned">
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={editDraft.assigneeAgentId}
                options={assigneeOptions}
                placeholder="Assignee"
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                className="ml-auto min-h-8 max-w-full justify-between border-border/80 bg-muted/30 px-2.5 py-1.5 text-sm font-medium shadow-none hover:border-border hover:bg-accent/60"
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
                          <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="truncate">{option.label}</span>
                      )}
                    </SidebarSelectValue>
                  ) : (
                    <SidebarSelectValue>
                      <span className="text-muted-foreground">Assignee</span>
                    </SidebarSelectValue>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = agentById.get(option.id);
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </SidebarRow>
            <SidebarRow label="Project">
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={editDraft.projectId}
                options={projectOptions}
                placeholder="Project"
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                className="ml-auto min-h-8 max-w-full justify-between border-border/80 bg-muted/30 px-2.5 py-1.5 text-sm font-medium shadow-none hover:border-border hover:bg-accent/60"
                onChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}
                onConfirm={() => descriptionEditorRef.current?.focus()}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <SidebarSelectValue>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: currentProject.color ?? "#64748b" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </SidebarSelectValue>
                  ) : (
                    <SidebarSelectValue>
                      <span className="text-muted-foreground">Project</span>
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
                        style={{ backgroundColor: project?.color ?? "#64748b" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </SidebarRow>
            <SidebarRow label="Repeats">
              <span className="truncate text-muted-foreground">{summarizeTrigger(nextTrigger)}</span>
            </SidebarRow>
          </SidebarSection>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="border-t border-border/70 pt-5">
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Delivery rules
              {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label className="text-xs">Concurrency</Label>
                <Select
                  value={editDraft.concurrencyPolicy}
                  onValueChange={(concurrencyPolicy) => setEditDraft((current) => ({ ...current, concurrencyPolicy }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {concurrencyPolicies.map((value) => (
                      <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">{concurrencyPolicyDescriptions[editDraft.concurrencyPolicy]}</p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Catch-up</Label>
                <Select
                  value={editDraft.catchUpPolicy}
                  onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {catchUpPolicies.map((value) => (
                      <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">{catchUpPolicyDescriptions[editDraft.catchUpPolicy]}</p>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <SidebarSection title="Previous runs">
            {hasLiveRun && activeIssueId && automation ? (
              <LiveRunWidget issueId={activeIssueId} orgId={automation.orgId} />
            ) : null}
            {(automationRuns ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ) : (
              <div className="space-y-2">
                {(automationRuns ?? []).slice(0, 5).map((run) => (
                  <div key={run.id} className="space-y-1 rounded-md border border-border/70 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground">{run.status.replaceAll("_", " ")}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(run.triggeredAt)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{run.source}</span>
                      {run.linkedIssue ? (
                        <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className="truncate hover:underline">
                          {run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)}
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SidebarSection>
        </aside>
      </div>
    </div>
  );
}
