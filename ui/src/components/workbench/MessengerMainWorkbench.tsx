import { messengerApi } from "@/api/messenger";
import { LocalAppDefinitionReviewDialog } from "@/components/side-panel/LocalAppsPanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  LiveSurfaceAnchor,
  createLiveSurfaceRuntimeId,
  useLiveSurfaceRuntime,
  type LiveSurfaceTarget,
} from "@/context/LiveSurfaceRuntimeContext";
import { useOrganizationMainWorkbench } from "@/context/MainWorkbenchContext";
import { useOptionalToast } from "@/context/ToastContext";
import { useBrowserSavedViewMetadataPersister } from "@/hooks/useBrowserSavedViewMetadataPersister";
import {
  readDesktopShell,
  type DesktopLocalAppDefinition,
  type DesktopLocalAppDefinitionDraft,
} from "@/lib/desktop-shell";
import {
  localAppIdentityMatches,
} from "@/lib/local-apps";
import type { MainWorkbenchTab, MainWorkbenchTarget } from "@/lib/main-workbench-state";
import {
  messengerSavedViewRoute,
  savedViewKeepInputFromSidePanelTarget,
} from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import {
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type KeyboardCodes,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  BookmarkPlus,
  FileText,
  Folder,
  Globe2,
  Loader2,
  MoreHorizontal,
  Plus,
  Settings2,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

type WorkbenchTabIcon = {
  fallback: LucideIcon;
  label: string;
};

const workbenchTabKeyboardCodes = {
  start: ["Space"],
  cancel: ["Escape"],
  end: ["Space"],
} satisfies KeyboardCodes;

function tabIcon(target: MainWorkbenchTarget): WorkbenchTabIcon {
  if (target.kind === "browser") return { fallback: Globe2, label: "Browser" };
  if (target.kind === "local_app") return { fallback: AppWindow, label: "Local App" };
  if (target.kind === "automation") return { fallback: Workflow, label: "Automation" };
  if (target.kind === "library_directory") return { fallback: Folder, label: "Library folder" };
  return { fallback: FileText, label: "Library item" };
}

function acceptedBrowserFavicon(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8_192) return null;
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

function tabDomId(organizationId: string, viewInstanceId: string) {
  return `messenger-workbench-tab-${encodeURIComponent(organizationId)}-${encodeURIComponent(viewInstanceId)}`;
}

function panelDomId(organizationId: string, viewInstanceId: string) {
  return `messenger-workbench-panel-${encodeURIComponent(organizationId)}-${encodeURIComponent(viewInstanceId)}`;
}

function routeForTab(tab: MainWorkbenchTab | null) {
  if (!tab) return "/messenger";
  return tab.savedViewId
    ? messengerSavedViewRoute(tab.savedViewId)
    : "/messenger/workbench";
}

function SortableWorkbenchTab({
  active,
  focused,
  moving,
  organizationId,
  setTabRef,
  tab,
  onActivate,
  onClose,
  onLocalAppUpdated,
  onFocus,
  onKeyDown,
}: {
  active: boolean;
  focused: boolean;
  moving: boolean;
  organizationId: string;
  setTabRef: (node: HTMLButtonElement | null) => void;
  tab: MainWorkbenchTab;
  onActivate: () => void;
  onClose: () => void;
  onLocalAppUpdated: (definition: DesktopLocalAppDefinition) => void;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const sortable = useSortable({ id: tab.viewInstanceId });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const icon = tabIcon(tab.target);
  const Icon = icon.fallback;
  const favicon = tab.target.kind === "browser"
    ? acceptedBrowserFavicon(tab.target.favicon)
    : null;

  return (
    <div
      ref={sortable.setNodeRef}
      data-dragging={sortable.isDragging ? "true" : undefined}
      className={cn(
        "group flex h-8 max-w-[15rem] shrink-0 items-center gap-0.5 rounded-md border pr-1",
        "transition-[color,background-color,border-color,opacity]",
        active
          ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
        sortable.isDragging && "opacity-50",
      )}
      style={style}
    >
      <button
        ref={(node) => {
          setTabRef(node);
          sortable.setActivatorNodeRef(node);
        }}
        type="button"
        {...sortable.attributes}
        {...sortable.listeners}
        id={tabDomId(organizationId, tab.viewInstanceId)}
        role="tab"
        aria-controls={panelDomId(organizationId, tab.viewInstanceId)}
        aria-selected={active}
        data-target-kind={tab.target.kind}
        data-view-instance-id={tab.viewInstanceId}
        tabIndex={focused ? 0 : -1}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onActivate}
        onFocus={onFocus}
        onKeyDown={(event) => {
          sortable.listeners?.onKeyDown?.(event);
          if (!event.defaultPrevented) onKeyDown(event);
        }}
      >
        {favicon ? (
          <img
            src={favicon}
            alt=""
            referrerPolicy="no-referrer"
            className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
          />
        ) : (
          <Icon className="h-3.5 w-3.5 shrink-0" aria-label={icon.label} />
        )}
        <span className="truncate">{tab.target.label}</span>
        {moving ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            Moving…
          </span>
        ) : null}
      </button>
      {tab.target.kind === "local_app" ? (
        <LocalAppTabActions
          target={tab.target}
          onUpdated={onLocalAppUpdated}
        />
      ) : null}
      <button
        type="button"
        aria-label={`Close ${tab.target.label} tab`}
        disabled={moving}
        className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[color:var(--surface-panel)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={(event) => {
          event.stopPropagation();
          if (moving) return;
          onClose();
        }}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

function LocalAppTabActions({
  target,
  onUpdated,
}: {
  target: Extract<MainWorkbenchTarget, { kind: "local_app" }>;
  onUpdated: (definition: DesktopLocalAppDefinition) => void;
}) {
  const queryClient = useQueryClient();
  const localApps = readDesktopShell()?.localApps;
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const definitionsQuery = useQuery({
    queryKey: queryKeys.localApps.definitions,
    queryFn: () => localApps!.list(),
    enabled: Boolean(localApps?.supported && (menuOpen || settingsOpen)),
    staleTime: 1_000,
  });
  const definition = definitionsQuery.data?.find(
    (candidate) => localAppIdentityMatches(candidate, target),
  ) ?? null;
  const statusQuery = useQuery({
    queryKey: queryKeys.localApps.status(target.localBindingId),
    queryFn: () => localApps!.status(definition!.id),
    enabled: Boolean(localApps?.supported && settingsOpen && definition),
  });
  const editable = statusQuery.data?.status === "stopped"
    || statusQuery.data?.status === "failed";
  const stopMutation = useMutation({
    mutationFn: () => localApps!.stop(definition!.id),
    onSuccess: (nextStatus) => {
      queryClient.setQueryData(
        queryKeys.localApps.status(target.localBindingId),
        nextStatus,
      );
    },
  });
  const updateMutation = useMutation({
    mutationFn: (draft: DesktopLocalAppDefinitionDraft) => (
      localApps!.update(definition!.id, draft)
    ),
    onSuccess: (updated) => {
      queryClient.setQueryData<DesktopLocalAppDefinition[]>(
        queryKeys.localApps.definitions,
        (current) => current?.map((candidate) => (
          candidate.id === updated.id ? updated : candidate
        )) ?? [updated],
      );
      onUpdated(updated);
      setSettingsOpen(false);
    },
  });

  return (
    <>
      <DropdownMenu
        modal={false}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More options for ${target.label}`}
            className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[color:var(--surface-panel)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="h-3 w-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!localApps?.supported}
            onSelect={() => {
              updateMutation.reset();
              setSettingsOpen(true);
            }}
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            Project settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {settingsOpen && definition ? (
        <LocalAppDefinitionReviewDialog
          definition={definition}
          edit
          editable={editable}
          error={updateMutation.error ?? stopMutation.error ?? statusQuery.error}
          open
          pending={updateMutation.isPending}
          requestEditPending={stopMutation.isPending}
          title="Project settings"
          onCancel={() => {
            updateMutation.reset();
            setSettingsOpen(false);
          }}
          onRequestEdit={() => stopMutation.mutate()}
          onSubmit={(draft) => updateMutation.mutate(draft)}
        />
      ) : null}
    </>
  );
}

function normalizeLiveTarget(
  tab: MainWorkbenchTab,
  target: LiveSurfaceTarget,
): LiveSurfaceTarget | null {
  if (target.kind !== tab.target.kind) return null;
  return { ...target, viewInstanceId: tab.viewInstanceId };
}

function MainLiveSurfacePanel({
  active,
  onClose,
  onCycleTab,
  organizationId,
  tab,
}: {
  active: boolean;
  onClose: () => void;
  onCycleTab: (direction: -1 | 1) => void;
  organizationId: string;
  tab: MainWorkbenchTab & { target: LiveSurfaceTarget };
}) {
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const workbench = useOrganizationMainWorkbench(organizationId);
  const onCloseRef = useRef(onClose);
  const onCycleTabRef = useRef(onCycleTab);
  onCloseRef.current = onClose;
  onCycleTabRef.current = onCycleTab;
  const ownerId = `main:${organizationId}:${tab.viewInstanceId}`;
  const promotionUsesExplicitClaim = Object.values(workbench.promotionsById).some(
    (promotion) => (
      promotion.status === "detaching"
      && promotion.source.runtimeId === tab.runtimeId
      && promotion.source.viewInstanceId === tab.viewInstanceId
    ),
  );
  const closeTarget = useCallback(() => {
    if (!promotionUsesExplicitClaim) onCloseRef.current();
  }, [promotionUsesExplicitClaim]);
  const cycleTarget = useCallback(
    (direction: -1 | 1) => onCycleTabRef.current(direction),
    [],
  );

  const replaceTarget = useCallback((nextTarget: LiveSurfaceTarget) => {
    if (promotionUsesExplicitClaim) return;
    const normalized = normalizeLiveTarget(tab, nextTarget);
    if (!normalized) return;
    workbench.updateTarget(
      tab.runtimeId,
      tab.viewInstanceId,
      normalized as MainWorkbenchTarget,
    );
  }, [
    promotionUsesExplicitClaim,
    tab.runtimeId,
    tab.target.kind,
    tab.viewInstanceId,
    workbench.updateTarget,
  ]);
  const callbacks = useMemo(() => ({
    canOpenNewTab: workbench.canCreateBrowser,
    onCloseTarget: closeTarget,
    onCycleTab: cycleTarget,
    onOpenTarget: (nextTarget: SidePanelTarget) => {
      if (nextTarget.kind === "chat") {
        navigate(`/messenger/chat/${nextTarget.conversationId}`);
        return;
      }
      if (nextTarget.kind === "browser") {
        const opened = workbench.createSessionBrowser(nextTarget);
        if (opened.admitted) {
          navigate("/messenger/workbench", { replace: true });
        } else {
          toast?.pushToast({
            title: "Browser tab limit reached",
            body: "Close a Browser tab to open another. Side Panel and Main share 8 live tabs.",
            tone: "error",
          });
        }
        return;
      }
      if (!sidePanelTargetSupportsSavedView(nextTarget)) return;
      const viewInstanceId = nextTarget.viewInstanceId?.trim()
        || globalThis.crypto?.randomUUID?.()
        || `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const target = { ...nextTarget, viewInstanceId } as MainWorkbenchTarget;
      const opened = workbench.createSessionTab({
        originContextKey: tab.originContextKey,
        runtimeId: createLiveSurfaceRuntimeId(organizationId, target),
        target,
        viewInstanceId,
      });
      if (opened.admitted) {
        navigate("/messenger/workbench", { replace: true });
      }
    },
    onReplaceTarget: (nextTarget: SidePanelTarget) => {
      if (sidePanelTargetSupportsSavedView(nextTarget)) {
        replaceTarget(nextTarget as LiveSurfaceTarget);
      }
    },
  }), [
    closeTarget,
    cycleTarget,
    navigate,
    organizationId,
    replaceTarget,
    tab.originContextKey,
    toast,
    workbench.canCreateBrowser,
    workbench.createSessionBrowser,
    workbench.createSessionTab,
  ]);

  return (
    <LiveSurfaceAnchor
      active={active}
      autoClaim={!promotionUsesExplicitClaim}
      callbacks={callbacks}
      className={cn("h-full min-h-0 w-full", active ? "block" : "hidden")}
      data-testid="messenger-main-live-surface-anchor"
      hostId={ownerId}
      ownerId={ownerId}
      runtimeId={tab.runtimeId}
      target={tab.target}
      aria-hidden={!active}
    />
  );
}

