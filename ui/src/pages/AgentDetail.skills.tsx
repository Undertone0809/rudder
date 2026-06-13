import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useParams, useNavigate, Link, Navigate, useBeforeUnload } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  type AgentKey,
  type ClaudeLoginResult,
  type AgentPermissionUpdate,
} from "../api/agents";
import { organizationSkillsApi } from "../api/organizationSkills";
import { budgetsApi } from "../api/budgets";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { ApiError } from "../api/client";
import {
  ChartCard,
  RunActivityChart,
  PriorityChart,
  IssueStatusChart,
  SuccessRateChart,
  SkillsUsageChart,
} from "../components/ActivityCharts";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { retryHeartbeatRun } from "../lib/heartbeat-retry";
import { queryKeys } from "../lib/queryKeys";
import { findOrganizationByPrefix } from "../lib/organization-routes";
import { describeRunReason, runReasonBadgeClassName } from "../lib/run-reason";
import { getRunFailureDisplay, getRunStderrExcerptDisplayText, shouldShowRunStderrExcerpt } from "../lib/run-detail-display";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { DashboardDateRangeControl, type DashboardDatePreset } from "../components/DashboardDateRangeControl";
import { PageTabBar } from "../components/PageTabBar";
import { roleLabels, help } from "../components/agent-config-primitives";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { assetsApi } from "../api/assets";
import { getUIAdapter, buildTranscript } from "../agent-runtimes";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { MarkdownBody } from "../components/MarkdownBody";
import { CopyText } from "../components/CopyText";
import { EntityRow } from "../components/EntityRow";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { RunButton, PauseResumeButton } from "../components/AgentActionButtons";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { PackageFileTree, buildFileTree } from "../components/PackageFileTree";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { formatCents, formatDate, formatDateTime, relativeTime, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { cn } from "../lib/utils";
import { formatRunDurationLabel, formatRunTimingTitle } from "../lib/run-duration-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
  RotateCcw,
  Trash2,
  Plus,
  Key,
  Eye,
  EyeOff,
  Copy,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  HelpCircle,
  FolderOpen,
  Search,
  MessageSquare,
  Maximize2,
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  semanticBadgeToneClasses,
  semanticNoticeToneClasses,
} from "@/components/ui/semanticTones";
import { AgentIcon, AgentIconPicker, getAgentAvatarImageSrc } from "../components/AgentIconPicker";
import { RunTranscriptView, type TranscriptMode } from "../components/transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import {
  getBundledRudderSkillSlug,
  isUuidLike,
  summarizeTokenUsage,
  tokenUsageCacheRatio,
  type Agent,
  type AgentSkillAnalytics,
  type AgentSkillEntry,
  type AgentSkillSnapshot,
  type AgentDetail as AgentDetailRecord,
  type BudgetPolicySummary,
  type HeartbeatRun,
  type HeartbeatRunEvent,
  type AgentRuntimeState,
  type LiveEvent,
  type OrganizationSkillCreateRequest,
  type WorkspaceOperation,
} from "@rudderhq/shared";
import { redactHomePathUserSegments, redactHomePathUserSegmentsInValue } from "@rudderhq/agent-runtime-utils";
import { agentRouteRef } from "../lib/utils";
import { heartbeatRunEventText, heartbeatRunEventToTranscriptEntry, mergeTranscriptEntries } from "../lib/run-detail-events";
import { shouldPollLiveRunBackfill } from "../lib/live-run-backfill";
import {
  arraysEqual,
  canManageSkillEntry,
  isExternalSkillEntry,
  sortSkillRowsByPinnedSelectionKey,
  sortUnique,
  toggleSkillSelection,
} from "../lib/agent-skills-state";
import { runStatusIcons, REDACTED_ENV_VALUE, SECRET_ENV_KEY_RE, JWT_VALUE_RE, formatDateInputValue, parseDateInputValue, getRecentDayKeys, getDayKeysBetween, formatRangeLabel, isWithinRange, compactSkillText, resolveSkillSummaryText, isGenericSkillRuntimeDetail, isGenericSkillLocationLabel, SkillSwitch, CreateAgentSkillDialog, shouldHideExternalSkillEntry, redactPathText, redactPathValue, formatInvocationValueForDisplay, shouldRedactSecretValue, redactEnvValue, isMarkdown, formatEnvForDisplay, LIVE_SCROLL_BOTTOM_TOLERANCE_PX, ScrollContainer, isWindowContainer, isElementScrollContainer, findScrollContainer, readScrollMetrics, scrollToContainerBottom, AgentDetailView, parseAgentDetailView, usageNumber, usageString, setsEqual, runMetrics, formatExactTokens, formatExactTokenLabel, formatCompactTokenLabel, formatCacheRatio, formatRunCostUsd, shouldShowInlineTokenLabel, RunLogChunk, utf8ByteLength, runLogChunkDedupeKey, asRecord, asNonEmptyString, readInvocationSkillList, InvocationSkillEvidence, parseStoredLogContent, RunEventsList, workspaceOperationPhaseLabel, workspaceOperationStatusTone, WorkspaceOperationStatusBadge, WorkspaceOperationLogViewer, WorkspaceOperationsSection, SummaryRow, useRunDurationNow } from "./AgentDetail.helpers";

