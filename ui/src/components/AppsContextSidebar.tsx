import { healthApi } from "@/api/health";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { LocalAppDefinitionReviewDialog } from "@/components/side-panel/LocalAppsPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSidebar } from "@/context/SidebarContext";
import { useAppRegistry } from "@/hooks/useAppRegistry";
import {
  activeKeyFromPath,
  appBuildStatusLabel,
  appRoute,
  type AppEntry,
} from "@/lib/apps-workspace";
import {
  type DesktopLocalAppDefinition,
  type DesktopLocalAppDefinitionDraft,
  type DesktopPreparedLocalAppDefinition,
} from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  CircleAlert,
  FolderSearch,
  Home,
  Loader2,
  PanelLeft,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";

function AppIdentity({
  entry,
  className,
}: {
  entry: AppEntry;
  className?: string;
}) {
  if (entry.definition) {
    return (
      <LocalAppIdentityIcon
        className={className}
        iconDataUrl={entry.definition.iconDataUrl}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-[var(--radius-sm)] bg-[color:color-mix(in_oklab,var(--accent-base)_18%,transparent)] text-[color:var(--accent-base)]",
        className,
      )}
    >
      <AppWindow className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

export function AppsContextSidebar() {
  const { isMobile, setSidebarOpen } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [review, setReview] = useState<{
    definition: DesktopPreparedLocalAppDefinition;
  } | null>(null);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const sitesEnabled = healthQuery.data?.features?.experimentalSitesEnabled === true;
  const { entries, localApps } = useAppRegistry(sitesEnabled);
  const activeKey = activeKeyFromPath(location.pathname);
  const filteredEntries = entries.filter((entry) => {
    const title = entry.kind === "managed"
      ? entry.app.name
      : entry.definition.title;
    return title.toLowerCase().includes(search.trim().toLowerCase());
  });
  const discoverMutation = useMutation({
    mutationFn: () => localApps!.discover(),
    onSuccess: (result) => {
      if (!result.canceled) setReview({ definition: result.draft });
    },
  });
  const saveMutation = useMutation({
    mutationFn: (definition: DesktopLocalAppDefinitionDraft) =>
      localApps!.create(definition),
    onSuccess: (saved) => {
      queryClient.setQueryData<DesktopLocalAppDefinition[]>(
        queryKeys.localApps.definitions,
        (current) => [...(current ?? []), saved],
      );
      setReview(null);
      navigate(appRoute(`local:${saved.id}`));
    },
  });

  return (
    <>
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <header
          data-testid="workspace-context-header"
          className="workspace-card-header workspace-context-header desktop-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3"
        >
          <div className="flex min-w-0 items-center gap-2">
            <AppWindow className="h-4 w-4 shrink-0 text-[color:var(--accent-base)]" aria-hidden />
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">Apps</h2>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">Registered on this device</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Load an App"
              aria-label="Load an App"
              disabled={!sitesEnabled || !localApps?.supported || discoverMutation.isPending}
              onClick={() => discoverMutation.mutate()}
              data-testid="apps-load"
            >
              {discoverMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                : <Plus className="h-4 w-4" aria-hidden />}
            </Button>
            {!isMobile ? (
              <button
                type="button"
                aria-label="Collapse workspace sidebar"
                title="Collapse workspace sidebar"
                className="desktop-window-no-drag inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground"
                onClick={() => setSidebarOpen(false)}
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </header>

        <div className="p-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 pl-8 text-xs"
              placeholder="Search Apps"
              aria-label="Search Apps"
            />
          </div>
        </div>

        <nav className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Apps">
          <button
            type="button"
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-2.5 text-left text-sm transition-[background-color,color] duration-150 motion-reduce:transition-none",
              activeKey === "home"
                ? "bg-[color:var(--surface-active)] font-medium text-foreground"
                : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_55%,transparent)] hover:text-foreground",
            )}
            onClick={() => navigate("/apps")}
          >
            <Home className="h-4 w-4" aria-hidden />
            Home
          </button>

          <div className="mb-1.5 mt-4 flex items-center justify-between px-2.5">
            <span className="text-[11px] font-medium text-muted-foreground/76">Registered</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">{entries.length}</span>
          </div>

          {filteredEntries.length ? (
            <div className="space-y-0.5">
              {filteredEntries.map((entry) => {
                const title = entry.kind === "managed" ? entry.app.name : entry.definition.title;
                const selected = entry.key === activeKey;
                const status = entry.kind === "managed" && !entry.definition
                  ? appBuildStatusLabel(entry.app.buildStatus)
                  : "On this device";
                return (
                  <button
                    key={entry.key}
                    type="button"
                    className={cn(
                      "group motion-list-enter flex w-full items-center gap-2.5 rounded-[calc(var(--radius-sm)-1px)] px-2 py-2 text-left transition-[background-color,color] duration-150 motion-reduce:transition-none",
                      selected
                        ? "bg-[color:var(--surface-active)] text-foreground"
                        : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_55%,transparent)] hover:text-foreground",
                    )}
                    onClick={() => navigate(appRoute(entry.key))}
                  >
                    <AppIdentity entry={entry} className="h-7 w-7 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{status}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mx-2 mt-3 rounded-[var(--radius-sm)] border border-dashed border-[color:var(--border-soft)] px-3 py-5 text-center">
              <FolderSearch className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {search ? "No matching Apps." : "Create or load your first App."}
              </p>
            </div>
          )}
        </nav>
      </aside>

      {review ? (
        <LocalAppDefinitionReviewDialog
          definition={review.definition}
          edit={false}
          error={saveMutation.error}
          open
          pending={saveMutation.isPending}
          onCancel={() => {
            saveMutation.reset();
            setReview(null);
          }}
          onSubmit={(definition) => saveMutation.mutate(definition)}
        />
      ) : null}

      {discoverMutation.error ? (
        <div
          className="fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-3 rounded-[var(--radius-lg)] border border-destructive/30 bg-[color:var(--surface-overlay)] p-4 text-sm text-destructive shadow-lg"
          role="alert"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {discoverMutation.error instanceof Error
              ? discoverMutation.error.message
              : "Could not load this App."}
          </span>
        </div>
      ) : null}
    </>
  );
}
