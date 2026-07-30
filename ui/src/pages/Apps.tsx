import { agentsApi } from "@/api/agents";
import { appBuilderApi } from "@/api/app-builder";
import { chatsApi } from "@/api/chats";
import { healthApi } from "@/api/health";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WorkspaceTab } from "@/components/workbench/WorkspaceTab";
import { useOrganization } from "@/context/OrganizationContext";
import { useToast } from "@/context/ToastContext";
import { useAppRegistry } from "@/hooks/useAppRegistry";
import {
  APP_BUILDER_SCAFFOLD_VERSION,
  appBuilderChatPrefill,
  appBuilderSourceRoot,
} from "@/lib/app-builder";
import {
  activeKeyFromPath,
  appBuildStatusLabel,
  appRoute,
  localBindingKey,
  type AppEntry,
  type ManagedAppEntry,
} from "@/lib/apps-workspace";
import {
  readDesktopShell,
  type DesktopLocalAppDefinition,
} from "@/lib/desktop-shell";
import {
  localAppStatusRefetchInterval,
  resolveLocalAppAttestedWebview,
} from "@/lib/local-apps";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import type {
  Agent,
  AppBuilderApp,
  ChatConversation,
  ChatStreamEvent,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowUp,
  Copy,
  Download,
  ExternalLink,
  Home,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  Settings,
  Square,
  Upload
} from "lucide-react";
import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

type WorkspaceTab = {
  key: string;
  title: string;
};

