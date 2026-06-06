import { Link, useLocation, useNavigate } from "@/lib/router";
import { CircleHelp, Menu, PanelLeftOpen, Plus, Search } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useOrganization } from "../context/OrganizationContext";
import { useDialog } from "@/context/DialogContext";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { useI18n } from "@/context/I18nContext";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { DashboardCalendarSwitcher } from "@/components/DashboardCalendarSwitcher";
import { StatusIcon } from "@/components/StatusIcon";
import type { Issue } from "@rudderhq/shared";

type GlobalToolbarContext = { orgId: string | null; orgPrefix: string | null };

type BreadcrumbBarProps = {
  desktopChrome?: boolean;
  variant?: "shell" | "card";
};

function isNativeFindShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented) return false;
  if (event.key.toLowerCase() !== "f") return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return !event.altKey && !event.shiftKey;
}

function GlobalToolbarPlugins({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], orgId: context.orgId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], orgId: context.orgId, enabled: !!context.orgId });
  if (slots.length === 0 && launchers.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
    </div>
  );
}

function issueResultLabel(issue: Pick<Issue, "id" | "identifier">) {
  return issue.identifier ?? issue.id.slice(0, 8);
}

export function BreadcrumbBar({
  desktopChrome = false,
  variant = "shell",
}: BreadcrumbBarProps = {}) {
  const { t } = useI18n();
  const { breadcrumbs, headerActions } = useBreadcrumbs();
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const { openNewIssue, openNewProject } = useDialog();
  const location = useLocation();
  const navigate = useNavigate();
  const [issueSearch, setIssueSearch] = useState("");
  const [issueSearchMenuOpen, setIssueSearchMenuOpen] = useState(false);
  const issueSearchInputRef = useRef<HTMLInputElement | null>(null);
  const issueSearchContainerRef = useRef<HTMLDivElement | null>(null);
  const relativePath = useMemo(() => toOrganizationRelativePath(location.pathname), [location.pathname]);
  const activeIssueSource = useMemo(() => new URLSearchParams(location.search).get("source") ?? "", [location.search]);
  const isIssuesRoute = useMemo(() => /^\/issues(?:\/|$)/.test(relativePath), [relativePath]);
  const isIssueDetailRoute = useMemo(() => /^\/issues\/[^/]+(?:\/|$)/.test(relativePath), [relativePath]);
  const isMessengerIssueDetailRoute = useMemo(() => /^\/messenger\/issues\/[^/]+(?:\/|$)/.test(relativePath), [relativePath]);
  const isLinearIssueSource = isIssuesRoute && activeIssueSource === "linear";
  const isPrimaryRailPage = useMemo(
    () => /^\/(?:dashboard|inbox|chat|messenger|issues|agents|library|projects|goals|automations|calendar)(?:\/|$)/.test(relativePath),
    [relativePath],
  );
  const isAgentDetailRoute = useMemo(
    () => /^\/agents\/[^/]+(?:\/|$)/.test(relativePath),
    [relativePath],
  );
  const threeColumnTitle = useMemo(() => {
    if (/^\/dashboard\/calendar(?:\/|$)/.test(relativePath)) return null;
    if (/^\/dashboard(?:\/|$)/.test(relativePath)) return "Dashboard";
    if (/^\/messenger(?:\/|$)/.test(relativePath)) return "Messenger";
    if (/^\/inbox(?:\/|$)/.test(relativePath)) return "Inbox";
    if (/^\/issues(?:\/|$)/.test(relativePath)) return activeIssueSource === "linear" ? "Linear Issues" : isIssueDetailRoute ? "Issues" : "Issue Tracker";
    if (/^\/chat(?:\/|$)/.test(relativePath)) return "Chat";
    if (/^\/projects(?:\/|$)/.test(relativePath)) return "Projects";
    if (/^\/agents(?:\/|$)/.test(relativePath)) return "Agents";
    if (/^\/goals(?:\/|$)/.test(relativePath)) return "Goals";
    if (/^\/automations(?:\/|$)/.test(relativePath)) return "Automations";
    if (/^\/calendar(?:\/|$)/.test(relativePath)) return "Calendar";
    return null;
  }, [activeIssueSource, isIssueDetailRoute, relativePath]);
  const { data: visibleProjects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId ?? "__none__"),
    queryFn: async () => {
      const all = await projectsApi.list(selectedOrganizationId!);
      return all.filter((project) => !project.archivedAt);
    },
    enabled: !!selectedOrganizationId && /^\/projects(?:\/|$)/.test(relativePath),
  });
  const issueSearchQuery = issueSearch.trim();
  const showIssueSearchMenu = isIssueDetailRoute && !isLinearIssueSource && issueSearchMenuOpen && issueSearchQuery.length > 0;
  const { data: searchedIssues = [], isFetching: issueSearchFetching } = useQuery({
    queryKey: queryKeys.issues.search(selectedOrganizationId ?? "__none__", issueSearchQuery),
    queryFn: () => issuesApi.list(selectedOrganizationId!, { q: issueSearchQuery }),
    enabled: !!selectedOrganizationId && showIssueSearchMenu,
  });

  const globalToolbarSlotContext = useMemo(
    () => ({
      orgId: selectedOrganizationId ?? null,
      orgPrefix: selectedOrganization?.issuePrefix ?? null,
    }),
    [selectedOrganizationId, selectedOrganization?.issuePrefix],
  );

  const globalToolbarSlots = <GlobalToolbarPlugins context={globalToolbarSlotContext} />;
  const trailingToolbar = headerActions || globalToolbarSlots ? (
    <div
      data-testid="workspace-main-header-actions"
      className={cn(
        "ml-auto flex shrink-0 items-center gap-2",
        desktopChrome && "desktop-window-no-drag",
      )}
    >
      {headerActions ? <div className="flex shrink-0 items-center gap-2">{headerActions}</div> : null}
      {globalToolbarSlots}
    </div>
  ) : null;

  useEffect(() => {
    if (!isIssuesRoute) return;
    const query = new URLSearchParams(location.search).get("q") ?? "";
    setIssueSearch(query);
    setIssueSearchMenuOpen(query.trim().length > 0 && isIssueDetailRoute);
  }, [isIssueDetailRoute, isIssuesRoute, location.search]);

  useEffect(() => {
    if (!isIssuesRoute) return;
    const timeoutId = window.setTimeout(() => {
      const currentParams = new URLSearchParams(location.search);
      const nextValue = issueSearch.trim();
      const currentValue = currentParams.get("q") ?? "";
      if (currentValue === nextValue) return;
      if (nextValue) currentParams.set("q", nextValue);
      else currentParams.delete("q");
      navigate(
        {
          pathname: location.pathname,
          search: currentParams.toString() ? `?${currentParams.toString()}` : "",
        },
        { replace: true },
      );
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [isIssuesRoute, issueSearch, location.pathname, location.search, navigate]);

  const navigateToIssueSearchResult = (issue: Issue) => {
    setIssueSearchMenuOpen(false);
    issueSearchInputRef.current?.blur();
    navigate(`/issues/${issue.identifier ?? issue.id}`);
  };

  useEffect(() => {
    if (!issueSearchMenuOpen) return;
    const closeIssueSearchMenu = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (issueSearchContainerRef.current?.contains(target)) return;
      setIssueSearchMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeIssueSearchMenu);
    return () => document.removeEventListener("pointerdown", closeIssueSearchMenu);
  }, [issueSearchMenuOpen]);

  useEffect(() => {
    if (!isIssuesRoute) return;

    const releaseIssueSearchFocus = () => {
      const input = issueSearchInputRef.current;
      if (input && document.activeElement === input) {
        input.blur();
      }
    };

    const handleNativeFind = (event: KeyboardEvent) => {
      if (!isNativeFindShortcut(event)) return;
      window.requestAnimationFrame(releaseIssueSearchFocus);
      window.setTimeout(releaseIssueSearchFocus, 0);
    };

    document.addEventListener("keydown", handleNativeFind, true);
    return () => document.removeEventListener("keydown", handleNativeFind, true);
  }, [isIssuesRoute]);

  const menuButton = isMobile && (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("mr-2 shrink-0", desktopChrome && "desktop-window-no-drag")}
      onClick={toggleSidebar}
      aria-label={t("common.openSidebar")}
    >
      <Menu className="h-5 w-5" />
    </Button>
  );
  const openWorkspaceSidebarButton = !isMobile && variant === "card" && sidebarOpen === false ? (
    <Button
      variant="ghost"
      size="icon-sm"
      className="desktop-window-no-drag shrink-0 text-muted-foreground hover:text-foreground"
      onClick={() => setSidebarOpen(true)}
      aria-label="Open workspace sidebar"
      title="Open workspace sidebar"
    >
      <PanelLeftOpen className="h-4 w-4" />
    </Button>
  ) : null;

  const shellHeaderBaseClass = "surface-shell";
  const cardHeaderBaseClass = "workspace-card-header workspace-main-header";
  const headerSurfaceClass = variant === "card" ? cardHeaderBaseClass : shellHeaderBaseClass;
  const draggableClass = desktopChrome ? "desktop-chrome desktop-window-drag" : "";
  const hideMessengerMainHeader = variant === "card" && /^\/messenger(?:\/|$)/.test(relativePath) && !isMessengerIssueDetailRoute;
  const hideAgentDetailMainHeader = variant === "card" && isAgentDetailRoute;
  const workspacesHeaderTooltip = useMemo(() => {
    if (/^\/(?:library|resources)(?:\/|$)/.test(relativePath)) {
      return "Shared Library for markdown notes, codebases, references, outputs, and reusable context that humans and agents can both work with.";
    }
    if (/^\/workspaces(?:\/|$)/.test(relativePath)) {
      return "Shared workspace files, plans, and skill packages for this organization. Use this page for disk-backed context and editable files.";
    }
    return null;
  }, [relativePath]);
  const workspacesHeaderTooltipLabel = useMemo(() => {
    if (/^\/(?:library|resources)(?:\/|$)/.test(relativePath)) return "About Library";
    if (/^\/workspaces(?:\/|$)/.test(relativePath)) return "About organization workspaces";
    return null;
  }, [relativePath]);

  if ((hideMessengerMainHeader || hideAgentDetailMainHeader) && !openWorkspaceSidebarButton) {
    return null;
  }

  if (hideMessengerMainHeader || hideAgentDetailMainHeader) {
    return (
      <div
        className={cn(
          headerSurfaceClass,
          "flex h-12 shrink-0 items-center px-4 md:px-4",
          draggableClass,
        )}
      >
        {openWorkspaceSidebarButton}
        <div className="desktop-window-drag hidden min-h-full flex-1 md:block" />
        {trailingToolbar}
      </div>
    );
  }

  if (threeColumnTitle) {
    const showIssueDetailBreadcrumbs = ((isIssuesRoute && isIssueDetailRoute) || isMessengerIssueDetailRoute) && breadcrumbs.length > 1;
    const isProjectsRoute = /^\/projects(?:\/|$)/.test(relativePath);
    const isProjectsIndex = isProjectsRoute && !/^\/projects\/[^/]+/.test(relativePath);
    const isDashboardIndex = /^\/dashboard\/?$/.test(relativePath);
    return (
      <div
        className={cn(
          headerSurfaceClass,
          "flex shrink-0 items-center gap-3",
          variant === "card" ? "h-12 px-4 md:px-4" : "h-14 px-4 md:px-6",
          variant === "shell" && desktopChrome && "h-auto min-h-[calc(3.5rem+var(--desktop-titlebar-top-gap))] pl-[var(--desktop-traffic-lights-offset)] pr-3 pt-[var(--desktop-titlebar-top-gap)] md:pr-4",
          draggableClass,
        )}
      >
        {menuButton}
        {openWorkspaceSidebarButton}
        {isDashboardIndex ? (
          <DashboardCalendarSwitcher />
        ) : showIssueDetailBreadcrumbs ? (
          <div className={cn("min-w-0 flex-1", desktopChrome && "desktop-window-no-drag")}>
            <Breadcrumb className="min-w-0 overflow-hidden" data-testid="issue-detail-breadcrumb">
              <BreadcrumbList className="flex-nowrap overflow-hidden">
                {breadcrumbs.map((crumb, i) => {
                  const isLast = i === breadcrumbs.length - 1;
                  return (
                    <Fragment key={`${crumb.href ?? crumb.label}-${i}`}>
                      {i > 0 && <BreadcrumbSeparator className="shrink-0" />}
                      <BreadcrumbItem className={isLast ? "min-w-0" : "max-w-[180px] shrink-0"}>
                        {isLast || !crumb.href ? (
                          <BreadcrumbPage
                            className="truncate text-[13px] font-medium text-foreground"
                            title={crumb.label}
                          >
                            {crumb.label}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <Link
                              to={crumb.href}
                              state={crumb.href.startsWith("/issues/") ? location.state : undefined}
                              className="truncate"
                              title={crumb.label}
                            >
                              {crumb.label}
                            </Link>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        ) : (
          <div className="min-w-0 shrink-0">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">{threeColumnTitle}</h1>
          </div>
        )}
        {desktopChrome && !showIssueDetailBreadcrumbs ? <div className="desktop-window-drag hidden min-h-full flex-1 md:block" /> : null}
        {isIssuesRoute ? (
          <div className={cn("hidden items-center gap-3 md:flex", desktopChrome && "desktop-window-no-drag")}>
            <div ref={issueSearchContainerRef} className="relative w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={issueSearchInputRef}
                value={issueSearch}
                onChange={(event) => {
                  setIssueSearch(event.target.value);
                  setIssueSearchMenuOpen(event.target.value.trim().length > 0 && isIssueDetailRoute);
                }}
                onFocus={() => setIssueSearchMenuOpen(issueSearchQuery.length > 0 && isIssueDetailRoute)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && issueSearchMenuOpen) {
                    event.preventDefault();
                    setIssueSearchMenuOpen(false);
                  }
                  if (event.key === "Enter" && showIssueSearchMenu && searchedIssues[0]) {
                    event.preventDefault();
                    navigateToIssueSearchResult(searchedIssues[0]);
                  }
                }}
                placeholder={isLinearIssueSource ? "Search Linear issues..." : "Search issues..."}
                className="h-9 border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] pl-8 text-sm"
                aria-label="Search issues"
                aria-expanded={showIssueSearchMenu}
                aria-controls={showIssueSearchMenu ? "issue-search-menu" : undefined}
              />
              {showIssueSearchMenu ? (
                <div
                  id="issue-search-menu"
                  role="listbox"
                  className="absolute right-0 top-full z-50 mt-2 w-full overflow-hidden rounded-[var(--radius-sm)] border border-[color:var(--border-base)] bg-[color:var(--surface-panel)] py-1 shadow-lg"
                >
                  {issueSearchFetching ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
                  ) : searchedIssues.length > 0 ? (
                    <div className="max-h-80 overflow-y-auto scrollbar-auto-hide">
                      {searchedIssues.slice(0, 8).map((issue) => (
                        <button
                          key={issue.id}
                          type="button"
                          role="option"
                          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[color:var(--surface-hover)] focus:bg-[color:var(--surface-hover)] focus:outline-none"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => navigateToIssueSearchResult(issue)}
                        >
                          <StatusIcon status={issue.status} className="h-3.5 w-3.5" />
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">{issueResultLabel(issue)}</span>
                          <span className="min-w-0 flex-1 truncate text-foreground">{issue.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{issue.status}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No matching issues.</div>
                  )}
                </div>
              ) : null}
            </div>
            {!isLinearIssueSource ? (
              <Button size="sm" className="px-4" onClick={() => openNewIssue()}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Create Issue
              </Button>
            ) : null}
          </div>
        ) : null}
        {isProjectsRoute && (!isProjectsIndex || (visibleProjects?.length ?? 0) > 0) ? (
          <Button
            size="sm"
            className={cn("hidden px-4 md:inline-flex", desktopChrome && "desktop-window-no-drag")}
            onClick={() => openNewProject()}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Project
          </Button>
        ) : null}
        {trailingToolbar}
      </div>
    );
  }

  if (breadcrumbs.length === 0) {
    return (
      <div
        className={cn(
          headerSurfaceClass,
          "flex h-14 shrink-0 items-center justify-end px-4 md:px-6",
          variant === "card" && "md:px-5",
          variant === "shell" && !isPrimaryRailPage && "border-b panel-divider",
          variant === "shell" && desktopChrome && "h-auto min-h-[calc(3.5rem+var(--desktop-titlebar-top-gap))] pl-[var(--desktop-traffic-lights-offset)] pr-3 pt-[var(--desktop-titlebar-top-gap)] md:pr-4",
          draggableClass,
        )}
      >
        {openWorkspaceSidebarButton}
        {desktopChrome ? <div className="desktop-window-drag hidden min-h-full flex-1 md:block" /> : null}
        {trailingToolbar}
      </div>
    );
  }

  // Single breadcrumb = page title.
  if (breadcrumbs.length === 1) {
    const crumb = breadcrumbs[0];
    const issueSub = crumb.sublabel && crumb.subhref;
    return (
      <div
        className={cn(
          headerSurfaceClass,
          "flex shrink-0 items-center px-4 md:px-6",
          variant === "card" && "md:px-5",
          variant === "shell" && !isPrimaryRailPage && "border-b panel-divider",
          issueSub ? "min-h-14 py-2" : "h-14",
          variant === "shell" && desktopChrome && "h-auto min-h-[calc(3.5rem+var(--desktop-titlebar-top-gap))] pl-[var(--desktop-traffic-lights-offset)] pr-3 pt-[var(--desktop-titlebar-top-gap)] md:pr-4",
          draggableClass,
        )}
      >
        {menuButton}
        {openWorkspaceSidebarButton}
        <div className="min-w-0 overflow-hidden flex-1">
          {variant === "card" ? null : (
            <div className="text-[10px] font-medium text-muted-foreground/75">{t("common.workspace")}</div>
          )}
          <div className="flex min-w-0 items-center gap-1.5 pt-0.5">
            <h1 className="truncate text-sm font-semibold tracking-wide text-foreground leading-tight">
              {crumb.label}
            </h1>
            {workspacesHeaderTooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={workspacesHeaderTooltipLabel ?? "About organization context"}
                  >
                    <CircleHelp className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={8} className="max-w-[320px] px-3 py-2 text-xs leading-5">
                  {workspacesHeaderTooltip}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          {issueSub ? (
            <Link
              to={crumb.subhref!}
              className="mt-0.5 block truncate text-left text-[11px] leading-snug text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {crumb.sublabel}
            </Link>
          ) : null}
        </div>
        {desktopChrome ? <div className="desktop-window-drag hidden min-h-full flex-1 md:block" /> : null}
        {trailingToolbar}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div
      className={cn(
        headerSurfaceClass,
        "flex h-14 shrink-0 items-center px-4 md:px-6",
        variant === "card" && "md:px-5",
        variant === "shell" && !isPrimaryRailPage && "border-b panel-divider",
        variant === "shell" && desktopChrome && "h-auto min-h-[calc(3.5rem+var(--desktop-titlebar-top-gap))] pl-[var(--desktop-traffic-lights-offset)] pr-3 pt-[var(--desktop-titlebar-top-gap)] md:pr-4",
        draggableClass,
      )}
    >
      {menuButton}
      {openWorkspaceSidebarButton}
      <div className="min-w-0 overflow-hidden flex-1">
        <Breadcrumb className="min-w-0 overflow-hidden">
          <BreadcrumbList className="flex-nowrap">
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <Fragment key={i}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                    {isLast || !crumb.href ? (
                      <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {desktopChrome ? <div className="desktop-window-drag hidden min-h-full flex-1 md:block" /> : null}
      {trailingToolbar}
    </div>
  );
}
