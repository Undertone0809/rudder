import { agentsApi } from "@/api/agents";
import { appBuilderApi } from "@/api/app-builder";
import { chatsApi } from "@/api/chats";
import { healthApi } from "@/api/health";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
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
import { Input } from "@/components/ui/input";
import { useOrganization } from "@/context/OrganizationContext";
import { useToast } from "@/context/ToastContext";
import {
  APP_BUILDER_SCAFFOLD_VERSION,
  appBuilderChatPrefill,
  appBuilderSourceRoot,
} from "@/lib/app-builder";
import {
  readDesktopShell,
  type DesktopLocalAppDefinition,
  type DesktopLocalAppDefinitionDraft,
  type DesktopPreparedLocalAppDefinition,
} from "@/lib/desktop-shell";
import {
  localAppStatusRefetchInterval,
  resolveLocalAppAttestedWebview,
} from "@/lib/local-apps";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
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
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  FolderSearch,
  Home,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

type ManagedAppEntry = {
  kind: "managed";
  key: string;
  app: AppBuilderApp;
  definition: DesktopLocalAppDefinition | null;
};

type LocalAppEntry = {
  kind: "local";
  key: string;
  definition: DesktopLocalAppDefinition;
};

type AppEntry = ManagedAppEntry | LocalAppEntry;

type WorkspaceTab = {
  key: string;
  title: string;
};

function appRoute(key: string) {
  return `/apps/view/${encodeURIComponent(key)}`;
}

function localBindingKey(
  desktopInstallationId: string,
  appPublicId: string,
  localBindingId: string,
) {
  return `${desktopInstallationId}:${appPublicId}:${localBindingId}`;
}

function activeKeyFromPath(pathname: string) {
  const relativePath = toOrganizationRelativePath(pathname);
  const match = relativePath.match(/^\/apps\/view\/([^/]+)$/);
  if (!match?.[1]) return "home";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "home";
  }
}