function runtimeLabel(status: string | null | undefined) {
  if (!status) return "Checking";
  if (status === "orphaned_unverified") return "Needs attention";
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function chooseBuilderAgent(agents: Agent[]) {
  const available = agents.filter((agent) => agent.status !== "terminated");
  return available.find((agent) => agent.role === "ceo")
    ?? available.find((agent) => agent.status === "active")
    ?? available[0]
    ?? null;
}

function AppsHome({
  appCount,
  createError,
  createPending,
  onCreate,
}: {
  appCount: number;
  createError: unknown;
  createPending: boolean;
  onCreate: (idea: string) => void;
}) {
  const [idea, setIdea] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const examples = [
    "A cold email CRM that tracks contacts, sequences, replies, and follow-ups",
    "A marketing dashboard that imports campaign data and explains weekly changes",
    "A lightweight customer portal with accounts, requests, and status updates",
  ];
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = idea.trim();
    if (!value || createPending) return;
    onCreate(value);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <main
        className="scrollbar-auto-hide min-w-0 flex-1 overflow-y-auto"
        data-testid="apps-home"
      >
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 py-8 lg:px-10 lg:py-10">
          <div className="motion-content-reveal w-full max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">
              Turn ideas into <span className="text-[color:var(--accent-base)]">applications</span>
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Describe the workflow you need. Rudder opens a Chat with App Builder,
              creates the source, verifies it, and brings the finished App back here.
            </p>
          </div>

          <form
            className="motion-content-reveal mt-6 w-full max-w-2xl"
            style={{ animationDelay: "70ms" }}
            onSubmit={submit}
          >
            <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] p-3 shadow-[var(--shadow-sm)] transition-[border-color,box-shadow] duration-150 focus-within:border-[color:color-mix(in_oklab,var(--accent-base)_45%,var(--border-base))] focus-within:shadow-[var(--shadow-md)] motion-reduce:transition-none">
              <textarea
                ref={inputRef}
                value={idea}
                rows={4}
                disabled={createPending}
                onChange={(event) => setIdea(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Describe the App you want to build…"
                aria-label="Describe the App you want to build"
                data-testid="apps-idea-input"
                className="min-h-[5.5rem] w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  <AppWindow className="h-3 w-3" aria-hidden />
                  App Builder
                </span>
                <Button
                  type="submit"
                  size="icon"
                  className="h-8 w-8 rounded-[var(--radius-md)] transition-transform active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none"
                  disabled={!idea.trim() || createPending}
                  aria-label="Create App"
                  data-testid="apps-create-submit"
                >
                  {createPending
                    ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                    : <ArrowUp className="h-4 w-4" aria-hidden />}
                </Button>
              </div>
            </div>
            {createError ? (
              <p className="mt-3 text-left text-sm text-destructive" role="alert">
                {createError instanceof Error
                  ? createError.message
                  : "Could not start the App Builder Chat."}
              </p>
            ) : null}
          </form>

          <div className="mt-7 w-full max-w-2xl border-t border-[color:var(--border-soft)] pt-4">
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">Start with an example</p>
            {examples.map((example, index) => (
              <button
                key={example}
                type="button"
                className="motion-list-enter group flex w-full items-start gap-3 rounded-[var(--radius-sm)] px-2 py-2 text-left transition-[background-color,color] duration-150 hover:bg-[color:var(--surface-active)] motion-reduce:transition-none"
                style={{ animationDelay: `${120 + index * 45}ms` }}
                onClick={() => {
                  setIdea(example);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                <span className="w-20 shrink-0 text-xs font-medium text-foreground">
                  {index === 0 ? "CRM" : index === 1 ? "Dashboard" : "Portal"}
                </span>
                <span className="text-xs leading-5 text-muted-foreground">
                  {example}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-auto pt-10 text-xs text-muted-foreground">
            {appCount === 0
              ? "Your registered Apps will appear in the left sidebar."
              : `${appCount} registered ${appCount === 1 ? "App" : "Apps"} on this device.`}
          </div>
        </div>
      </main>
    </div>
  );
}

function LocalRuntimePane({
  definition,
  managedApp,
}: {
  definition: DesktopLocalAppDefinition;
  managedApp?: AppBuilderApp | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const desktopShell = readDesktopShell();
  const localApps = desktopShell?.localApps;
  const desktopAppBuilder = desktopShell?.appBuilder;
  const [lastSnapshotId, setLastSnapshotId] = useState<string | null>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const runtimeQuery = useQuery({
    queryKey: queryKeys.localApps.status(definition.localBindingId),
    queryFn: () => localApps!.status(definition.id),
    enabled: Boolean(localApps?.supported),
    refetchInterval: (query) =>
      localAppStatusRefetchInterval(query.state.data?.status),
  });
  const runtime = runtimeQuery.data ?? null;
  const targetQuery = useQuery({
    queryKey: [
      ...queryKeys.localApps.status(definition.localBindingId),
      "attested",
      runtime?.generation ?? "none",
    ],
    queryFn: async () => {
      const target = await localApps!.attestedTarget(definition.id);
      if (!target) throw new Error("The local listener could not be verified.");
      return resolveLocalAppAttestedWebview(target);
    },
    enabled: Boolean(localApps?.supported && runtime?.status === "running"),
    retry: false,
  });
  const runtimeMutation = useMutation({
    mutationFn: (action: "start" | "stop") => (
      action === "start"
        ? localApps!.start(definition.id)
        : localApps!.stop(definition.id)
    ),
    onSuccess: (next) => {
      queryClient.setQueryData(
        queryKeys.localApps.status(definition.localBindingId),
        next,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.localApps.status(definition.localBindingId),
      });
    },
  });
  const dataMutation = useMutation({
    mutationFn: async (action: "backup" | "import" | "restore") => {
      if (!managedApp || !desktopAppBuilder) {
        throw new Error("App data controls are unavailable on this device.");
      }
      const location = {
        projectId: managedApp.orgId,
        appDirectory: managedApp.sourceRoot,
        binding: {
          desktopInstallationId: definition.desktopInstallationId,
          definitionId: definition.id,
          appPublicId: definition.appPublicId,
          localBindingId: definition.localBindingId,
        },
      };
      if (action === "backup") {
        const snapshot = await desktopAppBuilder.snapshot(location);
        const exported = await desktopAppBuilder.exportSnapshot({
          ...location,
          snapshotId: snapshot.id,
        });
        if (!exported.canceled) {
          setLastSnapshotId(snapshot.id);
          setDataMessage("Backup exported.");
        }
        return;
      }
      if (action === "import") {
        const imported = await desktopAppBuilder.importData(location);
        if (!imported.canceled) {
          setLastSnapshotId(imported.rollbackSnapshot.id);
          setDataMessage("Data imported. The previous data is available as a restore point.");
        }
        return;
      }
      if (!lastSnapshotId) throw new Error("Create a backup or import data first.");
      const restored = await desktopAppBuilder.restoreSnapshot({
        ...location,
        snapshotId: lastSnapshotId,
      });
      setLastSnapshotId(restored.safetySnapshot.id);
      setDataMessage("Data restored. A safety snapshot was kept.");
    },
  });
  const running = runtime?.status === "running";
  const pending = runtimeMutation.isPending
    || runtime?.status === "starting"
    || runtime?.status === "stopping";
  const localLink = targetQuery.data?.src ?? null;
  const error = runtimeQuery.error ?? targetQuery.error ?? runtimeMutation.error;

  return (
    <div className="flex min-h-0 flex-1">
      <main className="relative min-w-0 flex-1 overflow-hidden bg-[color:var(--surface-panel)]">
        {running && targetQuery.data ? (
          <div className="motion-content-reveal flex h-full min-h-0">
            {createElement("webview", {
              key: localBindingKey(
                definition.desktopInstallationId,
                definition.appPublicId,
                `${definition.localBindingId}:${runtime?.generation ?? "none"}:${targetQuery.data.partition}`,
              ),
              src: targetQuery.data.src,
              partition: targetQuery.data.partition,
              className: "min-h-0 flex-1 bg-[color:var(--surface-panel)]",
              "data-testid": "apps-local-webview",
              "data-local-binding-id": definition.localBindingId,
              "data-webview-isolation-key": localBindingKey(
                definition.desktopInstallationId,
                definition.appPublicId,
                `${definition.localBindingId}:${runtime?.generation ?? "none"}:${targetQuery.data.partition}`,
              ),
            })}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-8 py-12">
            <div className="motion-content-reveal max-w-md text-center">
              <div className="motion-live-surface mx-auto flex h-14 w-14 items-center justify-center rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-raised)] text-[color:var(--accent-base)]">
                {pending
                  ? <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden />
                  : <AppWindow className="h-6 w-6" aria-hidden />}
              </div>
              <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-foreground">
                {pending
                  ? `${runtimeLabel(runtime?.status)}…`
                  : runtime?.status === "failed"
                    ? "The App stopped after an error"
                    : "Ready to open"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {pending
                  ? "Rudder is preparing the reviewed local runtime."
                  : "Starting runs this App on your device and opens it inside Rudder."}
              </p>
              {runtime?.error ? (
                <p className="mt-3 text-sm text-destructive">{runtime.error}</p>
              ) : null}
              {!pending ? (
                <Button
                  type="button"
                  className="mt-6"
                  onClick={() => runtimeMutation.mutate("start")}
                  data-testid="apps-start-app"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  {runtime?.status === "failed" ? "Retry & open" : "Start & open"}
                </Button>
              ) : null}
              {error ? (
                <p className="mt-4 break-words text-sm text-destructive" role="alert">
                  {error instanceof Error ? error.message : "The App could not be opened."}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </main>
      <aside className="hidden w-[280px] shrink-0 border-l border-[color:var(--border-soft)] bg-[color:var(--surface-shell)] p-5 xl:block">
        <div className="flex items-center gap-3">
          <LocalAppIdentityIcon
            className="h-9 w-9 rounded-[var(--radius-md)]"
            iconDataUrl={definition.iconDataUrl}
          />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {definition.title}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {runtimeLabel(runtime?.status)}
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-3 border-t border-[color:var(--border-soft)] pt-4 text-xs">
          <div>
            <p className="font-medium text-muted-foreground">Source</p>
            <p
              className="mt-1 truncate font-mono text-[11px] text-foreground"
              title={managedApp?.sourceRoot ?? definition.cwd}
            >
              {managedApp?.sourceRoot ?? definition.cwd}
            </p>
          </div>
          <div>
            <p className="font-medium text-muted-foreground">Address</p>
            <p className="mt-1 truncate font-mono text-[11px] text-foreground" title={localLink ?? "Starts on demand"}>
              {localLink ?? "Starts on demand"}
            </p>
          </div>
          {managedApp ? (
            <div>
              <p className="font-medium text-muted-foreground">Build</p>
              <p className="mt-1 text-foreground">{appBuildStatusLabel(managedApp.buildStatus)}</p>
            </div>
          ) : null}
        </div>

        <div className="mt-5 grid gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => runtimeMutation.mutate(running ? "stop" : "start")}
          >
            {running
              ? <Square className="h-3.5 w-3.5" aria-hidden />
              : <Play className="h-3.5 w-3.5" aria-hidden />}
            {running ? "Stop App" : "Start App"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!localLink}
            onClick={() => {
              if (!localLink) return;
              void desktopShell?.copyText(localLink).then(() => {
                pushToast({ title: "App link copied", tone: "success" });
              });
            }}
            data-testid="apps-copy-link"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
            Copy App link
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!localLink}
            onClick={() => {
              if (!localLink) return;
              const open = desktopShell?.forceOpenExternal ?? desktopShell?.openExternal;
              void open?.(localLink);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open in browser
          </Button>
          {managedApp?.conversationId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => navigate(`/messenger/chat/${managedApp.conversationId}`)}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
              Continue in Chat
            </Button>
          ) : null}
        </div>

        {managedApp ? (
          <div className="mt-5 border-t border-[color:var(--border-soft)] pt-4">
            <h3 className="text-xs font-semibold text-foreground">Development data</h3>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={dataMutation.isPending}
                onClick={() => dataMutation.mutate("backup")}
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                Backup
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={dataMutation.isPending}
                onClick={() => dataMutation.mutate("import")}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden />
                Import
              </Button>
              {lastSnapshotId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="col-span-2"
                  disabled={dataMutation.isPending}
                  onClick={() => dataMutation.mutate("restore")}
                >
                  Restore previous data
                </Button>
              ) : null}
            </div>
            {dataMessage ? (
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground" role="status">
                {dataMessage}
              </p>
            ) : null}
            {dataMutation.error ? (
              <p className="mt-2 text-[11px] leading-4 text-destructive" role="alert">
                {dataMutation.error instanceof Error
                  ? dataMutation.error.message
                  : "The data operation failed."}
              </p>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function ManagedSetupPane({
  entry,
}: {
  entry: ManagedAppEntry;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const desktopShell = readDesktopShell();
  const desktopAppBuilder = desktopShell?.appBuilder;
  const localApps = desktopShell?.localApps;
  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!desktopAppBuilder?.supported) {
        throw new Error("Register & preview is available in Rudder Desktop.");
      }
      const { app } = entry;
      const existingDefinitionIds = new Set(
        localApps?.supported
          ? (await localApps.list()).map((definition) => definition.id)
          : [],
      );
      let binding: Awaited<ReturnType<typeof desktopAppBuilder.ensurePreview>> | null = null;
      let serverBound = false;
      let ownedBuildStatus: "building" | "verifying" | null = null;
      await appBuilderApi.updateBuild(app.orgId, app.id, {
        status: "building",
        expectedStatus: app.buildStatus,
      });
      ownedBuildStatus = "building";
      try {
        await desktopAppBuilder.inspect({
          projectId: app.orgId,
          appDirectory: app.sourceRoot,
        }).catch(() => {
          throw new Error(
            "No App source is ready yet. Continue in Chat and let App Builder finish first.",
          );
        });
        binding = await desktopAppBuilder.ensurePreview({
          projectId: app.orgId,
          appDirectory: app.sourceRoot,
          binding: null,
          authorizeManagedStart: true,
        });
        await appBuilderApi.updateBuild(app.orgId, app.id, {
          status: "verifying",
          expectedStatus: "building",
          runKind: "verification",
        });
        ownedBuildStatus = "verifying";
        await desktopAppBuilder.startPreview({
          projectId: app.orgId,
          appDirectory: app.sourceRoot,
          binding,
        });
        await appBuilderApi.bindLocalRuntime(app.orgId, app.id, {
          desktopInstallationId: binding.desktopInstallationId,
          appPublicId: binding.appPublicId,
          localBindingId: binding.localBindingId,
        });
        serverBound = true;
        await appBuilderApi.updateBuild(app.orgId, app.id, {
          status: "ready",
          expectedStatus: "verifying",
        });
        ownedBuildStatus = null;
      } catch (error) {
        if (binding) {
          await desktopAppBuilder.stopPreview({
            projectId: app.orgId,
            appDirectory: app.sourceRoot,
            binding,
          }).catch(() => undefined);
          if (localApps?.supported && !existingDefinitionIds.has(binding.definitionId)) {
            await localApps.delete(binding.definitionId).catch(() => undefined);
          }
        }
        if (serverBound) {
          await appBuilderApi.clearLocalRuntime(app.orgId, app.id).catch(() => undefined);
        }
        if (ownedBuildStatus) {
          await appBuilderApi.updateBuild(app.orgId, app.id, {
            status: "failed",
            expectedStatus: ownedBuildStatus,
          }).catch(() => undefined);
        }
        throw error;
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.appBuilder.organization(entry.app.orgId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.localApps.definitions }),
      ]);
    },
  });

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 items-center justify-center bg-[color:var(--surface-panel)] px-8 py-12">
        <div className="motion-content-reveal max-w-lg text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[var(--radius-xl)] border border-[color:var(--border-soft)] bg-[color:var(--surface-raised)] text-[color:var(--accent-base)]">
            {registerMutation.isPending
              ? <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden />
              : <AppWindow className="h-6 w-6" aria-hidden />}
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-foreground">
            {entry.app.name}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {registerMutation.isPending
              ? "Rudder is verifying the source, registering the local runtime, and starting the preview."
              : "When App Builder has finished creating the source, register it on this device to open it here."}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              disabled={registerMutation.isPending || !desktopAppBuilder?.supported}
              onClick={() => setConfirmOpen(true)}
              data-testid="apps-register-preview"
            >
              {registerMutation.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                : <Play className="h-3.5 w-3.5" aria-hidden />}
              Register & preview
            </Button>
            {entry.app.conversationId ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(`/messenger/chat/${entry.app.conversationId}`)}
              >
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                Continue in Chat
              </Button>
            ) : null}
          </div>
          {registerMutation.error ? (
            <p className="mt-4 text-sm leading-6 text-destructive" role="alert">
              {registerMutation.error instanceof Error
                ? registerMutation.error.message
                : "The App could not be registered."}
            </p>
          ) : null}
        </div>
      </main>
      <aside className="hidden w-[280px] shrink-0 border-l border-[color:var(--border-soft)] bg-[color:var(--surface-shell)] p-5 xl:block">
        <h2 className="text-sm font-semibold text-foreground">App details</h2>
        <dl className="mt-4 space-y-4 text-xs">
          <div>
            <dt className="font-medium text-muted-foreground">Build status</dt>
            <dd className="mt-1 text-foreground">{appBuildStatusLabel(entry.app.buildStatus)}</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Source</dt>
            <dd className="mt-1 break-all font-mono text-[11px] text-foreground">
              {entry.app.sourceRoot}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Runtime</dt>
            <dd className="mt-1 text-foreground">Not registered on this device</dd>
          </div>
        </dl>
      </aside>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Register and preview this App?</DialogTitle>
            <DialogDescription className="leading-6">
              Rudder will verify the maintained scaffold, run its checks, then
              start a loopback-only App process on this device.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="apps-confirm-register-preview"
              onClick={() => {
                setConfirmOpen(false);
                registerMutation.mutate();
              }}
            >
              Verify, register & open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActiveAppPane({ entry }: { entry: AppEntry }) {
  if (entry.kind === "managed") {
    if (!entry.definition) return <ManagedSetupPane entry={entry} />;
    return (
      <LocalRuntimePane
        key={entry.definition.id}
        definition={entry.definition}
        managedApp={entry.app}
      />
    );
  }
  return <LocalRuntimePane key={entry.definition.id} definition={entry.definition} />;
}

export function Apps() {
  const { selectedOrganizationId } = useOrganization();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const activeKey = activeKeyFromPath(location.pathname);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { key: "home", title: "Home" },
  ]);
  const [focusedTabKey, setFocusedTabKey] = useState("home");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousOrganizationId = useRef(selectedOrganizationId);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const sitesEnabled = healthQuery.data?.features?.experimentalSitesEnabled === true;
  const { appsQuery, definitionsQuery, entries } = useAppRegistry(sitesEnabled);
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(
      selectedOrganizationId
      && sitesEnabled,
    ),
  });
  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.key, entry])),
    [entries],
  );
  const activeEntry = entryByKey.get(activeKey) ?? null;

  useEffect(() => {
    if (previousOrganizationId.current === selectedOrganizationId) return;
    previousOrganizationId.current = selectedOrganizationId;
    setTabs([{ key: "home", title: "Home" }]);
    setFocusedTabKey("home");
    navigate("/apps", { replace: true });
  }, [navigate, selectedOrganizationId]);

  useEffect(() => {
    if (activeKey === "home" || !activeEntry) return;
    const title = activeEntry.kind === "managed"
      ? activeEntry.app.name
      : activeEntry.definition.title;
    setTabs((current) => (
      current.some((tab) => tab.key === activeKey)
        ? current
        : [...current, { key: activeKey, title }]
    ));
  }, [activeEntry, activeKey]);

  useEffect(() => {
    if (activeKey !== "home" && !activeEntry && !appsQuery.isLoading && !definitionsQuery.isLoading) {
      navigate("/apps", { replace: true });
    }
  }, [
    activeEntry,
    activeKey,
    appsQuery.isLoading,
    definitionsQuery.isLoading,
    navigate,
  ]);

  const createAppMutation = useMutation({
    mutationFn: async (idea: string) => {
      if (!selectedOrganizationId) throw new Error("Choose an organization first.");
      const agent = chooseBuilderAgent(agentsQuery.data ?? []);
      if (!agent) {
        throw new Error("Add an active Agent before creating an App.");
      }
      const firstLine = idea.split(/\r?\n/u, 1)[0]?.trim() || "New App";
      const appName = firstLine.slice(0, 80);
      const sourceRoot = appBuilderSourceRoot(appName, crypto.randomUUID());
      const app = await appBuilderApi.create(selectedOrganizationId, {
        name: appName,
        sourceRoot,
        scaffoldVersion: APP_BUILDER_SCAFFOLD_VERSION,
      });
      const body = [
        appBuilderChatPrefill(appName, false, sourceRoot),
        idea,
      ].join("\n\n");
      let acknowledged = false;
      const acknowledgement = new Promise<ChatConversation>((resolve, reject) => {
        const onEvent = (event: ChatStreamEvent) => {
          if (event.type !== "ack" || !event.conversation || acknowledged) return;
          acknowledged = true;
          resolve(event.conversation);
        };
        void chatsApi.sendFirstMessageStream(selectedOrganizationId, body, {
          preferredAgentId: agent.id,
          issueCreationMode: "manual_approval",
          planMode: false,
          contextLinks: [],
          onEvent,
        }).then(() => {
          if (!acknowledged) reject(new Error("The App Builder Chat did not start."));
        }).catch((error) => {
          if (!acknowledged) reject(error);
          else {
            pushToast({
              title: "App Builder stopped before finishing",
              body: error instanceof Error ? error.message : "Continue from the Chat to retry.",
              tone: "error",
            });
          }
        });
      });
      let conversation: ChatConversation;
      try {
        conversation = await acknowledgement;
      } catch (error) {
        await appBuilderApi.updateBuild(selectedOrganizationId, app.id, {
          status: "failed",
          expectedStatus: "preparing",
        }).catch(() => undefined);
        throw error;
      }
      try {
        await appBuilderApi.attachConversation(
          selectedOrganizationId,
          app.id,
          conversation.id,
        );
      } catch (error) {
        await appBuilderApi.updateBuild(selectedOrganizationId, app.id, {
          status: "failed",
        }).catch(() => undefined);
        pushToast({
          title: "The App Chat started, but registration needs attention",
          body: "The App remains visible in Apps. Continue in this Chat while Rudder reconnects.",
          tone: "error",
        });
      }
      navigate(`/messenger/chat/${conversation.id}`);
      return { app, conversation };
    },
    onSuccess: async () => {
      if (!selectedOrganizationId) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.appBuilder.organization(selectedOrganizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.chats.list(selectedOrganizationId),
        }),
      ]);
    },
  });

  const activateTab = (key: string) => {
    setFocusedTabKey(key);
    navigate(key === "home" ? "/apps" : appRoute(key));
  };

  const closeTab = (key: string) => {
    const index = tabs.findIndex((candidate) => candidate.key === key);
    const nextTabs = tabs.filter((candidate) => candidate.key !== key);
    const fallback = nextTabs[Math.max(0, index - 1)] ?? nextTabs[0];
    setTabs(nextTabs);
    tabRefs.current.delete(key);
    if (activeKey === key) {
      activateTab(fallback?.key ?? "home");
    } else if (focusedTabKey === key) {
      const fallbackKey = fallback?.key ?? "home";
      setFocusedTabKey(fallbackKey);
      requestAnimationFrame(() => tabRefs.current.get(fallbackKey)?.focus());
    }
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    key: string,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (event.key === "Delete" && key !== "home") {
      event.preventDefault();
      closeTab(key);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextKey = tabs[nextIndex]?.key;
    if (!nextKey) return;
    setFocusedTabKey(nextKey);
    tabRefs.current.get(nextKey)?.focus();
  };

  useEffect(() => {
    setFocusedTabKey(activeKey);
  }, [activeKey]);

  if (healthQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        Loading Apps…
      </div>
    );
  }

  if (!sitesEnabled) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--surface-panel)] px-6">
        <div className="max-w-md text-center">
          <Settings className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
          <h1 className="mt-4 text-lg font-semibold text-foreground">Enable Sites to use Apps</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Sites enables App Builder, registered local Apps, and the Apps workspace.
          </p>
          <Button
            className="mt-5"
            type="button"
            onClick={() => navigate("/instance/settings/experimental")}
          >
            Open Experimental settings
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden"
      data-testid="apps-workspace"
    >
      <header className="workspace-main-card desktop-chrome flex h-11 shrink-0 items-center gap-1 overflow-x-auto rounded-[var(--desktop-workspace-radius)] px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1" role="tablist" aria-label="Open Apps">
          {tabs.map((tab, index) => {
            const selected = tab.key === activeKey;
            return (
              <WorkspaceTab
                key={tab.key}
                active={selected}
                buttonRef={(node) => {
                  if (node) tabRefs.current.set(tab.key, node);
                  else tabRefs.current.delete(tab.key);
                }}
                focused={focusedTabKey === tab.key}
                icon={tab.key === "home"
                  ? <Home className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  : <AppWindow className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                id={`apps-workspace-tab-${encodeURIComponent(tab.key)}`}
                panelId={`apps-workspace-panel-${encodeURIComponent(tab.key)}`}
                label={tab.title}
                onActivate={() => activateTab(tab.key)}
                onClose={tab.key === "home" ? undefined : () => closeTab(tab.key)}
                onFocus={() => setFocusedTabKey(tab.key)}
                onKeyDown={(event) => handleTabKeyDown(event, index, tab.key)}
                testId={`apps-tab-${tab.key}`}
              />
            );
          })}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={() => activateTab("home")}
          aria-label="New App"
          title="New App"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </header>

      <div
        id={`apps-workspace-panel-${encodeURIComponent(activeKey)}`}
        role="tabpanel"
        aria-labelledby={`apps-workspace-tab-${encodeURIComponent(activeKey)}`}
        className="workspace-main-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--desktop-workspace-radius)]"
      >
        {activeKey === "home" || !activeEntry ? (
          <AppsHome
            appCount={entries.length}
            createError={createAppMutation.error}
            createPending={createAppMutation.isPending}
            onCreate={(idea) => createAppMutation.mutate(idea)}
          />
        ) : (
          <ActiveAppPane entry={activeEntry} />
        )}
      </div>
    </section>
  );
}
