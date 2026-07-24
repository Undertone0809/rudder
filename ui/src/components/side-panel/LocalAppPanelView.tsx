import { messengerApi } from "@/api/messenger";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrganization } from "@/context/OrganizationContext";
import { useOptionalToast } from "@/context/ToastContext";
import { readDesktopShell, type DesktopLocalAppRuntimeView } from "@/lib/desktop-shell";
import {
  localAppIdentityMatches,
  localAppStatusRefetchInterval,
  resolveLocalAppAttestedWebview,
} from "@/lib/local-apps";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, CircleAlert, Loader2, MoreHorizontal, Pencil, Pin, Play, RotateCw, Square, TerminalSquare } from "lucide-react";
import { createElement, useEffect, useState } from "react";
import { LocalAppDefinitionReviewDialog } from "./LocalAppsPanel";

type LocalAppTarget = Extract<SidePanelTarget, { kind: "local_app" }>;

function runtimeLabel(status: DesktopLocalAppRuntimeView["status"]) {
  if (status === "orphaned_unverified") return "Needs attention";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

export function LocalAppPanelView({
  active,
  savedViewId = null,
  target,
  onTitleChange,
}: {
  active: boolean;
  savedViewId?: string | null;
  target: LocalAppTarget;
  onTitleChange?: (title: string) => void;
}) {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const toast = useOptionalToast();
  const [logsOpen, setLogsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const localApps = readDesktopShell()?.localApps;
  const supported = Boolean(localApps?.supported);
  const definitionsQuery = useQuery({
    queryKey: queryKeys.localApps.definitions,
    queryFn: () => localApps!.list(),
    enabled: supported,
    staleTime: 1_000,
  });
  const savedViewQuery = useQuery({
    queryKey: queryKeys.messenger.savedView(selectedOrganizationId ?? "__none__", savedViewId ?? "__none__"),
    queryFn: () => messengerApi.getSavedView(selectedOrganizationId!, savedViewId!),
    enabled: Boolean(selectedOrganizationId && savedViewId),
  });
  const pinMutation = useMutation({
    mutationFn: (pinned: boolean) => messengerApi.updateSavedView(
      selectedOrganizationId!,
      savedViewId!,
      { primaryRailPinned: pinned },
    ),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        queryKeys.messenger.savedView(selectedOrganizationId!, savedViewId!),
        updated,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messenger.primaryRailPins(selectedOrganizationId!),
      });
    },
    onError: (error) => {
      toast?.pushToast({
        title: "Could not update Primary Rail pin",
        body: errorMessage(error, "Try again."),
        tone: "error",
      });
    },
  });
  const definition = definitionsQuery.data?.find((candidate) => localAppIdentityMatches(candidate, target)) ?? null;
  const statusQuery = useQuery({
    queryKey: queryKeys.localApps.status(target.localBindingId),
    queryFn: () => localApps!.status(definition!.id),
    enabled: supported && Boolean(definition),
    refetchInterval: (query) => localAppStatusRefetchInterval(query.state.data?.status),
  });
  const status = statusQuery.data ?? null;
  const attestedQuery = useQuery({
    queryKey: [...queryKeys.localApps.status(target.localBindingId), "attested", status?.generation ?? "none"],
    queryFn: async () => {
      const attested = await localApps!.attestedTarget(definition!.id);
      if (!attested) throw new Error("Desktop could not attest this Local App runtime.");
      return resolveLocalAppAttestedWebview(attested);
    },
    enabled: supported && Boolean(definition) && status?.status === "running",
    retry: false,
  });
  useEffect(() => {
    if (status?.status === "running") return;
    queryClient.removeQueries({
      queryKey: [...queryKeys.localApps.status(target.localBindingId), "attested"],
      type: "inactive",
    });
  }, [queryClient, status?.status, target.localBindingId]);
  const startMutation = useMutation({
    mutationFn: () => localApps!.start(definition!.id),
    onSuccess: (nextStatus) => {
      queryClient.setQueryData(queryKeys.localApps.status(target.localBindingId), nextStatus);
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.localApps.status(target.localBindingId), "attested"],
      });
    },
  });
  const stopMutation = useMutation({
    mutationFn: () => localApps!.stop(definition!.id),
    onSuccess: (nextStatus) => {
      queryClient.setQueryData(queryKeys.localApps.status(target.localBindingId), nextStatus);
      queryClient.removeQueries({
        queryKey: [...queryKeys.localApps.status(target.localBindingId), "attested"],
      });
    },
  });
  const editMutation = useMutation({
    mutationFn: (draft: Parameters<NonNullable<typeof localApps>["update"]>[1]) =>
      localApps!.update(definition!.id, draft),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.localApps.definitions, (
        current: Awaited<ReturnType<NonNullable<typeof localApps>["list"]>> | undefined,
      ) => current?.map((candidate) => candidate.id === updated.id ? updated : candidate) ?? [updated]);
      onTitleChange?.(updated.title);
      if (selectedOrganizationId && savedViewId) {
        void messengerApi.updateSavedView(selectedOrganizationId, savedViewId, {
          title: updated.title,
        }).then((savedView) => {
          queryClient.setQueryData(
            queryKeys.messenger.savedView(selectedOrganizationId, savedViewId),
            savedView,
          );
          return Promise.all([
            queryClient.invalidateQueries({
              queryKey: queryKeys.messenger.customGroups(selectedOrganizationId),
            }),
            queryClient.invalidateQueries({
              queryKey: queryKeys.messenger.primaryRailPins(selectedOrganizationId),
            }),
          ]);
        }).catch((error) => {
          toast?.pushToast({
            title: "Local App updated",
            body: `The project details were saved, but its Messenger title could not be refreshed: ${errorMessage(error, "try again.")}`,
            tone: "warn",
          });
        });
      }
      setEditOpen(false);
    },
  });
  const logsQuery = useQuery({
    queryKey: queryKeys.localApps.logs(target.localBindingId),
    queryFn: () => localApps!.logs(definition!.id),
    enabled: supported && Boolean(definition) && (logsOpen || status?.status === "failed" || Boolean(startMutation.error)),
    retry: false,
  });

  const queryError = definitionsQuery.error
    ?? statusQuery.error
    ?? startMutation.error
    ?? stopMutation.error
    ?? attestedQuery.error;
  const unavailable = !supported || (definitionsQuery.isSuccess && !definition);
  const orphaned = status?.status === "orphaned_unverified";
  const canStart = status?.status === "stopped" || status?.status === "failed";
  const canStop = status?.status === "running" || status?.status === "starting" || status?.status === "stopping";
  const logsRegion = logsQuery.error ? (
    <div
      className="mt-3 rounded-[var(--radius-md)] border border-destructive/25 bg-destructive/5 p-3 text-left"
      data-testid="local-app-logs-error"
      role="alert"
    >
      <p className="break-words text-xs leading-5 text-destructive">
        {errorMessage(logsQuery.error, "Could not load runtime logs.")}
      </p>
      <Button type="button" className="mt-3" size="sm" variant="outline" onClick={() => void logsQuery.refetch()}>
        <RotateCw className="h-3.5 w-3.5" aria-hidden />
        Retry logs
      </Button>
    </div>
  ) : (
    <pre
      data-testid="local-app-logs"
      className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[color:var(--surface-inset)] p-3 text-left font-mono text-[11px] leading-5 text-muted-foreground"
      tabIndex={0}
      aria-label={`${target.label} runtime logs`}
    >
      {logsQuery.isPending ? "Loading logs…" : logsQuery.data?.join("\n") || "No runtime logs yet."}
    </pre>
  );

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-[color:var(--surface-panel)]"
      data-testid="local-app-view"
      data-active={active ? "true" : "false"}
      aria-label={target.label}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-soft)] px-3 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[color:var(--surface-active)] text-muted-foreground">
          <LocalAppIdentityIcon
            className="h-4 w-4"
            iconDataUrl={definition?.iconDataUrl}
            identity={target}
            testId="local-app-header-icon"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {definition?.title ?? target.label}
          </span>
          <span className="block text-xs text-muted-foreground">
            {status ? runtimeLabel(status.status) : unavailable ? "Unavailable" : "Checking local runtime…"}
          </span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              data-testid="local-app-more"
              aria-label={`More actions for ${target.label}`}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={!definition || orphaned}
              onClick={() => {
                editMutation.reset();
                setEditOpen(true);
              }}
            >
              <Pencil className="h-4 w-4" />
              Edit details
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLogsOpen((open) => !open)}>
              <TerminalSquare className="h-4 w-4" />
              {logsOpen ? "Hide logs" : "Show logs"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!savedViewId
                || !selectedOrganizationId
                || savedViewQuery.isPending
                || pinMutation.isPending}
              onClick={() => {
                if (savedViewQuery.isError) {
                  void savedViewQuery.refetch();
                  return;
                }
                pinMutation.mutate(!savedViewQuery.data?.primaryRailPinnedAt);
              }}
            >
              <Pin className="h-4 w-4" />
              {!savedViewId
                ? "Keep in Messenger to pin"
                : savedViewQuery.isPending
                  ? "Checking pin status…"
                  : savedViewQuery.isError
                    ? "Retry pin status"
                    : savedViewQuery.data?.primaryRailPinnedAt
                      ? "Unpin from Primary Rail"
                      : "Pin to Primary Rail"}
            </DropdownMenuItem>
            {canStop ? <DropdownMenuSeparator /> : null}
            {canStop ? (
              <DropdownMenuItem
                data-testid="local-app-stop"
                disabled={stopMutation.isPending || status?.status === "stopping"}
                onClick={() => stopMutation.mutate()}
              >
                {stopMutation.isPending || status?.status === "stopping"
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  : <Square className="h-4 w-4" aria-hidden />}
                Stop
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {definitionsQuery.isPending || (definition && statusQuery.isPending) ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
          Checking this device…
        </div>
      ) : unavailable ? (
        <div className="m-auto max-w-sm px-6 py-10 text-center" data-testid="local-app-error" role="status">
          <CircleAlert className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
          <h3 className="mt-4 text-base font-semibold text-foreground">Local App not available</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            This saved Local App is not available on this Desktop installation. You can still move or remove it in Messenger.
          </p>
        </div>
      ) : orphaned ? (
        <div className="m-auto max-w-sm px-6 py-10 text-center" data-testid="local-app-error" role="alert">
          <CircleAlert className="mx-auto h-9 w-9 text-amber-500" aria-hidden />
          <h3 className="mt-4 text-base font-semibold text-foreground">Runtime ownership could not be verified</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Rudder will not guess which process to control. Restart Rudder Desktop, then review the Local App before trying again.
          </p>
        </div>
      ) : queryError ? (
        <div className="m-auto max-w-sm px-6 py-10 text-center" data-testid="local-app-error" role="alert">
          <CircleAlert className="mx-auto h-9 w-9 text-destructive" aria-hidden />
          <h3 className="mt-4 text-base font-semibold text-foreground">Could not open Local App</h3>
          <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
            {errorMessage(queryError, "The local runtime did not respond.")}
          </p>
          {startMutation.error ? logsRegion : null}
          <Button
            type="button"
            className="mt-5"
            variant="outline"
            data-testid={startMutation.error ? "local-app-start" : undefined}
            onClick={() => {
              if (startMutation.error) {
                startMutation.reset();
                startMutation.mutate();
                return;
              }
              startMutation.reset();
              stopMutation.reset();
              void definitionsQuery.refetch();
              if (definition) void statusQuery.refetch();
              if (status?.status === "running") void attestedQuery.refetch();
            }}
          >
            {startMutation.error
              ? <Play className="h-3.5 w-3.5" aria-hidden />
              : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
            {startMutation.error ? "Retry & open" : "Retry"}
          </Button>
        </div>
      ) : status?.status === "running" ? (
        attestedQuery.data ? (
          <div className="flex min-h-0 flex-1">
            {createElement("webview", {
              src: attestedQuery.data.src,
              partition: attestedQuery.data.partition,
              className: cn("min-h-[52vh] flex-1 bg-[color:var(--surface-panel)]", !active && "pointer-events-none"),
              "data-testid": "local-app-webview",
              "data-local-binding-id": target.localBindingId,
              "data-view-instance-id": target.viewInstanceId,
              "data-active": active ? "true" : "false",
            })}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Verifying the local listener…
          </div>
        )
      ) : (
        <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto max-w-md rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-5">
            <AppWindow className="h-9 w-9 text-muted-foreground" aria-hidden />
            <h3 className="mt-4 text-base font-semibold text-foreground">
              {status?.status === "failed" ? "Local App stopped after an error" : "Ready when you are"}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Starting runs the reviewed project service on this device. Merely opening or restoring this view never executes it.
            </p>
            {status?.error ? <p className="mt-3 text-sm text-destructive" role="alert">{status.error}</p> : null}
            {canStart ? (
              <Button
                type="button"
                className="mt-5"
                data-testid="local-app-start"
                disabled={startMutation.isPending}
                onClick={() => startMutation.mutate()}
              >
                {startMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  : <Play className="h-3.5 w-3.5" aria-hidden />}
                {status?.status === "failed" ? "Retry & open" : "Start & open"}
              </Button>
            ) : (
              <div className="mt-5 flex items-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                {status ? runtimeLabel(status.status) : "Checking status"}…
              </div>
            )}
            <button
              type="button"
              className="mt-5 flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={logsOpen || status?.status === "failed"}
              onClick={() => setLogsOpen((open) => !open)}
            >
              <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
              {logsOpen ? "Hide logs" : "Show logs"}
            </button>
            {logsOpen || status?.status === "failed" ? logsRegion : null}
          </div>
        </div>
      )}
      <LocalAppDefinitionReviewDialog
        definition={definition}
        edit
        editable={!canStop && !orphaned}
        error={editMutation.error ?? stopMutation.error}
        open={editOpen}
        pending={editMutation.isPending}
        requestEditPending={stopMutation.isPending}
        title="Edit Local App details"
        onCancel={() => {
          editMutation.reset();
          setEditOpen(false);
        }}
        onRequestEdit={() => stopMutation.mutate()}
        onSubmit={(draft) => editMutation.mutate(draft)}
      />
    </section>
  );
}