function statusLabel(status: AppBuilderApp["buildStatus"]) {
  if (status === "preparing") return "Preparing";
  if (status === "building") return "Building";
  if (status === "verifying") return "Verifying";
  if (status === "ready") return "Ready";
  return "Needs attention";
}

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
        className="scrollbar-auto-hide min-w-0 flex-1 overflow-y-auto bg-[color:var(--surface-panel)]"
        data-testid="apps-home"
      >
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 py-12 lg:px-14 lg:py-16">
          <div className="motion-content-reveal mx-auto w-full max-w-3xl text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-raised)] text-[color:var(--accent-base)] shadow-sm">
              <Sparkles className="h-5 w-5" aria-hidden />
            </div>
            <h1 className="mt-5 text-[clamp(1.65rem,3vw,2.35rem)] font-semibold tracking-[-0.035em] text-foreground">
              Turn ideas into <span className="text-[color:var(--accent-base)]">applications</span>
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              Describe the workflow you need. Rudder opens a Chat with App Builder,
              creates the source, verifies it, and brings the finished App back here.
            </p>
          </div>

          <form
            className="motion-content-reveal mx-auto mt-8 w-full max-w-3xl"
            style={{ animationDelay: "70ms" }}
            onSubmit={submit}
          >
            <div className="rounded-[calc(var(--radius-xl)+2px)] border border-[color:var(--border-base)] bg-[color:var(--surface-raised)] p-3 shadow-[0_18px_55px_-42px_rgba(0,0,0,0.7)] transition-[border-color,box-shadow,transform] duration-200 focus-within:-translate-y-0.5 focus-within:border-[color:color-mix(in_oklab,var(--accent-base)_45%,var(--border-base))] focus-within:shadow-[0_24px_70px_-44px_rgba(0,0,0,0.85)] motion-reduce:transform-none motion-reduce:transition-none">
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
                className="min-h-[6.5rem] w-full resize-none bg-transparent px-2 py-1 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  <AppWindow className="h-3 w-3" aria-hidden />
                  App Builder
                </span>
                <Button
                  type="submit"
                  size="icon"
                  className="h-9 w-9 rounded-full transition-transform hover:scale-[1.04] active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none"
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

          <div className="mx-auto mt-8 grid w-full max-w-3xl gap-3 md:grid-cols-3">
            {examples.map((example, index) => (
              <button
                key={example}
                type="button"
                className="motion-list-enter group rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4 text-left transition-[transform,border-color,background-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-[color:var(--border-base)] hover:bg-[color:var(--surface-raised)] hover:shadow-sm motion-reduce:transform-none motion-reduce:transition-none"
                style={{ animationDelay: `${120 + index * 45}ms` }}
                onClick={() => {
                  setIdea(example);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                <span className="text-xs font-semibold text-foreground">
                  {index === 0 ? "CRM" : index === 1 ? "Dashboard" : "Portal"}
                </span>
                <span className="mt-2 block text-xs leading-5 text-muted-foreground">
                  {example}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-auto pt-12 text-center text-xs text-muted-foreground">
            {appCount === 0
              ? "Your registered Apps will appear in the left sidebar."
              : `${appCount} registered ${appCount === 1 ? "App" : "Apps"} on this device.`}
          </div>
        </div>
      </main>
      <aside className="hidden w-[280px] shrink-0 border-l border-[color:var(--border-soft)] bg-[color:var(--surface-shell)] p-5 xl:block">
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4">
          <h2 className="text-sm font-semibold text-foreground">How creation works</h2>
          <ol className="mt-4 space-y-4 text-xs leading-5 text-muted-foreground">
            <li className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--surface-active)] font-semibold text-foreground">1</span>
              A dedicated Chat captures your requirements.
            </li>
            <li className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--surface-active)] font-semibold text-foreground">2</span>
              App Builder creates and verifies the App on this device.
            </li>
            <li className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--surface-active)] font-semibold text-foreground">3</span>
              Register it here, then open it in Rudder or copy its local link.
            </li>
          </ol>
        </div>
      </aside>
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
              <p className="mt-1 text-foreground">{statusLabel(managedApp.buildStatus)}</p>
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
            <dd className="mt-1 text-foreground">{statusLabel(entry.app.buildStatus)}</dd>
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
  const desktopShell = readDesktopShell();
  const localApps = desktopShell?.localApps;
  const activeKey = activeKeyFromPath(location.pathname);
  const [search, setSearch] = useState("");
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { key: "home", title: "Home" },
  ]);
  const [review, setReview] = useState<{
    definition: DesktopPreparedLocalAppDefinition;
  } | null>(null);
  const previousOrganizationId = useRef(selectedOrganizationId);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const sitesEnabled = healthQuery.data?.features?.experimentalSitesEnabled === true;
  const appsQuery = useQuery({
    queryKey: queryKeys.appBuilder.organization(selectedOrganizationId ?? "__none__"),
    queryFn: () => appBuilderApi.list(selectedOrganizationId!),
    enabled: Boolean(
      selectedOrganizationId
      && sitesEnabled,
    ),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(
      selectedOrganizationId
      && sitesEnabled,
    ),
  });
  const definitionsQuery = useQuery({
    queryKey: queryKeys.localApps.definitions,
    queryFn: () => localApps!.list(),
    enabled: Boolean(
      localApps?.supported
      && sitesEnabled,
    ),
  });

  const definitionByBinding = useMemo(
    () => new Map(
      (definitionsQuery.data ?? []).map((definition) => [
        localBindingKey(
          definition.desktopInstallationId,
          definition.appPublicId,
          definition.localBindingId,
        ),
        definition,
      ]),
    ),
    [definitionsQuery.data],
  );
  const managedEntries = useMemo<ManagedAppEntry[]>(() => (
    (appsQuery.data ?? []).map((app) => ({
      kind: "managed",
      key: `managed:${app.id}`,
      app,
      definition: app.desktopInstallationId && app.appPublicId && app.localBindingId
        ? definitionByBinding.get(localBindingKey(
            app.desktopInstallationId,
            app.appPublicId,
            app.localBindingId,
          )) ?? null
        : null,
    }))
  ), [appsQuery.data, definitionByBinding]);
  const managedBindingIds = useMemo(
    () => new Set(
      managedEntries
        .map((entry) => entry.definition?.id)
        .filter((id): id is string => Boolean(id)),
    ),
    [managedEntries],
  );
  const localEntries = useMemo<LocalAppEntry[]>(() => (
    (definitionsQuery.data ?? [])
      .filter((definition) => !managedBindingIds.has(definition.id))
      .map((definition) => ({
        kind: "local",
        key: `local:${definition.id}`,
        definition,
      }))
  ), [definitionsQuery.data, managedBindingIds]);
  const entries = useMemo<AppEntry[]>(
    () => [...managedEntries, ...localEntries],
    [localEntries, managedEntries],
  );
  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.key, entry])),
    [entries],
  );
  const filteredEntries = entries.filter((entry) => {
    const title = entry.kind === "managed"
      ? entry.app.name
      : entry.definition.title;
    return title.toLowerCase().includes(search.trim().toLowerCase());
  });
  const activeEntry = entryByKey.get(activeKey) ?? null;

  useEffect(() => {
    if (previousOrganizationId.current === selectedOrganizationId) return;
    previousOrganizationId.current = selectedOrganizationId;
    setSearch("");
    setReview(null);
    setTabs([{ key: "home", title: "Home" }]);
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
      className="flex h-full min-h-0 w-full overflow-hidden bg-[color:var(--surface-shell)]"
      data-testid="apps-workspace"
    >
      <aside className="flex w-[236px] shrink-0 flex-col border-r border-[color:var(--border-soft)] bg-[color:var(--surface-shell)]">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-soft)] px-3">
          <div className="flex items-center gap-2">
            <AppWindow className="h-4 w-4 text-[color:var(--accent-base)]" aria-hidden />
            <span className="text-sm font-semibold text-foreground">Apps</span>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            title="Load an App"
            aria-label="Load an App"
            disabled={!localApps?.supported || discoverMutation.isPending}
            onClick={() => discoverMutation.mutate()}
            data-testid="apps-load"
          >
            {discoverMutation.isPending
              ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              : <Plus className="h-4 w-4" aria-hidden />}
          </Button>
        </div>

        <div className="p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
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
              "flex h-9 w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 text-left text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.99] motion-reduce:transform-none motion-reduce:transition-none",
              activeKey === "home"
                ? "bg-[color:var(--surface-active)] font-medium text-foreground"
                : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_55%,transparent)] hover:text-foreground",
            )}
            onClick={() => navigate("/apps")}
          >
            <Home className="h-4 w-4" aria-hidden />
            Home
          </button>

          <div className="mb-2 mt-5 flex items-center justify-between px-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/75">
              Registered
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {entries.length}
            </span>
          </div>

          {filteredEntries.length ? (
            <div className="space-y-0.5">
              {filteredEntries.map((entry) => {
                const title = entry.kind === "managed"
                  ? entry.app.name
                  : entry.definition.title;
                const selected = entry.key === activeKey;
                const status = entry.kind === "managed" && !entry.definition
                  ? statusLabel(entry.app.buildStatus)
                  : "On this device";
                return (
                  <button
                    key={entry.key}
                    type="button"
                    className={cn(
                      "group motion-list-enter flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-2 text-left transition-[background-color,color,transform] duration-150 active:scale-[0.99] motion-reduce:transform-none motion-reduce:transition-none",
                      selected
                        ? "bg-[color:var(--surface-active)] text-foreground"
                        : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_55%,transparent)] hover:text-foreground",
                    )}
                    onClick={() => navigate(appRoute(entry.key))}
                  >
                    <AppIdentity entry={entry} className="h-7 w-7 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {status}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mx-2 mt-3 rounded-[var(--radius-md)] border border-dashed border-[color:var(--border-soft)] px-3 py-5 text-center">
              <FolderSearch className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {search ? "No matching Apps." : "Create or load your first App."}
              </p>
            </div>
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-end gap-1 overflow-x-auto border-b border-[color:var(--border-soft)] bg-[color:var(--surface-shell)] px-2 pt-2">
          {tabs.map((tab) => {
            const selected = tab.key === activeKey;
            return (
              <div
                key={tab.key}
                className={cn(
                  "group relative flex h-9 min-w-[120px] max-w-[220px] items-center gap-2 rounded-t-[var(--radius-md)] border border-b-0 px-3 text-xs transition-[background-color,border-color,color,transform] duration-200 motion-reduce:transform-none motion-reduce:transition-none",
                  selected
                    ? "translate-y-px border-[color:var(--border-soft)] bg-[color:var(--surface-panel)] text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_48%,transparent)] hover:text-foreground",
                )}
                data-testid={`apps-tab-${tab.key}`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => navigate(tab.key === "home" ? "/apps" : appRoute(tab.key))}
                >
                  {tab.key === "home"
                    ? <Home className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    : <AppWindow className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  <span className="truncate">{tab.title}</span>
                </button>
                {tab.key !== "home" ? (
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-[color:var(--surface-active)] hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                    aria-label={`Close ${tab.title}`}
                    onClick={() => {
                      const index = tabs.findIndex((candidate) => candidate.key === tab.key);
                      const nextTabs = tabs.filter((candidate) => candidate.key !== tab.key);
                      setTabs(nextTabs);
                      if (selected) {
                        const fallback = nextTabs[Math.max(0, index - 1)] ?? nextTabs[0];
                        navigate(fallback?.key === "home" || !fallback
                          ? "/apps"
                          : appRoute(fallback.key));
                      }
                    }}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            );
          })}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="mb-1 h-7 w-7 shrink-0"
            onClick={() => navigate("/apps")}
            aria-label="New App"
            title="New App"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <span className="ml-auto mb-1 hidden items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] px-2.5 py-1 text-[10px] text-muted-foreground lg:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--accent-base)]" />
            Device runtime
          </span>
        </header>

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
    </section>
  );
}