const RECENT_SAVED_VIEW_GROUP_KEY_PREFIX =
  "rudder.messengerRecentSavedViewGroup:";

function recentSavedViewGroupId(organizationId: string) {
  try {
    return window.localStorage.getItem(
      `${RECENT_SAVED_VIEW_GROUP_KEY_PREFIX}${organizationId}`,
    );
  } catch {
    return null;
  }
}

function rememberSavedViewGroup(organizationId: string, groupId: string) {
  try {
    window.localStorage.setItem(
      `${RECENT_SAVED_VIEW_GROUP_KEY_PREFIX}${organizationId}`,
      groupId,
    );
  } catch {
    // Keeping a Saved View does not depend on optional device preference state.
  }
}

function newClientMutationId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `keep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function SessionBrowserKeepControl({
  onAnnounce,
  organizationId,
  tab,
}: {
  onAnnounce: (message: string) => void;
  organizationId: string;
  tab: MainWorkbenchTab & {
    target: Extract<MainWorkbenchTarget, { kind: "browser" }>;
  };
}) {
  const navigate = useNavigate();
  const workbench = useOrganizationMainWorkbench(organizationId);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("Saved views");
  const mutationIdsRef = useRef(new Map<string, string>());
  const createdGroupsRef = useRef(new Map<string, { id: string; name: string }>());
  const groupsQuery = useQuery({
    queryKey: queryKeys.messenger.customGroups(organizationId),
    queryFn: () => messengerApi.listCustomGroups(organizationId),
    retry: false,
  });
  const groups = groupsQuery.data?.groups ?? [];

  useEffect(() => {
    if (!open || groupsQuery.isPending || groupsQuery.isError) return;
    if (groups.length === 0) {
      setCreateMode(true);
      setSelectedGroupId("");
      return;
    }
    const recentGroupId = recentSavedViewGroupId(organizationId);
    const recentGroup = recentGroupId
      ? groups.find((group) => group.id === recentGroupId)
      : null;
    setCreateMode(false);
    setSelectedGroupId(recentGroup?.id ?? "");
  }, [
    groups,
    groupsQuery.isError,
    groupsQuery.isPending,
    open,
    organizationId,
  ]);

  const keepMutation = useMutation({
    mutationFn: async () => {
      let destination: { id: string; name: string } | null = (
        groups.find((group) => group.id === selectedGroupId) ?? null
      );
      if (createMode) {
        const name = newGroupName.trim();
        if (!name) throw new Error("Enter a name for the new Messenger group.");
        const createKey = `${tab.viewInstanceId}\u0000${name}`;
        destination = createdGroupsRef.current.get(createKey) ?? null;
        if (!destination) {
          const created = await messengerApi.createCustomGroup(
            organizationId,
            { name, icon: null },
          );
          destination = { id: created.id, name: created.name };
          createdGroupsRef.current.set(createKey, destination);
        }
      }
      if (!destination) throw new Error("Choose a Messenger group.");
      const intentKey = `${tab.viewInstanceId}\u0000${destination.id}`;
      const clientMutationId = mutationIdsRef.current.get(intentKey)
        ?? newClientMutationId();
      mutationIdsRef.current.set(intentKey, clientMutationId);
      const input = savedViewKeepInputFromSidePanelTarget(tab.target, {
        clientMutationId,
        placement: { kind: "group", groupId: destination.id },
      });
      if (!input) throw new Error("This Browser tab cannot be kept in Messenger.");
      const result = await messengerApi.keepSavedView(organizationId, input);
      return { destination, intentKey, result };
    },
    onSuccess: ({ destination, intentKey, result }) => {
      mutationIdsRef.current.delete(intentKey);
      queryClient.setQueryData(
        queryKeys.messenger.savedView(organizationId, result.savedView.id),
        result.savedView,
      );
      workbench.bindSavedView(tab.viewInstanceId, result.savedView.id);
      rememberSavedViewGroup(organizationId, destination.id);
      setOpen(false);
      onAnnounce(`Kept in ${result.group.name}.`);
      navigate(messengerSavedViewRoute(result.savedView.id), { replace: true });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messenger.customGroups(organizationId),
      });
    },
  });
  const canConfirm = !keepMutation.isPending
    && !groupsQuery.isPending
    && !groupsQuery.isError
    && (createMode ? Boolean(newGroupName.trim()) : Boolean(selectedGroupId));

  return (
    <>
      <button
        type="button"
        aria-label="Keep active Browser in Messenger"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => {
          keepMutation.reset();
          setOpen(true);
        }}
      >
        <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
        Keep
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep Browser tab in Messenger</DialogTitle>
            <DialogDescription>
              Choose where this tab should appear. Nothing is saved until you confirm.
            </DialogDescription>
          </DialogHeader>
          {groupsQuery.isPending ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading Messenger groups…
            </div>
          ) : groupsQuery.isError ? (
            <div
              className="rounded-md border border-destructive/25 bg-destructive/5 p-3"
              role="alert"
            >
              <p className="text-sm text-destructive">
                {groupsQuery.error instanceof Error
                  ? groupsQuery.error.message
                  : "Could not load Messenger groups."}
              </p>
              <Button
                type="button"
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() => void groupsQuery.refetch()}
              >
                Retry groups
              </Button>
            </div>
          ) : (
            <div className="space-y-2" role="radiogroup" aria-label="Messenger group">
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  role="radio"
                  aria-checked={!createMode && selectedGroupId === group.id}
                  className={cn(
                    "flex w-full items-center rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    !createMode && selectedGroupId === group.id
                      ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)]"
                      : "border-border/70 hover:bg-[color:var(--surface-active)]",
                  )}
                  onClick={() => {
                    setCreateMode(false);
                    setSelectedGroupId(group.id);
                  }}
                >
                  {group.name}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={createMode}
                className={cn(
                  "flex w-full items-center rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  createMode
                    ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)]"
                    : "border-border/70 hover:bg-[color:var(--surface-active)]",
                )}
                onClick={() => setCreateMode(true)}
              >
                Create group
              </button>
              {createMode ? (
                <Input
                  aria-label="New Messenger group name"
                  autoFocus
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                />
              ) : null}
            </div>
          )}
          {keepMutation.error ? (
            <p className="text-sm text-destructive" role="alert">
              {keepMutation.error instanceof Error
                ? keepMutation.error.message
                : "Could not keep this Browser tab."}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={keepMutation.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="confirm-main-browser-keep"
              disabled={!canConfirm}
              onClick={() => keepMutation.mutate()}
            >
              {keepMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              Keep in Messenger
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function nextTabAfterClose(
  tab: MainWorkbenchTab,
  activeViewInstanceId: string | null,
  tabOrder: string[],
  tabsByViewInstanceId: Record<string, MainWorkbenchTab>,
) {
  if (activeViewInstanceId !== tab.viewInstanceId) {
    return activeViewInstanceId
      ? tabsByViewInstanceId[activeViewInstanceId] ?? null
      : null;
  }
  const closedIndex = tabOrder.indexOf(tab.viewInstanceId);
  const remaining = tabOrder.filter((candidate) => candidate !== tab.viewInstanceId);
  const nextId = remaining[Math.min(Math.max(closedIndex, 0), remaining.length - 1)]
    ?? null;
  return nextId ? tabsByViewInstanceId[nextId] ?? null : null;
}

export function MessengerMainWorkbench({
  className,
  organizationId,
}: {
  className?: string;
  organizationId: string;
}) {
  const navigate = useNavigate();
  const workbench = useOrganizationMainWorkbench(organizationId);
  const { disposeSurface } = useLiveSurfaceRuntime();
  const durableBrowserTargets = useMemo(
    () => workbench.tabs.flatMap((tab) => (
      tab.savedViewId && tab.target.kind === "browser" ? [tab.target] : []
    )),
    [workbench.tabs],
  );
  const { flushTarget: flushBrowserSavedViewTarget } =
    useBrowserSavedViewMetadataPersister({
      browserTargets: durableBrowserTargets,
      organizationId,
    });
  const [focusedViewInstanceId, setFocusedViewInstanceId] = useState<string | null>(
    workbench.activeViewInstanceId,
  );
  const [bindingAnnouncement, setBindingAnnouncement] = useState("");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastActiveRouteRef = useRef<string | null>(
    workbench.activeTab ? routeForTab(workbench.activeTab) : null,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: workbenchTabKeyboardCodes,
    }),
  );

  const rovingViewInstanceId = focusedViewInstanceId
    && workbench.tabsByViewInstanceId[focusedViewInstanceId]
    ? focusedViewInstanceId
    : workbench.activeViewInstanceId;
  const activeSessionBrowser = workbench.activeTab?.savedViewId === null
    && workbench.activeTab.target.kind === "browser"
    ? workbench.activeTab as MainWorkbenchTab & {
        target: Extract<MainWorkbenchTarget, { kind: "browser" }>;
      }
    : null;
  const activeRoute = workbench.activeTab ? routeForTab(workbench.activeTab) : null;
  const movingViewInstanceIds = useMemo(
    () => new Set(
      Object.values(workbench.promotionsById)
        .filter((promotion) => promotion.status === "detaching")
        .map((promotion) => promotion.source.viewInstanceId),
    ),
    [workbench.promotionsById],
  );

  useEffect(() => {
    if (!activeRoute) {
      if (lastActiveRouteRef.current !== null) {
        lastActiveRouteRef.current = null;
        navigate("/messenger", { replace: true });
        return;
      }
      lastActiveRouteRef.current = null;
      return;
    }
    if (lastActiveRouteRef.current === activeRoute) return;
    lastActiveRouteRef.current = activeRoute;
    navigate(activeRoute, { replace: true });
  }, [activeRoute, navigate]);

  useEffect(() => {
    if (workbench.activeViewInstanceId) {
      setFocusedViewInstanceId(workbench.activeViewInstanceId);
      tabRefs.current.get(workbench.activeViewInstanceId)?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
    } else {
      setFocusedViewInstanceId(null);
    }
  }, [workbench.activeViewInstanceId]);

  const activateTab = useCallback((tab: MainWorkbenchTab) => {
    workbench.focusTab(tab.viewInstanceId);
    const route = routeForTab(tab);
    lastActiveRouteRef.current = route;
    navigate(route, { replace: true });
  }, [navigate, workbench.focusTab]);

  const focusRelativeTab = useCallback((
    currentViewInstanceId: string,
    key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
  ) => {
    const currentIndex = workbench.tabOrder.indexOf(currentViewInstanceId);
    if (currentIndex < 0 || workbench.tabOrder.length === 0) return;
    let nextIndex = currentIndex;
    if (key === "Home") nextIndex = 0;
    if (key === "End") nextIndex = workbench.tabOrder.length - 1;
    if (key === "ArrowLeft") {
      nextIndex = (
        currentIndex - 1 + workbench.tabOrder.length
      ) % workbench.tabOrder.length;
    }
    if (key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % workbench.tabOrder.length;
    }
    const nextViewInstanceId = workbench.tabOrder[nextIndex];
    if (!nextViewInstanceId) return;
    setFocusedViewInstanceId(nextViewInstanceId);
    tabRefs.current.get(nextViewInstanceId)?.focus();
  }, [workbench.tabOrder]);

  const cycleActiveTab = useCallback((direction: -1 | 1) => {
    if (workbench.tabOrder.length < 2 || !workbench.activeViewInstanceId) return;
    const activeIndex = workbench.tabOrder.indexOf(workbench.activeViewInstanceId);
    if (activeIndex < 0) return;
    const nextIndex = (
      activeIndex + direction + workbench.tabOrder.length
    ) % workbench.tabOrder.length;
    const nextViewInstanceId = workbench.tabOrder[nextIndex];
    const nextTab = nextViewInstanceId
      ? workbench.tabsByViewInstanceId[nextViewInstanceId] ?? null
      : null;
    if (nextTab) activateTab(nextTab);
  }, [
    activateTab,
    workbench.activeViewInstanceId,
    workbench.tabOrder,
    workbench.tabsByViewInstanceId,
  ]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const viewInstanceId = String(event.active.id);
    const overViewInstanceId = event.over ? String(event.over.id) : null;
    if (!overViewInstanceId || viewInstanceId === overViewInstanceId) return;
    const toIndex = workbench.tabOrder.indexOf(overViewInstanceId);
    if (toIndex >= 0) workbench.reorderTab(viewInstanceId, toIndex);
  }, [workbench.reorderTab, workbench.tabOrder]);

  const closeTab = useCallback(async (tab: MainWorkbenchTab) => {
    if (movingViewInstanceIds.has(tab.viewInstanceId)) return;
    if (tab.savedViewId && tab.target.kind === "browser") {
      await flushBrowserSavedViewTarget(tab.target);
    }
    const nextTab = nextTabAfterClose(
      tab,
      workbench.activeViewInstanceId,
      workbench.tabOrder,
      workbench.tabsByViewInstanceId,
    );
    workbench.closeTab(tab.viewInstanceId);
    disposeSurface(tab.runtimeId);
    const route = routeForTab(nextTab);
    lastActiveRouteRef.current = nextTab ? route : null;
    navigate(route, { replace: true });
  }, [
    disposeSurface,
    flushBrowserSavedViewTarget,
    navigate,
    movingViewInstanceIds,
    workbench.activeViewInstanceId,
    workbench.closeTab,
    workbench.tabOrder,
    workbench.tabsByViewInstanceId,
  ]);

  const handleWorkbenchKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement> | KeyboardEvent,
  ) => {
    if (event.defaultPrevented) return;
    if (
      event.key === "Tab"
      && event.ctrlKey
      && !event.metaKey
      && !event.altKey
    ) {
      event.preventDefault();
      cycleActiveTab(event.shiftKey ? -1 : 1);
      return;
    }
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const command = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!command || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "t" && !event.shiftKey) {
      event.preventDefault();
      const opened = workbench.createSessionBrowser();
      if (opened.admitted) {
        navigate("/messenger/workbench", { replace: true });
      }
      return;
    }
    if (key === "w" && !event.shiftKey && workbench.activeTab) {
      event.preventDefault();
      void closeTab(workbench.activeTab);
    }
  }, [
    closeTab,
    cycleActiveTab,
    navigate,
    workbench.activeTab,
    workbench.createSessionBrowser,
  ]);

  useEffect(() => {
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const mainRuntimeHost = target.closest<HTMLElement>(
        "[data-testid='live-surface-runtime-host'][data-owner-id^='main:']",
      );
      const belongsToOrganizationRuntime = mainRuntimeHost
        ?.dataset.ownerId?.startsWith(`main:${organizationId}:`) ?? false;
      if (!belongsToOrganizationRuntime) return;
      handleWorkbenchKeyDown(event);
    };
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
    };
  }, [handleWorkbenchKeyDown, organizationId]);

  const panels = useMemo(() => workbench.tabs.map((tab) => {
    const active = tab.viewInstanceId === workbench.activeViewInstanceId;
    return (
      <section
        key={tab.viewInstanceId}
        id={panelDomId(organizationId, tab.viewInstanceId)}
        role="tabpanel"
        aria-labelledby={tabDomId(organizationId, tab.viewInstanceId)}
        hidden={!active}
        className={cn("h-full min-h-0", !active && "hidden")}
      >
        <MainLiveSurfacePanel
          active={active}
          onClose={() => void closeTab(tab)}
          onCycleTab={cycleActiveTab}
          organizationId={organizationId}
          tab={tab as MainWorkbenchTab & { target: LiveSurfaceTarget }}
        />
      </section>
    );
  }), [
    closeTab,
    cycleActiveTab,
    organizationId,
    workbench.activeViewInstanceId,
    workbench.tabs,
  ]);

  return (
    <div
      className={cn(
        "messenger-main-workbench-surface flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--desktop-workspace-radius)]",
        className,
      )}
      data-testid="messenger-main-workbench"
      onKeyDownCapture={handleWorkbenchKeyDown}
    >
      <DndContext
        collisionDetection={closestCenter}
        sensors={sensors}
        onDragEnd={handleDragEnd}
      >
        <div
          role="tablist"
          aria-label="Main Workbench tabs"
          className="scrollbar-auto-hide flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 px-2"
        >
          <SortableContext
            items={workbench.tabOrder}
            strategy={horizontalListSortingStrategy}
          >
            {workbench.tabs.map((tab) => (
              <SortableWorkbenchTab
                key={tab.viewInstanceId}
                active={tab.viewInstanceId === workbench.activeViewInstanceId}
                focused={tab.viewInstanceId === rovingViewInstanceId}
                moving={movingViewInstanceIds.has(tab.viewInstanceId)}
                organizationId={organizationId}
                setTabRef={(node) => {
                  if (node) tabRefs.current.set(tab.viewInstanceId, node);
                  else tabRefs.current.delete(tab.viewInstanceId);
                }}
                tab={tab}
                onActivate={() => activateTab(tab)}
                onClose={() => void closeTab(tab)}
                onLocalAppUpdated={(definition) => {
                  workbench.updateTarget(
                    tab.runtimeId,
                    tab.viewInstanceId,
                    { ...tab.target, label: definition.title },
                  );
                }}
                onFocus={() => setFocusedViewInstanceId(tab.viewInstanceId)}
                onKeyDown={(event) => {
                  if (
                    event.key === "ArrowLeft"
                    || event.key === "ArrowRight"
                    || event.key === "Home"
                    || event.key === "End"
                  ) {
                    event.preventDefault();
                    focusRelativeTab(tab.viewInstanceId, event.key);
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activateTab(tab);
                  }
                }}
              />
            ))}
          </SortableContext>
          {activeSessionBrowser ? (
            <SessionBrowserKeepControl
              key={activeSessionBrowser.viewInstanceId}
              onAnnounce={setBindingAnnouncement}
              organizationId={organizationId}
              tab={activeSessionBrowser}
            />
          ) : null}
          <button
            type="button"
            aria-label="New Browser tab"
            disabled={!workbench.canCreateBrowser}
            title={workbench.canCreateBrowser
              ? "New Browser tab"
              : "Maximum of 8 live Browser tabs reached"}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              const opened = workbench.createSessionBrowser();
              if (opened.admitted) {
                navigate("/messenger/workbench", { replace: true });
              }
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </DndContext>
      {!workbench.canCreateBrowser ? (
        <p role="status" aria-live="polite" className="sr-only">
          Maximum of 8 live Browser tabs reached.
        </p>
      ) : null}
      {bindingAnnouncement ? (
        <p role="status" aria-live="polite" className="sr-only">
          {bindingAnnouncement}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {workbench.tabs.length === 0 ? (
          <div
            data-testid="messenger-main-workbench-empty"
            className="flex h-full min-h-48 items-center justify-center px-6 text-center text-sm text-muted-foreground"
          >
            Open a saved view or create a Browser tab.
          </div>
        ) : panels}
      </div>
    </div>
  );
}
