import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Boxes,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock3,
  Columns3,
  Copy,
  DollarSign,
  Eye,
  EyeOff,
  ExternalLink,
  FolderTree,
  History,
  MessageSquare,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Target,
  Trash2,
  UserRound,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { cn, agentUrl, issueUrl, projectRouteRef } from "@/lib/utils";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToast } from "@/context/ToastContext";
import { useDialog } from "@/context/DialogContext";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { issuesApi } from "@/api/issues";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { calendarApi } from "@/api/calendar";
import { chatsApi } from "@/api/chats";
import { heartbeatsApi } from "@/api/heartbeats";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { formatSidebarAgentLabel } from "@/lib/agent-labels";
import { projectColorAccent, projectColorBackgroundStyle } from "@/lib/project-colors";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import {
  RECENT_ISSUES_CHANGED_EVENT,
  readRecentIssueIds,
  recordRecentIssue,
  resolveRecentIssues,
} from "@/lib/recent-issues";
import {
  deleteIssueCustomView,
  ISSUE_CUSTOM_VIEWS_CHANGED_EVENT,
  readIssueCustomViews,
  type IssueCustomView,
} from "@/lib/issue-custom-views";
import { isFollowingIssue } from "@/lib/issue-scope-filters";
import {
  ISSUE_DRAFT_CHANGED_EVENT,
  summarizeIssueDrafts,
} from "@/lib/new-issue-dialog";
import { AgentIcon } from "@/components/AgentIconPicker";
import { AgentActionsMenu } from "@/components/AgentActionsMenu";
import { MessengerContextSidebar } from "@/components/MessengerContextSidebar";
import { StatusIcon } from "@/components/StatusIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExactTimestampTooltip } from "@/components/HoverTimestamp";
import { Checkbox } from "@/components/ui/checkbox";
import { CALENDAR_EVENT_STATUS_OPTIONS, useCalendarWorkspace } from "@/context/CalendarWorkspaceContext";
import type { CalendarEventStatus, CalendarSource, Issue } from "@rudderhq/shared";

const RECENT_ISSUES_COLLAPSED_LIMIT = 5;
const RECENT_ISSUES_EXPANDED_LIMIT = 12;
const LINEAR_PLUGIN_KEY = "rudder.linear";
const LINEAR_CATALOG_DATA_KEY = "linear-catalog";
const LINEAR_PLUGIN_ROUTE_PATH = "linear";

type LinearSidebarItem = {
  id: string;
  name: string;
  kind: "project" | "team";
  teamId?: string;
};

type LinearSidebarCatalog = {
  orgId: string;
  projects: Array<{ id: string; name: string; teamIds?: string[] }>;
  teams: Array<{ id: string; name: string }>;
};

function resolveLinearPageContribution(contributions: PluginUiContribution[] | undefined) {
  const contribution = contributions?.find((entry) => entry.pluginKey === LINEAR_PLUGIN_KEY);
  if (!contribution) return null;
  const pageSlot = contribution.slots.find((slot) => slot.type === "page");
  if (!pageSlot) return null;
  return {
    pluginId: contribution.pluginId,
    routePath: pageSlot.routePath || LINEAR_PLUGIN_ROUTE_PATH,
  };
}

function linearIssueSourceHref(item: LinearSidebarItem): string {
  const params = new URLSearchParams();
  params.set("source", "linear");
  if (item.kind === "team") {
    params.set("linearTeamId", item.id);
  } else {
    if (item.teamId) params.set("linearTeamId", item.teamId);
    params.set("linearProjectId", item.id);
  }
  return `/issues?${params.toString()}`;
}

function SectionLabel({
  children,
  action,
  testId,
}: {
  children: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="group flex items-center justify-between px-3.5 pt-3.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/72"
    >
      <span>{children}</span>
      {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
    </div>
  );
}

function ContextColumnHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <header
      data-testid="workspace-context-header"
      className="workspace-card-header workspace-context-header desktop-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3"
    >
      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
      {!isMobile ? (
        <button
          type="button"
          aria-label="Collapse workspace sidebar"
          title="Collapse workspace sidebar"
          className="desktop-window-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      ) : null}
    </header>
  );
}

function resolveContextColumnHeader(relativePath: string): { title: string; description: string } {
  if (/^\/issues(?:\/|$)/.test(relativePath) || /^\/linear(?:\/|$)/.test(relativePath)) {
    return { title: "Issues", description: "Views and project slices" };
  }
  if (/^\/chat(?:\/|$)/.test(relativePath)) {
    return { title: "Chats", description: "Recent conversations" };
  }
  if (/^\/calendar(?:\/|$)/.test(relativePath)) {
    return { title: "Calendar", description: "Sources and filters" };
  }
  if (/^\/(?:org|projects|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativePath)) {
    return { title: "Org", description: "Organization surfaces" };
  }
  return { title: "Agents", description: "" };
}

function calendarStatusLabel(status: CalendarEventStatus) {
  if (status === "in_progress") return "in progress";
  return status;
}

const CALENDAR_LAYER_COLORS = [
  "border-blue-400 bg-blue-500",
  "border-emerald-400 bg-emerald-500",
  "border-amber-400 bg-amber-500",
  "border-rose-400 bg-rose-500",
  "border-cyan-400 bg-cyan-500",
  "border-violet-400 bg-violet-500",
] as const;

const CALENDAR_WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const;

function calendarStartOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function calendarAddDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function calendarDateKey(date: Date | string) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function calendarStartOfMonthGrid(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const day = first.getDay();
  return calendarStartOfDay(calendarAddDays(first, day === 0 ? -6 : 1 - day));
}

function calendarMonthTitle(date: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);
}

function calendarHeatClass(count: number) {
  if (count >= 8) return "bg-emerald-700 text-white";
  if (count >= 5) return "bg-emerald-600 text-white";
  if (count >= 3) return "bg-emerald-500/80 text-white";
  if (count >= 1) return "bg-emerald-500/35 text-emerald-950 dark:text-emerald-50";
  return "";
}

function setStringSetValue(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string, visible: boolean) {
  setter((current) => {
    const next = new Set(current);
    if (visible) next.delete(id);
    else next.add(id);
    return next;
  });
}