export function AgentSkillsTab({
  agent,
  orgId,
}: {
  agent: Agent;
  orgId?: string;
}) {
  type SkillRow = {
    id: string;
    selectionKey: string;
    key: string;
    name: string;
    description: string | null;
    detail: string | null;
    locationLabel: string | null;
    badgeLabel: string | null;
    metadataTokens: string[];
    linkTo: string | null;
    workspaceEditPath: string | null;
    alwaysEnabled: boolean;
    configurable: boolean;
    entry: AgentSkillEntry;
  };

  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [lastSavedSkills, setLastSavedSkills] = useState<string[]>([]);
  const [skillFilter, setSkillFilter] = useState("");
  const [externalSectionOpen, setExternalSectionOpen] = useState(false);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const skillDraftRef = useRef<string[]>([]);
  const lastSavedSkillsRef = useRef<string[]>([]);
  const hasHydratedSkillSnapshotRef = useRef(false);
  const initialDesiredSkillKeysRef = useRef<string[] | null>(null);
  const initialDesiredSkillKeysAgentIdRef = useRef<string | null>(null);

  const { data: skillSnapshot, isLoading } = useQuery({
    queryKey: queryKeys.agents.skills(agent.id),
    queryFn: () => agentsApi.skills(agent.id, orgId),
    enabled: Boolean(orgId),
  });

  const { data: organizationSkills, isLoading: organizationSkillsLoading } = useQuery({
    queryKey: queryKeys.organizationSkills.list(orgId ?? ""),
    queryFn: () => organizationSkillsApi.list(orgId!),
    enabled: Boolean(orgId),
  });

  if (initialDesiredSkillKeysAgentIdRef.current !== agent.id) {
    initialDesiredSkillKeysAgentIdRef.current = agent.id;
    initialDesiredSkillKeysRef.current = null;
  }
  // Freeze the pinned order for this visit so toggling a skill does not reshuffle the list in-place.
  if (initialDesiredSkillKeysRef.current === null && skillSnapshot) {
    initialDesiredSkillKeysRef.current = sortUnique(skillSnapshot.desiredSkills);
  }

  const syncSkills = useMutation({
    mutationFn: (desiredSkills: string[]) => agentsApi.syncSkills(agent.id, desiredSkills, orgId),
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
      lastSavedSkillsRef.current = snapshot.desiredSkills;
      setLastSavedSkills(snapshot.desiredSkills);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      ]);
    },
  });

  const createPrivateSkill = useMutation({
    mutationFn: (payload: OrganizationSkillCreateRequest) =>
      agentsApi.createPrivateSkill(agent.id, payload, orgId),
    onSuccess: async (entry) => {
      setCreateSkillOpen(false);
      setSkillFilter("");
      pushToast({
        title: `Created ${entry.key}`,
        body: "Enable it from the Agent skills section when you want Rudder to load it.",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(agent.id) });
    },
  });

  useEffect(() => {
    setSkillDraft([]);
    skillDraftRef.current = [];
    setLastSavedSkills([]);
    setSkillFilter("");
    setExternalSectionOpen(false);
    lastSavedSkillsRef.current = [];
    hasHydratedSkillSnapshotRef.current = false;
  }, [agent.id]);

  useEffect(() => {
    skillDraftRef.current = skillDraft;
  }, [skillDraft]);

  useEffect(() => {
    if (!skillSnapshot) return;
    const normalizedDesiredSkills = sortUnique(skillSnapshot.desiredSkills);
    const currentDraft = skillDraftRef.current;
    const previousLastSaved = lastSavedSkillsRef.current;
    const shouldReplaceDraft = !hasHydratedSkillSnapshotRef.current
      || arraysEqual(currentDraft, previousLastSaved);

    hasHydratedSkillSnapshotRef.current = true;
    lastSavedSkillsRef.current = normalizedDesiredSkills;
    setLastSavedSkills((current) => (
      arraysEqual(current, normalizedDesiredSkills) ? current : normalizedDesiredSkills
    ));

    if (!shouldReplaceDraft) return;

    skillDraftRef.current = normalizedDesiredSkills;
    setSkillDraft((current) => (
      arraysEqual(current, normalizedDesiredSkills) ? current : normalizedDesiredSkills
    ));
  }, [skillSnapshot]);

  const snapshotEntries = skillSnapshot?.entries ?? [];
  const entryBySelectionKey = useMemo(
    () => new Map(snapshotEntries.map((entry) => [entry.selectionKey, entry])),
    [snapshotEntries],
  );

  const getOrganizationSelectionKey = useCallback((skillKey: string) => (
    getBundledRudderSkillSlug(skillKey) ? `bundled:${skillKey}` : `org:${skillKey}`
  ), []);

  const getOrganizationBadgeLabel = useCallback((sourceBadge: string | null | undefined, alwaysEnabled: boolean) => {
    if (alwaysEnabled) return "Bundled by Rudder";
    switch (sourceBadge) {
      case "community":
        return "Community preset";
      case "github":
        return "GitHub";
      case "local":
        return "Local";
      case "url":
        return "URL";
      case "skills_sh":
        return "skills.sh";
      case "catalog":
        return "Catalog";
      case "rudder":
        return "Organization library";
      default:
        return null;
    }
  }, []);

  const buildFallbackOrganizationEntry = useCallback((skill: {
    key: string;
    slug: string;
    description?: string | null;
  }): AgentSkillEntry => {
    const alwaysEnabled = getBundledRudderSkillSlug(skill.key) !== null;
    return {
      key: skill.slug,
      selectionKey: getOrganizationSelectionKey(skill.key),
      runtimeName: skill.slug,
      description: skill.description ?? null,
      desired: alwaysEnabled,
      configurable: !alwaysEnabled,
      alwaysEnabled,
      managed: true,
      state: alwaysEnabled ? "configured" : "available",
      sourceClass: alwaysEnabled ? "bundled" : "organization",
    };
  }, [getOrganizationSelectionKey]);

  const pinnedAgentSkillSelectionKeys = useMemo(
    () => new Set(initialDesiredSkillKeysRef.current ?? []),
    [agent.id, skillSnapshot],
  );

  const organizationSkillRows = useMemo<SkillRow[]>(
    () => sortSkillRowsByPinnedSelectionKey(
      (organizationSkills ?? [])
        .map((skill) => {
          const entry = entryBySelectionKey.get(getOrganizationSelectionKey(skill.key))
            ?? buildFallbackOrganizationEntry(skill);
          const badgeLabel = getOrganizationBadgeLabel(skill.sourceBadge, entry.alwaysEnabled);
          return {
            id: entry.selectionKey,
            selectionKey: entry.selectionKey,
            key: entry.key,
            name: skill.name,
            description: compactSkillText(skill.description ?? entry.description ?? null),
            detail: compactSkillText(entry.detail ?? null),
            locationLabel: entry.locationLabel ?? null,
            badgeLabel,
            metadataTokens: [skill.sourceLabel]
              .filter((value): value is string => Boolean(value))
              .filter((value) => value !== badgeLabel),
            linkTo: `/skills/${skill.id}`,
            workspaceEditPath: skill.workspaceEditPath,
            alwaysEnabled: entry.alwaysEnabled,
            configurable: canManageSkillEntry(entry),
            entry,
          };
        }),
      pinnedAgentSkillSelectionKeys,
    ),
    [
      buildFallbackOrganizationEntry,
      entryBySelectionKey,
      getOrganizationBadgeLabel,
      getOrganizationSelectionKey,
      organizationSkills,
      pinnedAgentSkillSelectionKeys,
    ],
  );

  const discoveredSkillRows = useMemo<SkillRow[]>(
    () =>
      snapshotEntries
        .filter((entry) => isExternalSkillEntry(entry))
        .filter((entry) => !shouldHideExternalSkillEntry(entry))
        .map((entry) => ({
          id: entry.selectionKey,
          selectionKey: entry.selectionKey,
          key: entry.key,
          name: entry.runtimeName ?? entry.key,
          description: compactSkillText(entry.description ?? null),
          detail: compactSkillText(
            entry.detail
              ?? (entry.sourceClass === "agent_home"
                ? "Installed, not enabled. Future runs will not load it until enabled."
                : entry.sourceClass === "global"
                  ? "Discovered in ~/.agents/skills. Enable it here to load it for this agent."
                  : "Discovered in the current runtime adapter home. Enable it here to load it for this agent."),
          ),
          locationLabel: entry.locationLabel ?? null,
          badgeLabel: entry.sourceClass === "agent_home"
            ? entry.desired
              ? "Agent skill"
              : "Installed, not enabled"
            : entry.sourceClass === "global"
              ? "Global skill"
              : "Adapter skill",
          metadataTokens: [entry.locationLabel].filter((value): value is string => Boolean(value)),
          linkTo: null,
          workspaceEditPath: entry.workspaceEditPath ?? null,
          alwaysEnabled: entry.alwaysEnabled,
          configurable: canManageSkillEntry(entry),
          entry,
        }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.selectionKey.localeCompare(right.selectionKey)),
    [snapshotEntries],
  );

  const agentSkillRows = useMemo(
    () => sortSkillRowsByPinnedSelectionKey(
      discoveredSkillRows.filter((skill) => skill.entry.sourceClass === "agent_home"),
      pinnedAgentSkillSelectionKeys,
    ),
    [discoveredSkillRows, pinnedAgentSkillSelectionKeys],
  );

  const externalSkillRows = useMemo(
    () => discoveredSkillRows.filter((skill) => skill.entry.sourceClass !== "agent_home"),
    [discoveredSkillRows],
  );

  const globalSkillRows = useMemo(
    () => sortSkillRowsByPinnedSelectionKey(
      externalSkillRows.filter((skill) => skill.entry.sourceClass === "global"),
      pinnedAgentSkillSelectionKeys,
    ),
    [externalSkillRows, pinnedAgentSkillSelectionKeys],
  );

  const adapterSkillRows = useMemo(
    () => sortSkillRowsByPinnedSelectionKey(
      externalSkillRows.filter((skill) => skill.entry.sourceClass === "adapter_home"),
      pinnedAgentSkillSelectionKeys,
    ),
    [externalSkillRows, pinnedAgentSkillSelectionKeys],
  );

  const filteredOrganizationSkillRows = useMemo(() => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    return organizationSkillRows.filter((skill) => {
      if (!normalizedFilter) return true;
      const haystack = [
        skill.name,
        skill.key,
        skill.description ?? "",
        skill.detail ?? "",
        ...skill.metadataTokens,
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedFilter);
    });
  }, [organizationSkillRows, skillFilter]);

  const filterSkillRows = useCallback((rows: SkillRow[]) => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    return rows.filter((skill) => {
      if (!normalizedFilter) return true;
      const haystack = [
        skill.name,
        skill.key,
        skill.description ?? "",
        skill.detail ?? "",
        ...skill.metadataTokens,
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedFilter);
    });
  }, [skillFilter]);

  const filteredGlobalSkillRows = useMemo(
    () => filterSkillRows(globalSkillRows),
    [filterSkillRows, globalSkillRows],
  );

  const filteredAgentSkillRows = useMemo(
    () => filterSkillRows(agentSkillRows),
    [agentSkillRows, filterSkillRows],
  );

  const filteredAdapterSkillRows = useMemo(
    () => filterSkillRows(adapterSkillRows),
    [adapterSkillRows, filterSkillRows],
  );

  const visibleManageableSkillKeys = useMemo(
    () => [
      ...filteredOrganizationSkillRows.filter((skill) => !skill.alwaysEnabled).map((skill) => skill.selectionKey),
      ...filteredAgentSkillRows
        .filter((skill) => skill.configurable)
        .map((skill) => skill.selectionKey),
      ...(externalSectionOpen
        ? [...filteredGlobalSkillRows, ...filteredAdapterSkillRows]
            .filter((skill) => skill.configurable)
            .map((skill) => skill.selectionKey)
        : []),
    ],
    [externalSectionOpen, filteredAdapterSkillRows, filteredAgentSkillRows, filteredGlobalSkillRows, filteredOrganizationSkillRows],
  );

  const availableSkillKeys = useMemo(
    () => new Set(snapshotEntries.map((entry) => entry.selectionKey)),
    [snapshotEntries],
  );

  const unavailableEnabledSkills = useMemo(
    () => skillDraft.filter((selectionKey) => !availableSkillKeys.has(selectionKey)),
    [availableSkillKeys, skillDraft],
  );

  const unsupportedSkillMessage = useMemo(() => {
    if (skillSnapshot?.mode !== "unsupported") return null;
    if (agent.agentRuntimeType === "openclaw_gateway") {
      return "Rudder cannot manage OpenClaw skills here. Visit your OpenClaw instance to manage this agent's skills.";
    }
    return "Rudder cannot manage skills for this runtime yet. Manage them in the runtime directly.";
  }, [agent.agentRuntimeType, skillSnapshot?.mode]);

  const hasEnabledExternalSkill = useMemo(
    () => externalSkillRows.some((skill) => skillDraft.includes(skill.selectionKey)),
    [externalSkillRows, skillDraft],
  );

  const isSkillsLoading = isLoading || organizationSkillsLoading;
  const saveStatusLabel = syncSkills.isPending ? "Saving..." : null;

  const controlsHelperText = "Rudder always loads the bundled Rudder skills. Agent, organization, global, and adapter skills load only when enabled on this page.";
  const agentSectionHelperText = "Agent-private skills belong to this agent only. Edit them in Library, then enable them here when you want Rudder to load them.";
  const organizationSectionHelperText = "Bundled Rudder skills are locked on. Community presets and other organization skills stay optional; Library-backed skills can be edited from Library.";
  const externalSectionHelperText = "Global and adapter skills are discovered from ~/.agents/skills and the current runtime adapter home. Discovery does not enable them; only the selections on this page determine runtime loading.";

  const updateSkillDraft = useCallback((updater: (current: string[]) => string[]) => {
    const current = skillDraftRef.current;
    const next = sortUnique(updater(current));
    if (arraysEqual(current, next)) return;
    skillDraftRef.current = next;
    setSkillDraft(next);
    if (!arraysEqual(next, lastSavedSkillsRef.current)) {
      syncSkills.mutate(next);
    }
  }, [syncSkills]);

  const setSkillRowEnabledState = useCallback((row: SkillRow, enabled: boolean) => {
    updateSkillDraft((current) => toggleSkillSelection(current, row.entry, enabled, snapshotEntries));
  }, [snapshotEntries, updateSkillDraft]);

  const setSkillEnabledState = useCallback((rows: SkillRow[], enabled: boolean) => {
    if (rows.length === 0) return;
    updateSkillDraft((current) =>
      rows.reduce(
        (draft, row) => toggleSkillSelection(draft, row.entry, enabled, snapshotEntries),
        current,
      ),
    );
  }, [snapshotEntries, updateSkillDraft]);

  const enableVisibleSkills = useCallback(() => {
    const visibleRows = [
      ...filteredOrganizationSkillRows.filter((skill) => !skill.alwaysEnabled),
      ...filteredAgentSkillRows,
      ...(externalSectionOpen ? [...filteredGlobalSkillRows, ...filteredAdapterSkillRows] : []),
    ];
    setSkillEnabledState(visibleRows, true);
  }, [externalSectionOpen, filteredAdapterSkillRows, filteredAgentSkillRows, filteredGlobalSkillRows, filteredOrganizationSkillRows, setSkillEnabledState]);

  const disableVisibleSkills = useCallback(() => {
    const visibleRows = [
      ...filteredOrganizationSkillRows.filter((skill) => !skill.alwaysEnabled),
      ...filteredAgentSkillRows,
      ...(externalSectionOpen ? [...filteredGlobalSkillRows, ...filteredAdapterSkillRows] : []),
    ];
    setSkillEnabledState(visibleRows, false);
  }, [externalSectionOpen, filteredAdapterSkillRows, filteredAgentSkillRows, filteredGlobalSkillRows, filteredOrganizationSkillRows, setSkillEnabledState]);

  useEffect(() => {
    if (hasEnabledExternalSkill) {
      setExternalSectionOpen(true);
      return;
    }
    if (
      skillFilter.trim().length > 0
      && filteredOrganizationSkillRows.length === 0
      && filteredAgentSkillRows.length === 0
      && (filteredGlobalSkillRows.length > 0 || filteredAdapterSkillRows.length > 0)
    ) {
      setExternalSectionOpen(true);
    }
  }, [filteredAdapterSkillRows.length, filteredAgentSkillRows.length, filteredGlobalSkillRows.length, filteredOrganizationSkillRows.length, hasEnabledExternalSkill, skillFilter]);

  const renderSkillCard = useCallback((skill: SkillRow) => {
    const enabled = skill.alwaysEnabled || skillDraft.includes(skill.selectionKey);
    const switchDisabled = skill.alwaysEnabled || !skill.configurable || Boolean(unsupportedSkillMessage && !skill.alwaysEnabled);
    const workspaceEditHref = skill.workspaceEditPath
      ? `/workspaces?path=${encodeURIComponent(skill.workspaceEditPath)}`
      : null;
    const summary = resolveSkillSummaryText(
      skill.description,
      isGenericSkillRuntimeDetail(skill.detail) ? null : skill.detail,
    );
    const detailText = skill.detail
      && skill.detail !== skill.description
      && !isGenericSkillRuntimeDetail(skill.detail)
      ? skill.detail
      : null;
    const metadataTokens = [
      isGenericSkillLocationLabel(skill.locationLabel) ? null : skill.locationLabel,
      ...skill.metadataTokens,
    ].filter((value): value is string => Boolean(value))
      .filter((value) => value !== skill.badgeLabel && value !== "Bundled by Rudder");

    return (
      <div
        key={skill.id}
        className={cn(
          "flex h-full flex-col gap-2.5 rounded-lg border p-3 transition-colors",
          skill.alwaysEnabled
            ? "border-sky-200 bg-sky-50/50 dark:border-sky-500/30 dark:bg-sky-950/15"
            : enabled
              ? "border-border bg-background"
              : "border-border/70 bg-muted/35 text-muted-foreground",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {skill.linkTo ? (
                <Link
                  to={skill.linkTo}
                  className={cn(
                    "truncate text-sm font-semibold no-underline transition-colors hover:text-foreground",
                    skill.alwaysEnabled || enabled ? "text-foreground" : "text-foreground/80",
                  )}
                >
                  {skill.name}
                </Link>
              ) : (
                <span className={cn("truncate text-sm font-semibold", skill.alwaysEnabled || enabled ? "text-foreground" : "text-foreground/80")}>
                  {skill.name}
                </span>
              )}
              {skill.badgeLabel ? (
                <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {skill.badgeLabel}
                </span>
              ) : null}
            </div>
          </div>
          <SkillSwitch
            checked={enabled}
            disabled={switchDisabled}
            label={skill.name}
            onCheckedChange={(nextChecked) => setSkillRowEnabledState(skill, nextChecked)}
          />
        </div>

        <p className={cn("line-clamp-2 text-xs leading-[1.15rem]", skill.alwaysEnabled || enabled ? "text-muted-foreground" : "text-muted-foreground/90")}>
          {summary}
        </p>

        {detailText ? (
          <p className="line-clamp-2 text-[11px] leading-[1.05rem] text-muted-foreground/90">
            {detailText}
          </p>
        ) : null}

        {metadataTokens.length > 0 || workspaceEditHref ? (
          <div className="mt-auto space-y-2">
            {metadataTokens.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                {metadataTokens.map((token) => (
                  <span
                    key={`${skill.id}:${token}`}
                    className="max-w-full truncate rounded-md border border-border bg-muted/20 px-1.5 py-0.5"
                    title={token}
                  >
                    {token}
                  </span>
                ))}
              </div>
            ) : null}
            {workspaceEditHref ? (
              <div className="flex items-center gap-2">
                <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
                  <Link to={workspaceEditHref}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>Edit in workspaces</span>
                  </Link>
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }, [setSkillRowEnabledState, skillDraft, unsupportedSkillMessage]);

  return (
    <div className="max-w-6xl space-y-3">
      <section className="space-y-3">
        <div className="space-y-1">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Skills</p>
            <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
              {controlsHelperText}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[16rem] max-w-md flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value)}
              placeholder="Search skills"
              aria-label="Search skills"
              className="h-9 pl-9"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setCreateSkillOpen(true)}
              disabled={skillSnapshot?.mode === "unsupported" || createPrivateSkill.isPending}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create agent skill</span>
            </Button>
            {saveStatusLabel ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {syncSkills.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{saveStatusLabel}</span>
              </div>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More skill actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                <DropdownMenuItem
                  onClick={enableVisibleSkills}
                  disabled={visibleManageableSkillKeys.length === 0 || skillSnapshot?.mode === "unsupported"}
                >
                  Enable visible
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={disableVisibleSkills}
                  disabled={visibleManageableSkillKeys.length === 0 || skillSnapshot?.mode === "unsupported"}
                >
                  Disable visible
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </section>

      {skillSnapshot?.warnings.length ? (
        <div className="space-y-1 rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
          {skillSnapshot.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {unsupportedSkillMessage ? (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
          {unsupportedSkillMessage}
        </div>
      ) : null}

      {isSkillsLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <>
          {organizationSkillRows.length === 0 && agentSkillRows.length === 0 && externalSkillRows.length === 0 ? (
            <section className="rounded-xl border border-border bg-[color:var(--surface-elevated)]">
              <div className="px-4 py-6 text-sm text-muted-foreground">
                Import or scan skills into the organization library first, then enable them here.
              </div>
            </section>
          ) : (
            <>
              {agentSkillRows.length > 0 ? (
                <section className="overflow-hidden rounded-xl border border-border bg-[color:var(--surface-elevated)]">
                  <div className="border-b border-border px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">Agent skills</p>
                      <span className="text-xs text-muted-foreground">{agentSkillRows.length}</span>
                    </div>
                    <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                      {agentSectionHelperText}
                    </p>
                  </div>
                  <div className="px-3.5 py-3.5">
                    {filteredAgentSkillRows.length === 0 ? (
                      <div className="px-0.5 py-1 text-sm text-muted-foreground">
                        No skills match this search.
                      </div>
                    ) : (
                      <div className="grid gap-2.5 md:grid-cols-2">
                        {filteredAgentSkillRows.map((skill) => renderSkillCard(skill))}
                      </div>
                    )}
                  </div>
                </section>
              ) : null}

              <section className="overflow-hidden rounded-xl border border-border bg-[color:var(--surface-elevated)]">
                <div className="border-b border-border px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">Organization skills</p>
                    <span className="text-xs text-muted-foreground">{organizationSkillRows.length}</span>
                  </div>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                    {organizationSectionHelperText}
                  </p>
                </div>
                <div className="px-3.5 py-3.5">
                  {filteredOrganizationSkillRows.length === 0 ? (
                    <div className="px-0.5 py-1 text-sm text-muted-foreground">
                      No skills match this search.
                    </div>
                  ) : (
                    <div className="grid gap-2.5 md:grid-cols-2">
                      {filteredOrganizationSkillRows.map((skill) => renderSkillCard(skill))}
                    </div>
                  )}
                </div>
              </section>

              {externalSkillRows.length > 0 ? (
                <section className="overflow-hidden rounded-xl border border-border bg-[color:var(--surface-elevated)]">
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-start justify-between gap-3 px-4 py-3 text-left",
                      externalSectionOpen && "border-b border-border",
                    )}
                    onClick={() => setExternalSectionOpen((current) => !current)}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">External skills</span>
                        <span className="text-xs text-muted-foreground">{externalSkillRows.length}</span>
                      </div>
                      <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                        {externalSectionHelperText}
                      </p>
                    </div>
                    {externalSectionOpen ? (
                      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                  {externalSectionOpen ? (
                    filteredGlobalSkillRows.length === 0 && filteredAdapterSkillRows.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">
                        No external skills match this search.
                      </div>
                    ) : (
                      <div className="space-y-4 px-3.5 py-3.5">
                        {filteredGlobalSkillRows.length > 0 ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 px-0.5">
                              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Global skills</span>
                              <span className="text-[11px] text-muted-foreground">{filteredGlobalSkillRows.length}</span>
                            </div>
                            <div className="grid gap-2.5 md:grid-cols-2">
                              {filteredGlobalSkillRows.map((skill) => renderSkillCard(skill))}
                            </div>
                          </div>
                        ) : null}
                        {filteredAdapterSkillRows.length > 0 ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 px-0.5">
                              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Adapter skills</span>
                              <span className="text-[11px] text-muted-foreground">{filteredAdapterSkillRows.length}</span>
                            </div>
                            <div className="grid gap-2.5 md:grid-cols-2">
                              {filteredAdapterSkillRows.map((skill) => renderSkillCard(skill))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )
                  ) : null}
                </section>
              ) : null}
            </>
          )}

          {unavailableEnabledSkills.length > 0 ? (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="font-medium">Enabled skills currently unavailable</div>
              <div className="mt-1 text-xs">
                {unavailableEnabledSkills.join(", ")}
              </div>
            </div>
          ) : null}

          {syncSkills.isError ? (
            <p className="text-xs text-destructive">
              {syncSkills.error instanceof Error ? syncSkills.error.message : "Failed to update skills"}
            </p>
          ) : null}
        </>
      )}

      <CreateAgentSkillDialog
        open={createSkillOpen}
        onOpenChange={setCreateSkillOpen}
        onCreate={(payload) => createPrivateSkill.mutate(payload)}
        isPending={createPrivateSkill.isPending}
        error={createPrivateSkill.error instanceof Error ? createPrivateSkill.error.message : null}
      />
    </div>
  );
}

/* ---- Runs Tab ---- */
