import { Link, useLocation, useNavigate } from "@/lib/router";
import { CircleHelp, Menu, Plus, Search } from "lucide-react";
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
import { Fragment, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { useI18n } from "@/context/I18nContext";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";

type GlobalToolbarContext = { orgId: string | null; orgPrefix: string | null };

type BreadcrumbBarProps = {
  desktopChrome?: boolean;
  variant?: "shell" | "card";
};

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

export function BreadcrumbBar({
  desktopChrome = false,
  variant = "shell",
}: BreadcrumbBarProps = {}) {
  const { t } = useI18n();
  const { breadcrumbs, headerActions } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const { openNewIssue, openNewProject } = useDialog();
  const location = useLocation();
  const navigate = useNavigate();
  const [issueSearch, setIssueSearch] = useState("");
  const relativePath = useMemo(() => toOrganizationRelativePath(location.pathname), [location.pathname]);
  const isPrimaryRailPage = useMemo(
    () => /^\/(?:dashboard|inbox|chat|messenger|issues|agents|projects|goals|automations)(?:\/|$)/.test(relativePath),
    [relativePath],
  );
  const isAgentDetailRoute = useMemo(
    () => /^\/agents\/[^/]+(?:\/|$)/.test(relativePath),
    [relativePath],
  );
  const isGoalDetailRoute = useMemo(
    () => /^\/goals\/[^/]+(?:\/|$)/.test(relativePath),
    [relativePath],
  );
  const threeColumnTitle = useMemo(() => {
    if (/^\/dashboard(?:\/|$)/.test(relativePath)) return "Dashboard";
    if (/^\/messenger(?:\/|$)/.test(relativePath)) return "Messenger";
    if (/^\/inbox(?:\/|$)/.test(relativePath)) return "Inbox";
    if (/^\/issues(?:\/|$)/.test(relativePath)) return "Issue Tracker";
    if (/^\/chat(?:\/|$)/.test(relativePath)) return "Chat";
    if (/^\/projects(?:\/|$)/.test(relativePath)) return "Projects";
    if (/^\/agents(?:\/|$)/.test(relativePath)) return "Agents";
    if (/^\/goals(?:\/|$)/.test(relativePath)) return "Goals";
    if (/^\/automations(?:\/|$)/.test(relativePath)) return "Automations";
    return null;
  }, [relativePath]);
  const { data: visibleProjects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId ?? "__none__"),
    queryFn: async () => {
      const all = await projectsApi.list(selectedOrganizationId!);
      return all.filter((project) => !project.archivedAt);
    },
    enabled: !!selectedOrganizationId && /^\/projects(?:\/|$)/.test(relativePath),
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
    if (!/^\/issues(?:\/|$)/.test(relativePath)) return;
    const query = new URLSearchParams(location.search).get("q") ?? "";
    setIssueSearch(query);
  }, [location.search, relativePath]);

  useEffect(() => {
    if (!/^\/issues(?:\/|$)/.test(relativePath)) return;
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
  }, [issueSearch, location.pathname, location.search, navigate, relativePath]);

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

  const shellHeaderBaseClass = "surface-shell";
  const cardHeaderBaseClass = "workspace-card-header workspace-main-header";
  const headerSurfaceClass = variant === "card" ? cardHeaderBaseClass : shellHeaderBaseClass;
  const draggableClass = desktopChrome ? "desktop-chrome desktop-window-drag" : "";
  const hideMessengerMainHeader = variant === "card" && /^\/messenger(?:\/|$)/.test(relativePath);
  const hideAgentDetailMainHeader = variant === "card" && isAgentDetailRoute;
  const workspacesHeaderTooltip = useMemo(() => {
    if (/^\/resources(?:\/|$)/.test(relativePath)) {
      return "Shared resource catalog for repos, docs, URLs, and connector objects. Keep entries canonical here, then attach them from projects.";
    }
    if (/^\/workspaces(?:\/|$)/.test(relativePath)) {
      return "Shared workspace files, plans, and skill packages for this organization. Use this page for disk-backed context and editable files.";
    }
    return null;
  }, [relativePath]);
  const workspacesHeaderTooltipLabel = useMemo(() => {
    if (/^\/resources(?:\/|$)/.test(relativePath)) return "About organization resources";
    if (/^\/workspaces(?:\/|$)/.test(relativePath)) return "About organization workspaces";
    return null;
  }, [relativePath]);

  if (hideMessengerMainHeader || hideAgentDetailMainHeader) {
    return null;
  }

  if (threeColumnTitle && !(isGoalDetailRoute && breadcrumbs.length > 1)) {
    const isIssuesRoute = /^\/issues(?:\/|$)/.test(relativePath);
    const isProjectsRoute = /^\/projects(?:\/|$)/.test(relativePath);
    const isProjectsIndex = isProjectsRoute && !/^\/projects\/[^/]+/.test(relativePath);
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
        <div className="min-w-0 shrink-0">
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">{threeColumnTitle}</h1>
        </div>
        {desktopChrome ? <div className="desktop-window-drag hidden min-h-full flex-1 md:block" /> : null}
        {isIssuesRoute ? (
          <div className={cn("hidden items-center gap-3 md:flex", desktopChrome && "desktop-window-no-drag")}>
            <div className="relative w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={issueSearch}
                onChange={(event) => setIssueSearch(event.target.value)}
                placeholder="Search issues..."
                className="h-9 border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] pl-8 text-sm"
              />
            </div>
            <Button size="sm" className="px-4" onClick={() => openNewIssue()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create Issue
            </Button>
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
