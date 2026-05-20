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

export function KeysTab({ agentId, orgId }: { agentId: string; orgId?: string }) {
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: keys, isLoading } = useQuery({
    queryKey: queryKeys.agents.keys(agentId),
    queryFn: () => agentsApi.listKeys(agentId, orgId),
  });

  const createKey = useMutation({
    mutationFn: () => agentsApi.createKey(agentId, newKeyName.trim() || "Default", orgId),
    onSuccess: (data) => {
      setNewToken(data.token);
      setTokenVisible(true);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.keys(agentId) });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (keyId: string) => agentsApi.revokeKey(agentId, keyId, orgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.keys(agentId) });
    },
  });

  function copyToken() {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const activeKeys = (keys ?? []).filter((k: AgentKey) => !k.revokedAt);
  const revokedKeys = (keys ?? []).filter((k: AgentKey) => k.revokedAt);

  return (
    <div className="space-y-6">
      {/* New token banner */}
      {newToken && (
        <div className="border border-yellow-300 dark:border-yellow-600/40 bg-yellow-50 dark:bg-yellow-500/5 rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
            API key created — copy it now, it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-neutral-100 dark:bg-neutral-950 rounded px-3 py-1.5 text-xs font-mono text-green-700 dark:text-green-300 truncate">
              {tokenVisible ? newToken : newToken.replace(/./g, "•")}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTokenVisible((v) => !v)}
              title={tokenVisible ? "Hide" : "Show"}
            >
              {tokenVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={copyToken}
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            {copied && <span className="text-xs text-green-400">Copied!</span>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground text-xs"
            onClick={() => setNewToken(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Create new key */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-2">
          <Key className="h-3.5 w-3.5" />
          Create API Key
        </h3>
        <p className="text-xs text-muted-foreground">
          API keys allow this agent to authenticate calls to the Rudder server.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Key name (e.g. production)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") createKey.mutate();
            }}
          />
          <Button
            size="sm"
            onClick={() => createKey.mutate()}
            disabled={createKey.isPending}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create
          </Button>
        </div>
      </div>

      {/* Active keys */}
      {isLoading && <p className="text-sm text-muted-foreground">Loading keys...</p>}

      {!isLoading && activeKeys.length === 0 && !newToken && (
        <p className="text-sm text-muted-foreground">No active API keys.</p>
      )}

      {activeKeys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            Active Keys
          </h3>
          <div className="border border-border rounded-lg divide-y divide-border">
            {activeKeys.map((key: AgentKey) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm font-medium">{key.name}</span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Created {formatDate(key.createdAt)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs"
                  onClick={() => revokeKey.mutate(key.id)}
                  disabled={revokeKey.isPending}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            Revoked Keys
          </h3>
          <div className="border border-border rounded-lg divide-y divide-border opacity-50">
            {revokedKeys.map((key: AgentKey) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm line-through">{key.name}</span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Revoked {key.revokedAt ? formatDate(key.revokedAt) : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

