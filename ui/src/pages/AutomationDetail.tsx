import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Play,
  RefreshCw,
  Repeat,
  Save,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { AutomationTrigger } from "@rudder/shared";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const triggerKinds = ["schedule", "webhook"];
const signingModes = ["bearer", "hmac_sha256"];
const automationTabs = ["triggers", "runs", "activity"] as const;
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

type AutomationTab = (typeof automationTabs)[number];

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

function isAutomationTab(value: string | null): value is AutomationTab {
  return value !== null && automationTabs.includes(value as AutomationTab);
}

function getAutomationTabFromSearch(search: string): AutomationTab {
  const tab = new URLSearchParams(search).get("tab");
  return isAutomationTab(tab) ? tab : "triggers";
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

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
  }, [trigger]);

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {trigger.kind === "schedule" ? <Clock3 className="h-3.5 w-3.5" /> : trigger.kind === "webhook" ? <Webhook className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
          {trigger.label ?? trigger.kind}
        </div>
        <span className="text-xs text-muted-foreground">
          {trigger.kind === "schedule" && trigger.nextRunAt
            ? `Next: ${new Date(trigger.nextRunAt).toLocaleString()}`
            : trigger.kind === "webhook"
              ? "Webhook"
              : "API"}
        </span>
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

      <div className="flex flex-wrap items-center gap-2">
        {trigger.lastResult && <span className="text-xs text-muted-foreground">Last: {trigger.lastResult}</span>}
        <div className="ml-auto flex items-center gap-2">
          {trigger.kind === "webhook" && (
            <Button variant="outline" size="sm" onClick={() => onRotate(trigger.id)}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Rotate secret
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSave(trigger.id, buildAutomationTriggerPatch(trigger, draft, getLocalTimezone()))}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(trigger.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AutomationDetail() {
  const { automationId } = useParams<{ automationId: string }>();
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const hydratedAutomationIdRef = useRef<string | null>(null);
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
  const activeTab = useMemo(() => getAutomationTabFromSearch(location.search), [location.search]);

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

  useEffect(() => {
    if (!automation) return;
    setBreadcrumbs([{ label: "Automations", href: "/automations" }, { label: automation.title }]);
    if (!automationDefaults) return;

    const changedAutomation = hydratedAutomationIdRef.current !== automation.id;
    if (changedAutomation || !isEditDirty) {
      setEditDraft(automationDefaults);
      hydratedAutomationIdRef.current = automation.id;
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

  const setActiveTab = (value: string) => {
    if (!automationId || !isAutomationTab(value)) return;
    const params = new URLSearchParams(location.search);
    if (value === "triggers") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  };

  const saveAutomation = useMutation({
    mutationFn: () => {
      return automationsApi.update(automationId!, {
        ...editDraft,
        description: editDraft.description.trim() || null,
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
      pushToast({
        title: "Failed to save automation",
        body: error instanceof Error ? error.message : "Rudder could not save the automation.",
        tone: "error",
      });
    },
  });

  const runAutomation = useMutation({
    mutationFn: () => automationsApi.run(automationId!),
    onSuccess: async () => {
      pushToast({ title: "Automation run started", tone: "success" });
      setActiveTab("runs");
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
  const saveDisabled = saveAutomation.isPending || !editDraft.title.trim() || !editDraft.projectId || !editDraft.assigneeAgentId;
  const nextTrigger = [...automation.triggers]
    .filter((trigger) => trigger.enabled)
    .sort((a, b) => {
      const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    })[0] ?? automation.triggers[0] ?? null;
  const latestRun = automationRuns?.[0] ?? automation.recentRuns[0] ?? null;
  const activeIssueLabel = automation.activeIssue?.identifier ?? automation.activeIssue?.id.slice(0, 8) ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-4 pb-8" data-testid="automation-detail-shell">
      {secretMessage && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 space-y-3 text-sm">
          <div>
            <p className="font-medium">{secretMessage.title}</p>
            <p className="text-xs text-muted-foreground">Save this now. Rudder will not show the secret value again.</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input value={secretMessage.webhookUrl} readOnly className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook URL", secretMessage.webhookUrl)}>
                <Copy className="h-3.5 w-3.5 mr-1" />
                URL
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input value={secretMessage.webhookSecret} readOnly className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook secret", secretMessage.webhookSecret)}>
                <Copy className="h-3.5 w-3.5 mr-1" />
                Secret
              </Button>
            </div>
          </div>
        </div>
      )}

      <Card data-testid="automation-main-card" className="border-border/70 shadow-none">
        <CardContent className="space-y-5 p-5">
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={automationEnabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : undefined}
                >
                  {automationLabel}
                </Badge>
                {hasLiveRun ? (
                  <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300">
                    Run in progress
                  </Badge>
                ) : null}
                {automation.activeIssue && activeIssueLabel ? (
                  <Badge variant="outline" className="gap-1.5">
                    Active issue
                    <Link to={`/issues/${activeIssueLabel}`} className="font-medium underline-offset-4 hover:underline">
                      {activeIssueLabel}
                    </Link>
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{automationLabel}</span>
                  <span className="text-border">•</span>
                  <span>{summarizeTrigger(nextTrigger)}</span>
                </div>
                <ToggleSwitch
                  checked={automationEnabled}
                  size="md"
                  tone="success"
                  aria-label={automationEnabled ? "Pause automatic triggers" : "Enable automatic triggers"}
                  disabled={automationToggleDisabled}
                  onClick={() => updateAutomationStatus.mutate(automationEnabled ? "paused" : "active")}
                />
                <Button variant="outline" onClick={() => runAutomation.mutate()} disabled={runAutomation.isPending}>
                  <Play className="mr-2 h-4 w-4" />
                  {runAutomation.isPending ? "Starting run..." : "Run now"}
                </Button>
                <Button onClick={() => saveAutomation.mutate()} disabled={saveDisabled}>
                  <Save className="mr-2 h-4 w-4" />
                  {saveAutomation.isPending ? "Saving..." : "Save changes"}
                </Button>
              </div>
            </div>

            <textarea
              ref={titleInputRef}
              className="min-h-[40px] w-full resize-none overflow-hidden bg-transparent text-[1.8rem] font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/50"
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

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="automation-summary-row">
              <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Next trigger</p>
                <p className="mt-1 text-sm font-medium text-foreground">{summarizeTrigger(nextTrigger)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatAutomationTimestamp(nextTrigger?.nextRunAt, nextTrigger ? "Waiting for next eligible window." : "Add a trigger to schedule work.")}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Last run</p>
                <p className="mt-1 text-sm font-medium text-foreground">{latestRun ? latestRun.status.replaceAll("_", " ") : "No runs yet"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatAutomationTimestamp(latestRun?.triggeredAt, "This automation has not run yet.")}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Automatic triggers</p>
                <p className={`mt-1 text-sm font-medium ${automationLabelClassName}`}>{automationLabel}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {automationEnabled
                    ? "Schedules and webhooks can enqueue new work."
                    : "Config stays intact until you re-enable it."}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Edit state</p>
                <p className={`mt-1 text-sm font-medium ${isEditDirty ? "text-amber-600" : "text-foreground"}`}>
                  {isEditDirty ? "Unsaved changes" : "In sync"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isEditDirty ? "Save before leaving this page." : "All editable fields are current."}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/80">Assigned</span>
            <div className="inline-flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-foreground">
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={editDraft.assigneeAgentId}
                options={assigneeOptions}
                placeholder="Assignee"
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                className="border-0 bg-transparent p-0 text-sm font-medium shadow-none hover:bg-transparent"
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
                  const assignee = agentById.get(option.id);
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
            <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/80">Project</span>
            <div className="inline-flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-foreground">
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={editDraft.projectId}
                options={projectOptions}
                placeholder="Project"
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                className="border-0 bg-transparent p-0 text-sm font-medium shadow-none hover:bg-transparent"
                onChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}
                onConfirm={() => descriptionEditorRef.current?.focus()}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: currentProject.color ?? "#64748b" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Project</span>
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
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Instructions</p>
                <p className="text-xs text-muted-foreground">Describe the recurring work and the output the assignee should produce.</p>
              </div>
              <span className="text-xs text-muted-foreground">{editDraft.description.trim() ? "Editable prompt" : "Prompt missing"}</span>
            </div>
            <MarkdownEditor
              ref={descriptionEditorRef}
              value={editDraft.description}
              onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
              placeholder="Add instructions..."
              bordered
              className="bg-background/50"
              contentClassName="min-h-[180px] text-[15px] leading-7"
              onSubmit={() => {
                if (!saveAutomation.isPending && editDraft.title.trim() && editDraft.projectId && editDraft.assigneeAgentId) {
                  saveAutomation.mutate();
                }
              }}
            />
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="rounded-lg border border-border/70 bg-muted/10">
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left">
              <div>
                <p className="text-sm font-medium">Delivery rules</p>
                <p className="text-xs text-muted-foreground">Control overlap and catch-up behavior without crowding the main editing surface.</p>
              </div>
              {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t border-border/60 px-4 py-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Concurrency</p>
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
                  <p className="text-xs text-muted-foreground">{concurrencyPolicyDescriptions[editDraft.concurrencyPolicy]}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Catch-up</p>
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
                  <p className="text-xs text-muted-foreground">{catchUpPolicyDescriptions[editDraft.catchUpPolicy]}</p>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList variant="line" className="w-full justify-start gap-1 border-b border-border/70 pb-px">
          <TabsTrigger value="triggers" className="gap-1.5">
            <Clock3 className="h-3.5 w-3.5" />
            Triggers
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <Play className="h-3.5 w-3.5" />
            Runs
            {hasLiveRun && <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />}
          </TabsTrigger>
<TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="triggers" className="space-y-4">
          <Card data-testid="automation-add-trigger-card" className="border-border/70 shadow-none">
            <CardContent className="space-y-4 p-4">
              <div className="space-y-1">
                <h2 className="text-sm font-medium">Add trigger</h2>
                <p className="text-xs text-muted-foreground">Start with a schedule. Webhook setup can follow once the workflow is stable.</p>
              </div>
              <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)] md:items-end">
                <div className="space-y-1.5">
                  <Label className="text-xs">Kind</Label>
                  <Select value={newTrigger.kind} onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {triggerKinds.map((kind) => (
                        <SelectItem key={kind} value={kind} disabled={kind === "webhook"}>
                          {kind}{kind === "webhook" ? " — COMING SOON" : ""}
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
                    <div className="space-y-1.5">
                      <Label className="text-xs">Replay window (seconds)</Label>
                      <Input value={newTrigger.replayWindowSec} onChange={(event) => setNewTrigger((current) => ({ ...current, replayWindowSec: event.target.value }))} />
                    </div>
                  </>
                )}
              </div>
              <div className="flex justify-end">
                <Button onClick={() => createTrigger.mutate()} disabled={createTrigger.isPending}>
                  {createTrigger.isPending ? "Adding..." : "Add trigger"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div data-testid="automation-triggers-list" className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-sm font-medium">Configured triggers</h2>
              <p className="text-xs text-muted-foreground">Schedules and webhooks that can materialize this automation into a run.</p>
            </div>
            {automation.triggers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/80 bg-muted/10 px-4 py-6 text-sm text-muted-foreground">
                No triggers configured yet.
              </div>
            ) : (
              automation.triggers.map((trigger) => (
                <TriggerEditor
                  key={trigger.id}
                  trigger={trigger}
                  onSave={(id, patch) => updateTrigger.mutate({ id, patch })}
                  onRotate={(id) => rotateTrigger.mutate(id)}
                  onDelete={(id) => deleteTrigger.mutate(id)}
                />
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="runs" className="space-y-4">
          {hasLiveRun && activeIssueId && automation && (
            <LiveRunWidget issueId={activeIssueId} orgId={automation.orgId} />
          )}
          {(automationRuns ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(automationRuns ?? []).map((run) => (
                <div key={run.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className="shrink-0">{run.source}</Badge>
                    <Badge variant={run.status === "failed" ? "destructive" : "secondary"} className="shrink-0">
                      {run.status.replaceAll("_", " ")}
                    </Badge>
                    {run.trigger && (
                      <span className="text-muted-foreground truncate">{run.trigger.label ?? run.trigger.kind}</span>
                    )}
                    {run.linkedIssue && (
                      <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className="text-muted-foreground hover:underline truncate">
                        {run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)}
                      </Link>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">{timeAgo(run.triggeredAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {(activity ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(activity ?? []).map((event) => (
                <div key={event.id} className="flex items-center justify-between px-3 py-2 text-xs gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-foreground/90 shrink-0">{event.action.replaceAll(".", " ")}</span>
                    {event.details && Object.keys(event.details).length > 0 && (
                      <span className="text-muted-foreground truncate">
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
                  <span className="text-muted-foreground/60 shrink-0">{timeAgo(event.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
