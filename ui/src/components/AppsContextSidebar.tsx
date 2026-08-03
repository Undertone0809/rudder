import { healthApi } from "@/api/health";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { LocalAppDefinitionReviewDialog } from "@/components/side-panel/LocalAppsPanel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToast } from "@/context/ToastContext";
import { useAppRegistry } from "@/hooks/useAppRegistry";
import {
  activeKeyFromPath,
  appBuildStatusLabel,
  appRoute,
  requestAppDirectOpen,
  type AppEntry,
} from "@/lib/apps-workspace";
import {
  readDesktopShell,
  type DesktopLocalAppDefinition,
  type DesktopLocalAppDefinitionDraft,
  type DesktopLocalAppRuntimeView,
  type DesktopPreparedLocalAppDefinition,
} from "@/lib/desktop-shell";
import {
  localAppStatusRefetchInterval,
  resolveLocalAppAttestedWebview,
} from "@/lib/local-apps";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  FolderSearch,
  Home,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  Upload,
} from "lucide-react";
import { useState } from "react";

const APP_BUILDER_CHAT_PREFILL = [
  "Use $app-builder to create or improve a Rudder App.",
  "Help me clarify what this local web app should do before building it.",
].join(" ");

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

function AppRowActions({
  entry,
  onSettings,
}: {
  entry: AppEntry;
  onSettings: (definition: DesktopLocalAppDefinition, active: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const desktopShell = readDesktopShell();
  const localApps = desktopShell?.localApps;
  const appBuilder = desktopShell?.appBuilder;
  const definition = entry.definition;
  const [lastSnapshotId, setLastSnapshotId] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: queryKeys.localApps.status(definition?.localBindingId ?? entry.key),
    queryFn: () => localApps!.status(definition!.id),
    enabled: Boolean(localApps?.supported && definition),
    refetchInterval: (query) =>
      localAppStatusRefetchInterval(query.state.data?.status),
  });
  const stopMutation = useMutation({
    mutationFn: () => localApps!.stop(definition!.id),
    onMutate: () => {
      if (!definition) return;
      queryClient.setQueryData<DesktopLocalAppRuntimeView | undefined>(
        queryKeys.localApps.status(definition.localBindingId),
        (current) => current ? { ...current, status: "stopping" } : current,
      );
    },
    onSuccess: (next) => {
      if (!definition) return;
      queryClient.setQueryData(
        queryKeys.localApps.status(definition.localBindingId),
        next,
      );
    },
    onError: () => {
      if (!definition) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.localApps.status(definition.localBindingId),
      });
    },
  });
  const dataMutation = useMutation({
    mutationFn: async (action: "backup" | "import" | "restore") => {
      if (
        entry.kind !== "managed"
        || !definition
        || !appBuilder?.supported
      ) {
        throw new Error("App data controls are unavailable on this device.");
      }
      const location = {
        projectId: entry.app.orgId,
        appDirectory: entry.app.sourceRoot,
        binding: {
          desktopInstallationId: definition.desktopInstallationId,
          definitionId: definition.id,
          appPublicId: definition.appPublicId,
          localBindingId: definition.localBindingId,
        },
      };
      if (action === "backup") {
        const snapshot = await appBuilder.snapshot(location);
        const exported = await appBuilder.exportSnapshot({
          ...location,
          snapshotId: snapshot.id,
        });
        if (!exported.canceled) {
          setLastSnapshotId(snapshot.id);
          pushToast({ title: "App data backup exported", tone: "success" });
        }
        return;
      }
      if (action === "import") {
        const imported = await appBuilder.importData(location);
        if (!imported.canceled) {
          setLastSnapshotId(imported.rollbackSnapshot.id);
          pushToast({
            title: "App data imported",
            body: "The previous data is available as a restore point.",
            tone: "success",
          });
        }
        return;
      }
      if (!lastSnapshotId) {
        throw new Error("Create a backup or import data first.");
      }
      const restored = await appBuilder.restoreSnapshot({
        ...location,
        snapshotId: lastSnapshotId,
      });
      setLastSnapshotId(restored.safetySnapshot.id);
      pushToast({
        title: "App data restored",
        body: "A safety snapshot was kept.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "App data operation failed",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
    onSettled: () => {
      if (!definition) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.localApps.status(definition.localBindingId),
      });
    },
  });
  const status = statusQuery.data?.status;
  const running = status === "running";
  const active = status === "starting"
    || status === "running"
    || status === "stopping"
    || status === "orphaned_unverified"
    || statusQuery.isPending
    || dataMutation.isPending;
  const openTarget = async (action: "copy" | "external") => {
    if (!definition || !localApps) return;
    const target = await localApps.attestedTarget(definition.id);
    if (!target) {
      pushToast({
        title: "App link unavailable",
        body: "Open the App and wait for it to finish starting.",
        tone: "error",
      });
      return;
    }
    const { src } = resolveLocalAppAttestedWebview(target);
    if (action === "copy") {
      await desktopShell?.copyText(src);
      pushToast({ title: "App link copied", tone: "success" });
      return;
    }
    const open = desktopShell?.forceOpenExternal ?? desktopShell?.openExternal;
    await open?.(src);
  };
  const title = entry.kind === "managed" ? entry.app.name : entry.definition.title;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="desktop-window-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground opacity-0 transition-[background-color,color,opacity] hover:bg-[color:var(--surface-elevated)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none"
          aria-label={`More options for ${title}`}
          data-testid={`apps-more-${entry.key}`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="right"
        className="surface-overlay min-w-48 text-foreground"
      >
        {definition ? (
          <DropdownMenuItem onSelect={() => onSettings(definition, active)}>
            <Settings aria-hidden />
            App settings
          </DropdownMenuItem>
        ) : null}
        {definition || entry.kind === "managed" ? (
          <DropdownMenuItem
            onSelect={() => {
              if (definition) {
                void desktopShell?.openPath(definition.cwd).catch((error) => {
                  pushToast({
                    title: "Could not open App source",
                    body: error instanceof Error ? error.message : undefined,
                    tone: "error",
                  });
                });
                return;
              }
              if (entry.kind === "managed") {
                navigate(`/library?directory=${encodeURIComponent(entry.app.sourceRoot)}`);
              }
            }}
          >
            <FolderSearch aria-hidden />
            Open source
          </DropdownMenuItem>
        ) : null}
        {entry.kind === "managed" && entry.app.conversationId ? (
          <DropdownMenuItem
            onSelect={() => navigate(`/messenger/chat/${entry.app.conversationId}`)}
          >
            <MessageSquare aria-hidden />
            Continue in Chat
          </DropdownMenuItem>
        ) : null}
        {definition ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!running}
              onSelect={() => void openTarget("copy")}
              data-testid={`apps-copy-link-${entry.key}`}
            >
              <Copy aria-hidden />
              Copy App link
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!running}
              onSelect={() => void openTarget("external")}
            >
              <ExternalLink aria-hidden />
              Open in browser
            </DropdownMenuItem>
            {entry.kind === "managed" && appBuilder?.supported ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={dataMutation.isPending}
                  onSelect={() => dataMutation.mutate("backup")}
                >
                  <Download aria-hidden />
                  Back up data
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={dataMutation.isPending}
                  onSelect={() => dataMutation.mutate("import")}
                >
                  <Upload aria-hidden />
                  Import data
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!lastSnapshotId || dataMutation.isPending}
                  onSelect={() => dataMutation.mutate("restore")}
                >
                  <RotateCcw aria-hidden />
                  Restore previous data
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!active || stopMutation.isPending}
              onSelect={() => stopMutation.mutate()}
            >
              <Square aria-hidden />
              Stop App
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppsContextSidebar() {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { selectedOrganizationId } = useOrganization();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [review, setReview] = useState<{
    definition: DesktopPreparedLocalAppDefinition | DesktopLocalAppDefinition;
    editId: string | null;
    editable: boolean;
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
      if (!result.canceled) {
        setReview({ definition: result.draft, editId: null, editable: true });
      }
    },
  });
  const saveMutation = useMutation({
    mutationFn: (definition: DesktopLocalAppDefinitionDraft) => (
      review?.editId
        ? localApps!.update(review.editId, definition)
        : localApps!.create(definition)
    ),
    onSuccess: (saved) => {
      queryClient.setQueryData<DesktopLocalAppDefinition[]>(
        queryKeys.localApps.definitions,
        (current) => {
          const definitions = current ?? [];
          return definitions.some((candidate) => candidate.id === saved.id)
            ? definitions.map((candidate) => candidate.id === saved.id ? saved : candidate)
            : [...definitions, saved];
        },
      );
      setReview(null);
      navigate(appRoute(`local:${saved.id}`));
    },
  });
  const stopForEditMutation = useMutation({
    mutationFn: () => localApps!.stop(review!.editId!),
    onSuccess: (next) => {
      if (!review || !("localBindingId" in review.definition)) return;
      queryClient.setQueryData(
        queryKeys.localApps.status(review.definition.localBindingId),
        next,
      );
      setReview((current) => current ? { ...current, editable: true } : current);
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
            <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">Apps</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  title="Add an App"
                  aria-label="Add an App"
                  disabled={!sitesEnabled}
                  data-testid="apps-add"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="surface-overlay w-80 max-w-[calc(100vw-1.5rem)] text-foreground"
              >
                <DropdownMenuItem
                  className="items-start gap-3 px-3 py-2.5"
                  data-testid="apps-build-with-agent"
                  onSelect={() => navigate(
                    `/messenger/chat?prefill=${encodeURIComponent(APP_BUILDER_CHAT_PREFILL)}`,
                  )}
                >
                  <Sparkles className="mt-0.5" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">Build with Agent</span>
                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                      Create or improve a web App with App Builder.
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="items-start gap-3 px-3 py-2.5"
                  disabled={!localApps?.supported || discoverMutation.isPending}
                  data-testid="apps-add-local-project"
                  onSelect={() => discoverMutation.mutate()}
                >
                  {discoverMutation.isPending
                    ? <Loader2 className="mt-0.5 animate-spin motion-reduce:animate-none" aria-hidden />
                    : <FolderSearch className="mt-0.5" aria-hidden />}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">Add local web project</span>
                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                      Load a Next.js, React, Vue, or other web project from this computer.
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
                  <div
                    key={entry.key}
                    className={cn(
                      "group motion-list-enter flex w-full items-center rounded-[calc(var(--radius-sm)-1px)] transition-[background-color,color] duration-150 motion-reduce:transition-none",
                      selected
                        ? "bg-[color:var(--surface-active)] text-foreground"
                        : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_55%,transparent)] hover:text-foreground",
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left"
                      onClick={() => {
                        if (selectedOrganizationId && entry.definition) {
                          requestAppDirectOpen(selectedOrganizationId, entry.key);
                        }
                        navigate(appRoute(entry.key));
                      }}
                      data-testid={`apps-entry-${entry.key}`}
                    >
                      <AppIdentity entry={entry} className="h-7 w-7 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{title}</span>
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{status}</span>
                      </span>
                    </button>
                    <div className="pr-1">
                      <AppRowActions
                        entry={entry}
                        onSettings={(definition, active) => {
                          saveMutation.reset();
                          stopForEditMutation.reset();
                          setReview({
                            definition,
                            editId: definition.id,
                            editable: !active,
                          });
                        }}
                      />
                    </div>
                  </div>
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
          edit={Boolean(review.editId)}
          editable={review.editable}
          error={saveMutation.error ?? stopForEditMutation.error}
          open
          pending={saveMutation.isPending}
          requestEditPending={stopForEditMutation.isPending}
          onCancel={() => {
            saveMutation.reset();
            stopForEditMutation.reset();
            setReview(null);
          }}
          onRequestEdit={() => stopForEditMutation.mutate()}
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