function CalendarMiniMonth({
  cursor,
  setCursor,
  completedIssueCountByDay,
}: {
  cursor: Date;
  setCursor: React.Dispatch<React.SetStateAction<Date>>;
  completedIssueCountByDay: Map<string, number>;
}) {
  const gridStart = calendarStartOfMonthGrid(cursor);
  const days = Array.from({ length: 42 }, (_, index) => calendarAddDays(gridStart, index));
  const todayKey = calendarDateKey(new Date());
  const selectedKey = calendarDateKey(cursor);

  return (
    <section className="px-3.5 pt-3" data-testid="calendar-mini-month">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] px-1.5 py-1 text-left text-sm font-medium text-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)]"
          onClick={() => setCursor((current) => new Date(current.getFullYear(), current.getMonth(), 1))}
        >
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="truncate">{calendarMonthTitle(cursor)}</span>
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous month"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground"
            onClick={() => setCursor((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground"
            onClick={() => setCursor((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-y-1 text-center">
        {CALENDAR_WEEKDAY_LABELS.map((label, index) => (
          <div key={`${label}-${index}`} className="text-[10px] font-medium text-muted-foreground/72">
            {label}
          </div>
        ))}
        {days.map((day) => {
          const key = calendarDateKey(day);
          const outside = day.getMonth() !== cursor.getMonth();
          const selected = key === selectedKey;
          const today = key === todayKey;
          const completedCount = completedIssueCountByDay.get(key) ?? 0;
          const showHeat = completedCount > 0 && !today && !selected;
          return (
            <button
              key={key}
              type="button"
              aria-label={`${key}${completedCount > 0 ? `, ${completedCount} completed agent issue${completedCount === 1 ? "" : "s"}` : ""}`}
              title={completedCount > 0 ? `${completedCount} completed agent issue${completedCount === 1 ? "" : "s"}` : undefined}
              className={cn(
                "mx-auto flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-xs transition-[background-color,color,box-shadow]",
                outside && !today ? "text-muted-foreground/45" : "text-foreground/88",
                showHeat && calendarHeatClass(completedCount),
                today && "bg-primary text-primary-foreground shadow-sm ring-2 ring-background",
                !today && selected && "bg-[color:color-mix(in_oklab,var(--surface-elevated)_82%,var(--surface-active))] text-foreground ring-1 ring-primary/65",
                !today && !selected && "hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)]",
              )}
              onClick={() => setCursor(calendarStartOfDay(day))}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function VisibilityLayerRow({
  label,
  visible,
  onToggle,
  icon: Icon,
  colorClass,
}: {
  label: string;
  visible: boolean;
  onToggle: () => void;
  icon?: typeof UserRound;
  colorClass?: string;
}) {
  const EyeIcon = visible ? Eye : EyeOff;
  return (
    <button
      type="button"
      aria-pressed={visible}
      aria-label={`${visible ? "Hide" : "Show"} ${label}`}
      onClick={onToggle}
      className={cn(
        "group mx-1.5 flex min-h-9 w-[calc(100%-0.75rem)] items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-3 py-2 text-left text-sm transition-[background-color,color]",
        "text-foreground/88 hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)]",
        !visible && "text-muted-foreground",
      )}
    >
      {colorClass ? (
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm border", colorClass, !visible && "opacity-35 grayscale")} />
      ) : Icon ? (
        <Icon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", !visible && "opacity-45")} />
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      <span
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:var(--surface-page)] hover:text-foreground group-hover:opacity-100 group-focus-visible:opacity-100",
          !visible && "text-muted-foreground/70",
        )}
      >
        <EyeIcon className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function activeConversationIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/(?:messenger\/chat|chat)\/([^/]+)\/?/);
  return match?.[1] ?? null;
}

function ContextItem({
  to,
  icon: Icon,
  label,
  active,
  slidingActiveIndicator = false,
  testId,
}: {
  to: string;
  icon: typeof UserRound;
  label: string;
  active?: boolean;
  slidingActiveIndicator?: boolean;
  testId?: string;
}) {
  return (
    <Link
      to={to}
      data-testid={testId}
      className={cn(
        "relative z-10 mx-1.5 flex items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-3 py-2 text-sm transition-[background-color,border-color,color]",
        slidingActiveIndicator && "min-h-[var(--motion-context-item-height)]",
        slidingActiveIndicator
          ? active
            ? "font-medium text-foreground"
            : "text-foreground/78 hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground"
          : active
            ? "border-[color:color-mix(in_oklab,var(--border-soft)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_92%,var(--surface-active))] font-medium text-foreground"
            : "text-foreground/78 hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function activeContextStyle(activeIndex: number): CSSProperties | undefined {
  return activeIndex >= 0
    ? ({ "--motion-context-active-index": activeIndex } as CSSProperties)
    : undefined;
}

function SlidingContextNav({
  activeIndex,
  ariaLabel,
  className,
  indicatorTestId,
  children,
}: {
  activeIndex: number;
  ariaLabel: string;
  className?: string;
  indicatorTestId?: string;
  children: ReactNode;
}) {
  return (
    <nav
      className={cn("motion-context-nav", className)}
      style={activeContextStyle(activeIndex)}
      data-active-index={activeIndex >= 0 ? activeIndex : undefined}
      aria-label={ariaLabel}
    >
      {activeIndex >= 0 ? (
        <span
          data-testid={indicatorTestId}
          className="motion-context-active-indicator"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </nav>
  );
}

function SidebarLiveCount({ count }: { count: number }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{count} live</span>
    </span>
  );
}

function ProjectListSection({
  visibleProjects,
  activeProjectRef,
  closeMobileSidebar,
  onNewProject,
}: {
  visibleProjects: Array<{ id: string; name: string; description: string | null; color?: string | null; urlKey?: string | null }>;
  activeProjectRef: string | null;
  closeMobileSidebar: () => void;
  onNewProject: () => void;
}) {
  const activeProjectIndex = visibleProjects.findIndex((project) => activeProjectRef === projectRouteRef(project));

  return (
    <>
      <SectionLabel
        testId="workspace-projects-section"
        action={(
          <button
            type="button"
            onClick={onNewProject}
            aria-label="New project"
            title="Create project"
            className={cn(
              "inline-flex h-5 w-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground/72 transition-[opacity,background-color,color]",
              "hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_82%,transparent)] hover:text-foreground",
              "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      >
        Projects
      </SectionLabel>
      <SlidingContextNav
        activeIndex={activeProjectIndex}
        ariaLabel="Project workspaces"
        className="motion-context-nav--project-card-list mt-2 min-h-0 flex-1 overflow-y-auto pb-3.5"
        indicatorTestId="project-sidebar-active-indicator"
      >
        {visibleProjects.map((project) => {
          const routeRef = projectRouteRef(project);
          const active = activeProjectRef === routeRef;
          return (
            <Link
              key={project.id}
              to={`/projects/${routeRef}/configuration`}
              onClick={closeMobileSidebar}
              className={cn(
                "relative z-10 mx-1.5 min-h-[var(--motion-context-item-height)] rounded-[calc(var(--radius-sm)-1px)] px-3.5 py-2.5 transition-colors",
                active
                  ? "font-medium text-foreground"
                  : "text-foreground/88 hover:bg-[color:color-mix(in_oklab,var(--surface-active)_54%,transparent)]",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  data-testid={`workspace-project-color-${project.id}`}
                  className="h-4 w-4 shrink-0 rounded-[calc(var(--radius-sm)-3px)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,white_20%,transparent),0_0_0_1px_color-mix(in_oklab,var(--border-base)_72%,transparent)]"
                  style={projectColorBackgroundStyle(project.color)}
                />
                <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {project.description || "Project workspace"}
              </div>
            </Link>
          );
        })}
      </SlidingContextNav>
    </>
  );
}

function RecentIssueListSection({
  issues,
  activeIssueRef,
  closeMobileSidebar,
  onOpenIssue,
}: {
  issues: Issue[];
  activeIssueRef: string | null;
  closeMobileSidebar: () => void;
  onOpenIssue: (issue: Issue) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (issues.length === 0) return null;

  const visibleLimit = expanded ? RECENT_ISSUES_EXPANDED_LIMIT : RECENT_ISSUES_COLLAPSED_LIMIT;
  const visibleIssues = issues.slice(0, visibleLimit);
  const expandCount = Math.min(issues.length, RECENT_ISSUES_EXPANDED_LIMIT) - RECENT_ISSUES_COLLAPSED_LIMIT;
  const hasMoreThanExpandedLimit = issues.length > RECENT_ISSUES_EXPANDED_LIMIT;

  return (
    <section aria-label="Recently viewed issues" className="mt-1">
      <SectionLabel testId="issue-recent-section">Recently Viewed</SectionLabel>
      <div
        data-testid="issue-recent-list"
        className={cn(
          "mt-2 space-y-0.5",
          expanded && "max-h-72 overflow-y-auto pr-1",
        )}
      >
        {visibleIssues.map((issue) => {
          const issueRef = issue.identifier ?? issue.id;
          const active = activeIssueRef === issueRef || activeIssueRef === issue.id;
          return (
            <Link
              key={issue.id}
              to={issueUrl(issue)}
              onClick={() => {
                onOpenIssue(issue);
                closeMobileSidebar();
              }}
              data-testid={`issue-recent-row-${issue.id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center gap-2.5 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-3 py-2 text-sm transition-[background-color,border-color,color]",
                active
                  ? "border-[color:color-mix(in_oklab,var(--border-soft)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_92%,var(--surface-active))] font-medium text-foreground"
                  : "text-muted-foreground hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground",
              )}
            >
              <span className="shrink-0">
                <StatusIcon status={issue.status} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {issue.title}
              </span>
            </Link>
          );
        })}
      </div>
      {expanded && hasMoreThanExpandedLimit ? (
        <div className="mx-4 mt-1 truncate text-[11px] text-muted-foreground/70">
          Showing latest {RECENT_ISSUES_EXPANDED_LIMIT} of {issues.length}
        </div>
      ) : null}
      {issues.length > RECENT_ISSUES_COLLAPSED_LIMIT ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          data-testid="issue-recent-toggle"
          className="mx-1.5 mt-1 flex min-h-8 w-[calc(100%-0.75rem)] items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-3 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          <span>{expanded ? "Show less" : `Show ${expandCount} more`}</span>
        </button>
      ) : null}
    </section>
  );
}

function CustomIssueViewsSection({
  views,
  activeViewId,
  closeMobileSidebar,
  onDeleteView,
}: {
  views: IssueCustomView[];
  activeViewId: string;
  closeMobileSidebar: () => void;
  onDeleteView: (view: IssueCustomView) => void;
}) {
  if (views.length === 0) return null;

  const activeIndex = views.findIndex((view) => view.id === activeViewId);

  return (
    <section aria-label="Custom issue boards" className="mt-1">
      <SectionLabel testId="issue-custom-views-section">Custom Boards</SectionLabel>
      <SlidingContextNav
        activeIndex={activeIndex}
        ariaLabel="Custom issue boards"
        className="mt-2"
        indicatorTestId="issue-custom-view-sidebar-active-indicator"
      >
        {views.map((view) => {
          const active = view.id === activeViewId;
          return (
            <div
              key={view.id}
              data-testid={`issue-custom-view-row-${view.id}`}
              className={cn(
                "group/custom-view relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center rounded-[calc(var(--radius-sm)-1px)] border border-transparent text-sm transition-[background-color,border-color,color]",
                active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground",
              )}
            >
              <Link
                to={`/issues?view=${encodeURIComponent(view.id)}`}
                onClick={closeMobileSidebar}
                className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-2 pl-3 pr-1 no-underline text-inherit"
                aria-current={active ? "page" : undefined}
              >
                <Columns3 className="h-4 w-4 shrink-0" />
                <span className="truncate">{view.name}</span>
              </Link>
              <button
                type="button"
                aria-label={`Delete custom board ${view.name}`}
                title="Delete custom board"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteView(view);
                }}
                className={cn(
                  "mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground transition-[opacity,background-color,color]",
                  "hover:bg-[color:color-mix(in_oklab,var(--destructive)_14%,transparent)] hover:text-destructive",
                  "opacity-100 md:opacity-0 md:group-hover/custom-view:opacity-100 md:group-focus-within/custom-view:opacity-100",
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </SlidingContextNav>
    </section>
  );
}

export function ThreeColumnContextSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const contextHeader = useMemo(() => resolveContextColumnHeader(relativePath), [relativePath]);
  const isMessengerRoute = /^\/messenger(?:\/|$)/.test(relativePath);
  const isCalendarRoute = /^\/calendar(?:\/|$)/.test(relativePath);
  const isLinearPluginRoute = /^\/linear(?:\/|$)/.test(relativePath);
  const isIssuesRoute = /^\/issues(?:\/|$)/.test(relativePath) || isLinearPluginRoute;
  const isOrgWorkspaceRoute = /^\/(?:org|projects|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativePath);
  const isChatRoute = /^\/chat(?:\/|$)/.test(relativePath);
  const isAgentRoute = !isMessengerRoute && !isIssuesRoute && !isCalendarRoute && !isOrgWorkspaceRoute && !isChatRoute;
  const { selectedOrganizationId } = useOrganization();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pushToast } = useToast();
  const { openNewAgent, openNewProject } = useDialog();
  const queryClient = useQueryClient();
  const calendarSidebarScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:calendar");
  const {
    cursor,
    setCursor,
    hiddenAgentIds,
    setHiddenAgentIds,
    hiddenSourceIds,
    setHiddenSourceIds,
    myCalendarVisible,
    setMyCalendarVisible,
    visibleStatuses,
    setVisibleStatuses,
    setGoogleCalendarModalOpen,
  } = useCalendarWorkspace();

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: chats } = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"),
    enabled: !!selectedOrganizationId,
  });
  const { data: calendarSources } = useQuery({
    queryKey: queryKeys.calendar.sources(selectedOrganizationId ?? "__none__"),
    queryFn: () => calendarApi.sources(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && isCalendarRoute,
  });
  const updateCalendarSourceMutation = useMutation({
    mutationFn: ({ sourceId, status }: { sourceId: string; status: CalendarSource["status"] }) =>
      calendarApi.updateSource(selectedOrganizationId!, sourceId, { status }),
    onSuccess: async () => {
      if (!selectedOrganizationId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.calendar.sources(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: ["calendar", selectedOrganizationId] }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update calendar source",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedOrganizationId ?? "__none__"),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && (isAgentRoute || isIssuesRoute),
    refetchInterval: 10_000,
  });
  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && isIssuesRoute,
  });
  const { data: pluginContributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: !!selectedOrganizationId && isIssuesRoute,
  });
  const { data: calendarCompletedIssues } = useQuery({
    queryKey: ["calendar", selectedOrganizationId ?? "__none__", "completed-issue-heatmap"],
    queryFn: () => issuesApi.list(selectedOrganizationId!, { status: "done" }),
    enabled: !!selectedOrganizationId && isCalendarRoute,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const rawScope = new URLSearchParams(location.search).get("scope") ?? "";
  const scope = rawScope === "recent" ? "" : rawScope;
  const selectedIssueSource = new URLSearchParams(location.search).get("source") ?? "";
  const activeCustomViewId = new URLSearchParams(location.search).get("view") ?? "";
  const selectedProjectId = new URLSearchParams(location.search).get("projectId") ?? "";
  const selectedLinearProjectId = new URLSearchParams(location.search).get("linearProjectId") ?? "";
  const selectedLinearTeamId = new URLSearchParams(location.search).get("linearTeamId") ?? "";
  const activeConversationId = activeConversationIdFromPath(location.pathname);
  const activeAgentRef = location.pathname.match(/\/agents\/([^/]+)/)?.[1] ?? null;
  const activeProjectRef = location.pathname.match(/\/projects\/([^/]+)/)?.[1] ?? null;
  const activeIssueRef = location.pathname.match(/\/issues\/([^/]+)/)?.[1] ?? null;

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt),
    [projects],
  );
  const linearPageContribution = useMemo(
    () => resolveLinearPageContribution(pluginContributions),
    [pluginContributions],
  );
  const { data: linearCatalog } = useQuery({
    queryKey: [
      "plugins",
      LINEAR_PLUGIN_KEY,
      "catalog",
      selectedOrganizationId ?? "__none__",
      linearPageContribution?.pluginId ?? "__none__",
    ] as const,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(
        linearPageContribution!.pluginId,
        LINEAR_CATALOG_DATA_KEY,
        { orgId: selectedOrganizationId! },
        selectedOrganizationId,
      );
      return response.data as LinearSidebarCatalog;
    },
    enabled: !!selectedOrganizationId && !!linearPageContribution?.pluginId && isIssuesRoute,
  });
  const linearSidebarItems = useMemo<LinearSidebarItem[]>(() => {
    const projects = [...(linearCatalog?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const teams = [...(linearCatalog?.teams ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (teams.length === 0) {
      return projects.map((project) => ({ ...project, kind: "project" as const }));
    }

    const items: LinearSidebarItem[] = [];
    const groupedProjectIds = new Set<string>();
    for (const team of teams) {
      items.push({ ...team, kind: "team" });
      for (const project of projects) {
        const teamIds = project.teamIds ?? [];
        if (!teamIds.includes(team.id)) continue;
        groupedProjectIds.add(project.id);
        items.push({
          id: project.id,
          name: project.name,
          kind: "project",
          teamId: team.id,
        });
      }
    }

    for (const project of projects) {
      if (groupedProjectIds.has(project.id)) continue;
      items.push({ ...project, kind: "project" });
    }

    return items;
  }, [linearCatalog?.projects, linearCatalog?.teams]);
  const visibleAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.status !== "terminated").sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );
  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);
  const liveCountByProject = useMemo(() => {
    const issueProjectIds = new Map<string, string>();
    for (const issue of allIssues ?? []) {
      if (issue.projectId) issueProjectIds.set(issue.id, issue.projectId);
    }

    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      if (!run.issueId) continue;
      const projectId = issueProjectIds.get(run.issueId);
      if (!projectId) continue;
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
    return counts;
  }, [allIssues, liveRuns]);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [googleExpanded, setGoogleExpanded] = useState(true);
  const [issueDraftSummaries, setIssueDraftSummaries] = useState(() => summarizeIssueDrafts(selectedOrganizationId));
  const [recentIssueIds, setRecentIssueIds] = useState<string[]>(() => readRecentIssueIds(selectedOrganizationId));
  const [customIssueViews, setCustomIssueViews] = useState<IssueCustomView[]>(() => readIssueCustomViews(selectedOrganizationId));
  const recentIssueRefs = useMemo(
    () => resolveRecentIssues(recentIssueIds, allIssues ?? []),
    [allIssues, recentIssueIds],
  );
  const followingIssueCount = useMemo(() => {
    if (!currentUserId) return 0;
    return (allIssues ?? []).filter((issue) => isFollowingIssue(issue, currentUserId)).length;
  }, [allIssues, currentUserId]);
  const issueContextItems = [
    {
      key: "all",
      to: "/issues",
      icon: Circle,
      label: "All Issues",
      active: selectedIssueSource !== "linear" && scope === "" && !selectedProjectId && !activeCustomViewId,
    },
    ...(issueDraftSummaries.length > 0
      ? [{
        key: "drafts",
        to: "/issues?scope=drafts",
        icon: PencilLine,
        label: `Draft Issues (${issueDraftSummaries.length})`,
        active: scope === "drafts",
        testId: "issue-draft-sidebar-entry",
      }]
      : []),
    {
      key: "following",
      to: `/issues${currentUserId ? "?scope=following" : ""}`,
      icon: UserRound,
      label: `Following${followingIssueCount > 0 ? ` (${followingIssueCount})` : ""}`,
      active: scope === "following",
    },
  ];
  const activeIssueContextIndex = issueContextItems.findIndex((item) => item.active);
  const issueProjectActiveIndex = visibleProjects.findIndex((project) => {
    const routeRef = projectRouteRef(project);
    return selectedProjectId === project.id || activeProjectRef === routeRef;
  });
  const issueLinearActiveIndex = linearSidebarItems.findIndex((item) =>
    item.kind === "project"
      ? selectedLinearProjectId === item.id && (!item.teamId || selectedLinearTeamId === item.teamId)
      : selectedIssueSource === "linear" && selectedLinearTeamId === item.id && !selectedLinearProjectId,
  );
  const orgContextItems = [
    { key: "structure", to: "/org", icon: Network, label: "Structure", active: /^\/org(?:\/|$)/.test(relativePath) },
    { key: "resources", to: "/resources", icon: Boxes, label: "Resources", active: /^\/resources(?:\/|$)/.test(relativePath) },
    { key: "heartbeats", to: "/heartbeats", icon: Clock3, label: "Heartbeats", active: /^\/heartbeats(?:\/|$)/.test(relativePath) },
    { key: "workspaces", to: "/workspaces", icon: FolderTree, label: "Workspaces", active: /^\/workspaces(?:\/|$)/.test(relativePath) },
    { key: "goals", to: "/goals", icon: Target, label: "Goals", active: /^\/goals(?:\/|$)/.test(relativePath) },
    { key: "skills", to: "/skills", icon: Boxes, label: "Skills", active: /^\/skills(?:\/|$)/.test(relativePath) },
    { key: "costs", to: "/costs", icon: DollarSign, label: "Costs", active: /^\/costs(?:\/|$)/.test(relativePath) },
    { key: "activity", to: "/activity", icon: History, label: "Activity", active: /^\/activity(?:\/|$)/.test(relativePath) },
  ];
  const activeOrgContextIndex = orgContextItems.findIndex((item) => item.active);
  const activeAgentIndex = visibleAgents.findIndex((agent) => activeAgentRef === agent.urlKey || activeAgentRef === agent.id);
  const googleSources = (calendarSources ?? [])
    .filter((source) => source.type === "google_calendar")
    .sort((a, b) => {
      const primaryDelta = (a.externalCalendarId === "primary" ? 0 : 1) - (b.externalCalendarId === "primary" ? 0 : 1);
      return primaryDelta !== 0 ? primaryDelta : a.name.localeCompare(b.name);
    });
  const activeGoogleSources = googleSources.filter((source) => source.status === "active");
  const googleVisible = googleSources.some((source) => source.status === "active" && !hiddenSourceIds.has(source.id));
  const completedIssueCountByDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of calendarCompletedIssues ?? []) {
      if (!issue.completedAt || !issue.assigneeAgentId) continue;
      const key = calendarDateKey(issue.completedAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [calendarCompletedIssues]);

  useEffect(() => {
    setRecentIssueIds(readRecentIssueIds(selectedOrganizationId));
  }, [location.key, selectedOrganizationId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshRecentIssueIds = () => {
      setRecentIssueIds(readRecentIssueIds(selectedOrganizationId));
    };
    window.addEventListener(RECENT_ISSUES_CHANGED_EVENT, refreshRecentIssueIds);
    window.addEventListener("storage", refreshRecentIssueIds);
    return () => {
      window.removeEventListener(RECENT_ISSUES_CHANGED_EVENT, refreshRecentIssueIds);
      window.removeEventListener("storage", refreshRecentIssueIds);
    };
  }, [selectedOrganizationId]);

  useEffect(() => {
    const refreshIssueDraftSummaries = () => {
      setIssueDraftSummaries(summarizeIssueDrafts(selectedOrganizationId));
    };
    refreshIssueDraftSummaries();
    if (typeof window === "undefined") return;
    window.addEventListener(ISSUE_DRAFT_CHANGED_EVENT, refreshIssueDraftSummaries);
    window.addEventListener("storage", refreshIssueDraftSummaries);
    return () => {
      window.removeEventListener(ISSUE_DRAFT_CHANGED_EVENT, refreshIssueDraftSummaries);
      window.removeEventListener("storage", refreshIssueDraftSummaries);
    };
  }, [selectedOrganizationId]);

  useEffect(() => {
    const refreshCustomIssueViews = () => {
      setCustomIssueViews(readIssueCustomViews(selectedOrganizationId));
    };
    refreshCustomIssueViews();
    if (typeof window === "undefined") return;
    window.addEventListener(ISSUE_CUSTOM_VIEWS_CHANGED_EVENT, refreshCustomIssueViews);
    window.addEventListener("storage", refreshCustomIssueViews);
    return () => {
      window.removeEventListener(ISSUE_CUSTOM_VIEWS_CHANGED_EVENT, refreshCustomIssueViews);
      window.removeEventListener("storage", refreshCustomIssueViews);
    };
  }, [selectedOrganizationId]);

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  const recordRecentIssueOpen = (issue: Issue) => {
    if (!selectedOrganizationId) return;
    setRecentIssueIds(recordRecentIssue(selectedOrganizationId, issue.id, readRecentIssueIds(selectedOrganizationId)));
  };

  const deleteCustomIssueView = (view: IssueCustomView) => {
    if (!selectedOrganizationId) return;
    const confirmed = window.confirm(`Delete custom board "${view.name}"? This cannot be undone.`);
    if (!confirmed) return;
    const nextViews = deleteIssueCustomView(selectedOrganizationId, view.id);
    setCustomIssueViews(nextViews);
    pushToast({ title: "Custom board deleted", tone: "success" });
    if (activeCustomViewId === view.id) {
      navigate("/issues");
    }
  };

  const refreshChatList = async (chatId?: string) => {
    if (!selectedOrganizationId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "active") });
    if (chatId) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(chatId) });
    }
  };

  const updateConversationMutation = useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: Parameters<typeof chatsApi.update>[1] }) =>
      chatsApi.update(chatId, data),
    onSuccess: async (conversation) => {
      if (conversation.status === "archived" && conversation.id === activeConversationId) {
        navigate("/messenger");
      }
      setRenamingConversationId((current) => (current === conversation.id ? null : current));
      await refreshChatList(conversation.id);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update chat",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const updateConversationUserStateMutation = useMutation({
    mutationFn: ({ chatId, pinned }: { chatId: string; pinned: boolean }) =>
      chatsApi.updateUserState(chatId, { pinned }),
    onSuccess: async (conversation) => {
      await refreshChatList(conversation.id);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update chat state",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const submitRename = () => {
    const trimmed = renameDraft.trim();
    if (!renamingConversationId || !trimmed) {
      setRenamingConversationId(null);
      return;
    }
    updateConversationMutation.mutate({
      chatId: renamingConversationId,
      data: { title: trimmed },
    });
  };

  const copyConversationId = async (conversationId: string) => {
    try {
      await navigator.clipboard.writeText(conversationId);
      pushToast({ title: "Chat ID copied", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy chat ID", tone: "error" });
    }
  };

  const toggleGoogleVisibility = () => {
    const nextVisible = !googleVisible;
    const targetSources = nextVisible ? googleSources : activeGoogleSources;
    setHiddenSourceIds((current) => {
      const next = new Set(current);
      for (const source of targetSources) {
        if (nextVisible) next.delete(source.id);
        else next.add(source.id);
      }
      return next;
    });
    for (const source of targetSources) {
      updateCalendarSourceMutation.mutate({
        sourceId: source.id,
        status: nextVisible ? "active" : "paused",
      });
    }
  };

  const toggleGoogleSourceVisibility = (source: CalendarSource) => {
    const nextVisible = !(source.status === "active" && !hiddenSourceIds.has(source.id));
    setStringSetValue(setHiddenSourceIds, source.id, nextVisible);
    updateCalendarSourceMutation.mutate({
      sourceId: source.id,
      status: nextVisible ? "active" : "paused",
    });
  };

  if (isMessengerRoute) {
    return <MessengerContextSidebar />;
  }

  if (isCalendarRoute) {
    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <div ref={calendarSidebarScrollRef} className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto pb-3.5">
          <CalendarMiniMonth
            cursor={cursor}
            setCursor={setCursor}
            completedIssueCountByDay={completedIssueCountByDay}
          />

          <SectionLabel
            action={(
              <button
                type="button"
                aria-label="Import Google Calendar"
                className="inline-flex h-6 w-6 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={() => setGoogleCalendarModalOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          >
            Calendars
          </SectionLabel>
          <div className="mt-2 space-y-0.5">
            <VisibilityLayerRow
              label="My Calendar"
              visible={myCalendarVisible}
              onToggle={() => setMyCalendarVisible((current) => !current)}
              icon={UserRound}
            />
            <div
              className="group mx-1.5 flex min-h-9 items-center gap-1 rounded-[calc(var(--radius-sm)-1px)] px-1.5 py-1 text-sm text-foreground/88 transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)]"
            >
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground hover:bg-[color:var(--surface-page)] hover:text-foreground"
                aria-label={googleExpanded ? "Collapse Google Calendar calendars" : "Expand Google Calendar calendars"}
                onClick={() => setGoogleExpanded((current) => !current)}
              >
                {googleExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                data-testid="calendar-google-row"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-[calc(var(--radius-sm)-2px)] px-1.5 py-1 text-left"
                onClick={() => setGoogleCalendarModalOpen(true)}
              >
                <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Google Calendar</span>
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:var(--surface-page)] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={`${googleVisible ? "Hide" : "Show"} Google Calendar`}
                disabled={googleSources.length === 0 || updateCalendarSourceMutation.isPending}
                onClick={toggleGoogleVisibility}
              >
                {googleVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:var(--surface-page)] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                aria-label="Google Calendar settings"
                onClick={() => setGoogleCalendarModalOpen(true)}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {googleExpanded && googleSources.length > 0 ? (
              <div className="ml-9 mr-2 space-y-0.5" data-testid="calendar-google-source-list">
                {googleSources.map((source, index) => {
                  const visible = source.status === "active" && !hiddenSourceIds.has(source.id);
                  const EyeIcon = visible ? Eye : EyeOff;
                  return (
                    <button
                      type="button"
                      key={source.id}
                      data-testid={`calendar-google-source-row-${source.id}`}
                      disabled={updateCalendarSourceMutation.isPending}
                      aria-label={`${visible ? "Disable" : "Enable"} ${source.name}`}
                      className={cn(
                        "group/source flex min-h-7 w-full items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-2 py-1 text-left text-xs text-foreground/82 hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] disabled:cursor-not-allowed disabled:opacity-60",
                        !visible && "text-muted-foreground",
                      )}
                      onClick={() => toggleGoogleSourceVisibility(source)}
                    >
                      <span className={cn("h-2 w-2 shrink-0 rounded-sm border", CALENDAR_LAYER_COLORS[index % CALENDAR_LAYER_COLORS.length], !visible && "opacity-35 grayscale")} />
                      <span className="min-w-0 flex-1 truncate" title={source.name}>{source.name}</span>
                      {source.status !== "active" ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">Off</span>
                      ) : null}
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:var(--surface-page)] hover:text-foreground group-hover/source:opacity-100 group-focus-visible/source:opacity-100">
                        <EyeIcon className="h-3 w-3" />
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <SectionLabel>Agents</SectionLabel>
          <div className="mt-2 space-y-0.5">
            {visibleAgents.map((agent, index) => (
              <VisibilityLayerRow
                key={agent.id}
                label={formatSidebarAgentLabel(agent)}
                visible={!hiddenAgentIds.has(agent.id)}
                onToggle={() => setStringSetValue(setHiddenAgentIds, agent.id, hiddenAgentIds.has(agent.id))}
                colorClass={CALENDAR_LAYER_COLORS[index % CALENDAR_LAYER_COLORS.length]}
              />
            ))}
          </div>

          <SectionLabel>Status</SectionLabel>
          <div className="mt-2 space-y-0.5" data-testid="calendar-status-filters">
            {CALENDAR_EVENT_STATUS_OPTIONS.map((status) => (
              <label
                key={status}
                className="mx-1.5 flex min-h-8 items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-3 py-1.5 text-sm text-foreground/88 hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)]"
              >
                <Checkbox
                  checked={visibleStatuses.has(status)}
                  onCheckedChange={(checked) => {
                    setVisibleStatuses((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(status);
                      else next.delete(status);
                      return next;
                    });
                  }}
                  aria-label={`Show ${calendarStatusLabel(status)} events`}
                />
                <span className="truncate">{calendarStatusLabel(status)}</span>
              </label>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  if (isIssuesRoute) {
    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <SectionLabel>Issues</SectionLabel>
        <SlidingContextNav
          activeIndex={activeIssueContextIndex}
          ariaLabel="Issue views"
          className="mt-2"
          indicatorTestId="issue-sidebar-active-indicator"
        >
          {issueContextItems.map((item) => (
            <ContextItem
              key={item.key}
              to={item.to}
              icon={item.icon}
              label={item.label}
              active={item.active}
              testId={item.testId}
              slidingActiveIndicator
            />
          ))}
        </SlidingContextNav>

        <div className="min-h-0 flex-1 overflow-y-auto pb-3.5">
          <CustomIssueViewsSection
            views={customIssueViews}
            activeViewId={activeCustomViewId}
            closeMobileSidebar={closeMobileSidebar}
            onDeleteView={deleteCustomIssueView}
          />
          <RecentIssueListSection
            issues={recentIssueRefs}
            activeIssueRef={activeIssueRef}
            closeMobileSidebar={closeMobileSidebar}
            onOpenIssue={recordRecentIssueOpen}
          />
          <SectionLabel testId="workspace-projects-section">Projects</SectionLabel>
          <SlidingContextNav
            activeIndex={issueProjectActiveIndex}
            ariaLabel="Issue project slices"
            className="mt-2"
            indicatorTestId="issue-project-sidebar-active-indicator"
          >
            {visibleProjects.map((project) => {
              const routeRef = projectRouteRef(project);
              const active = selectedProjectId === project.id || activeProjectRef === routeRef;
              const liveCount = liveCountByProject.get(project.id) ?? 0;
              return (
                <Link
                  key={project.id}
                  to={`/issues?projectId=${project.id}`}
                  onClick={closeMobileSidebar}
                  data-testid={`issue-project-row-${project.id}`}
                  className={cn(
                    "relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-3 py-2 text-sm transition-[background-color,border-color,color]",
                    active
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground",
                  )}
                >
                  <Circle
                    data-testid={`issue-project-color-${project.id}`}
                    className="h-2.5 w-2.5 shrink-0 fill-current"
                    style={{ color: projectColorAccent(project.color) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {liveCount > 0 ? <SidebarLiveCount count={liveCount} /> : null}
                </Link>
              );
            })}
          </SlidingContextNav>
          {linearSidebarItems.length > 0 ? (
            <>
              <SectionLabel
                testId="issue-linear-section"
                action={(
                  <span
                    title="External source"
                    className="inline-flex items-center gap-1 rounded-[calc(var(--radius-sm)-2px)] border border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground/78"
                  >
                    <ExternalLink className="h-3 w-3" />
                    External
                  </span>
                )}
              >
                Linear
              </SectionLabel>
              <SlidingContextNav
                activeIndex={issueLinearActiveIndex}
                ariaLabel="Linear issue source slices"
                className="mt-2"
                indicatorTestId="issue-linear-sidebar-active-indicator"
              >
                {linearSidebarItems.map((item) => {
                  const active = item.kind === "project"
                    ? selectedLinearProjectId === item.id && (!item.teamId || selectedLinearTeamId === item.teamId)
                    : selectedIssueSource === "linear" && selectedLinearTeamId === item.id && !selectedLinearProjectId;
                  return (
                    <Link
                      key={`${item.kind}-${item.id}`}
                      to={linearIssueSourceHref(item)}
                      onClick={closeMobileSidebar}
                      data-testid={`issue-linear-${item.kind}-${item.id}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-3 py-2 text-sm transition-[background-color,border-color,color]",
                        item.kind === "project" && item.teamId ? "ml-6 min-h-8 py-1.5 text-xs" : "",
                        active
                          ? "font-medium text-foreground"
                          : "text-muted-foreground hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground",
                      )}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-[calc(var(--radius-sm)-4px)] border border-[color:color-mix(in_oklab,var(--muted-foreground)_54%,transparent)] bg-[color:color-mix(in_oklab,var(--muted-foreground)_18%,transparent)]" />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    </Link>
                  );
                })}
              </SlidingContextNav>
            </>
          ) : null}
        </div>
      </aside>
    );
  }

  if (isOrgWorkspaceRoute) {
    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <div className="flex min-h-0 flex-1 flex-col">
          <SectionLabel>Org</SectionLabel>
          <SlidingContextNav
            activeIndex={activeOrgContextIndex}
            ariaLabel="Organization workspaces"
            className="mt-2"
            indicatorTestId="org-sidebar-active-indicator"
          >
            {orgContextItems.map((item) => (
              <ContextItem
                key={item.key}
                to={item.to}
                icon={item.icon}
                label={item.label}
                active={item.active}
                slidingActiveIndicator
              />
            ))}
          </SlidingContextNav>
          <ProjectListSection
            visibleProjects={visibleProjects}
            activeProjectRef={activeProjectRef}
            closeMobileSidebar={closeMobileSidebar}
            onNewProject={openNewProject}
          />
        </div>
      </aside>
    );
  }

  if (isChatRoute) {
    if (!activeConversationId && (chats?.length ?? 0) === 0) {
      return null;
    }

    const pinnedChats = (chats ?? []).filter((conversation) => conversation.isPinned);
    const recentChats = (chats ?? []).filter((conversation) => !conversation.isPinned);

    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar chat-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 py-2.5">
          <Link
            to="/messenger/chat"
            onClick={closeMobileSidebar}
            className={cn(
              "flex items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border px-3 py-2.5 text-sm transition-[background-color,border-color,color]",
              !activeConversationId
                ? "surface-active border-[color:var(--border-strong)] text-[color:var(--accent-strong)]"
                : "border-transparent text-foreground/88 hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)] hover:text-foreground",
            )}
          >
            <MessageSquare className="h-4 w-4 shrink-0" />
            <div className="truncate font-medium">New Chat</div>
          </Link>

          {pinnedChats.length > 0 ? (
            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/72">
              Pinned
            </div>
          ) : null}
          {pinnedChats.map((conversation) => (
            <ExactTimestampTooltip key={conversation.id} date={conversation.lastMessageAt ?? conversation.updatedAt}>
              <div
                data-testid={`chat-sidebar-conversation-${conversation.id}`}
                className={cn(
                  "group relative rounded-[calc(var(--radius-sm)-1px)] border px-3 py-1.5 transition-[background-color,border-color,color]",
                  activeConversationId === conversation.id
                    ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_86%,var(--surface-elevated))]"
                    : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
                )}
              >
              {renamingConversationId === conversation.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={submitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingConversationId(null);
                    }
                  }}
                  className="min-h-0 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm outline-none"
                />
              ) : (
                <>
                  <Link
                    to={`/messenger/chat/${conversation.id}`}
                    onClick={closeMobileSidebar}
                    className="block min-w-0 pr-12"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[13px] font-medium leading-tight text-foreground">
                          <span className="truncate">{conversation.title}</span>
                          {conversation.isUnread ? (
                            <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" />
                          ) : null}
                        </div>
                      </div>
                      <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0">
                        {relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}
                      </span>
                    </div>
                  </Link>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label="Chat actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenamingConversationId(conversation.id);
                          setRenameDraft(conversation.title);
                        }}
                      >
                        <PencilLine className="h-4 w-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationUserStateMutation.mutate({
                            chatId: conversation.id,
                            pinned: false,
                          });
                        }}
                      >
                        <PinOff className="h-4 w-4" />
                        Unpin
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void copyConversationId(conversation.id)}>
                        <Copy className="h-4 w-4" />
                        Copy chat ID
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationMutation.mutate({
                            chatId: conversation.id,
                            data: { status: "archived" },
                          });
                        }}
                      >
                        <Archive className="h-4 w-4" />
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              </div>
            </ExactTimestampTooltip>
          ))}
          {recentChats.length > 0 ? (
            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/72">
              Recent
            </div>
          ) : null}
          {recentChats.map((conversation) => (
            <ExactTimestampTooltip key={conversation.id} date={conversation.lastMessageAt ?? conversation.updatedAt}>
              <div
                data-testid={`chat-sidebar-conversation-${conversation.id}`}
                className={cn(
                  "group relative rounded-[calc(var(--radius-sm)-1px)] border px-3 py-1.5 transition-[background-color,border-color,color]",
                  activeConversationId === conversation.id
                    ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_86%,var(--surface-elevated))]"
                    : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
                )}
              >
              {renamingConversationId === conversation.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={submitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingConversationId(null);
                    }
                  }}
                  className="min-h-0 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm outline-none"
                />
              ) : (
                <>
                  <Link
                    to={`/messenger/chat/${conversation.id}`}
                    onClick={closeMobileSidebar}
                    className="block min-w-0 pr-12"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[13px] font-medium leading-tight text-foreground">
                          <span className="truncate">{conversation.title}</span>
                          {conversation.isUnread ? (
                            <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" />
                          ) : null}
                        </div>
                      </div>
                      <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0">
                        {relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}
                      </span>
                    </div>
                  </Link>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label="Chat actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenamingConversationId(conversation.id);
                          setRenameDraft(conversation.title);
                        }}
                      >
                        <PencilLine className="h-4 w-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationUserStateMutation.mutate({
                            chatId: conversation.id,
                            pinned: true,
                          });
                        }}
                      >
                        <Pin className="h-4 w-4" />
                        Pin
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void copyConversationId(conversation.id)}>
                        <Copy className="h-4 w-4" />
                        Copy chat ID
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationMutation.mutate({
                            chatId: conversation.id,
                            data: { status: "archived" },
                          });
                        }}
                      >
                        <Archive className="h-4 w-4" />
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              </div>
            </ExactTimestampTooltip>
          ))}
        </nav>
      </aside>
    );
  }

  return (
    <aside
      data-testid="workspace-sidebar"
      className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
    >
      <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
      <SectionLabel
        testId="agents-team-section"
        action={(
          <div className="flex items-center">
            <button
              type="button"
              onClick={openNewAgent}
              aria-label="New agent"
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground/72 transition-[opacity,background-color,color]",
                "hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_82%,transparent)] hover:text-foreground",
                "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      >
        Team
      </SectionLabel>
      <SlidingContextNav
        activeIndex={activeAgentIndex}
        ariaLabel="Agent team"
        className="motion-context-nav--agent-list mt-2 min-h-0 flex-1 overflow-y-auto pb-3.5"
        indicatorTestId="agent-sidebar-active-indicator"
      >
        {visibleAgents.map((agent) => {
          const liveCount = liveCountByAgent.get(agent.id) ?? 0;
          const active = activeAgentRef === agent.urlKey || activeAgentRef === agent.id;
          return (
            <div
              key={agent.id}
              data-testid={`agent-sidebar-row-${agent.id}`}
              className={cn(
                "group/agent-sidebar-row relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center rounded-[calc(var(--radius-sm)-1px)] text-sm transition-colors",
                active
                  ? "font-medium text-foreground"
                  : "text-foreground/80 hover:bg-[color:color-mix(in_oklab,var(--surface-active)_54%,transparent)]",
              )}
            >
              <Link
                to={agentUrl(agent)}
                onClick={closeMobileSidebar}
                className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-2.5 pl-3.5 pr-1 no-underline text-inherit"
              >
                <AgentIcon icon={agent.icon} role={agent.role} className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate" title={formatSidebarAgentLabel(agent)}>
                  {formatSidebarAgentLabel(agent)}
                </span>
                {liveCount > 0 ? <SidebarLiveCount count={liveCount} /> : null}
              </Link>
              <AgentActionsMenu
                agent={agent}
                orgId={selectedOrganizationId ?? agent.orgId}
                triggerTestId={`agent-sidebar-actions-${agent.id}`}
                triggerClassName="mr-2 h-6 w-6"
                visibilityClassName="opacity-100 md:opacity-0 md:group-hover/agent-sidebar-row:opacity-100 md:group-focus-within/agent-sidebar-row:opacity-100"
                onActionComplete={closeMobileSidebar}
              />
            </div>
          );
        })}
      </SlidingContextNav>
    </aside>
  );
}
