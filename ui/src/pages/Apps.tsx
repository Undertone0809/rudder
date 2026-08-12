import { agentsApi } from "@/api/agents";
import { appBuilderApi } from "@/api/app-builder";
import { chatsApi } from "@/api/chats";
import { Button } from "@/components/ui/button";
import { WorkspaceTab } from "@/components/workbench/WorkspaceTab";
import { useChatGenerationActions } from "@/context/ChatGenerationContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useToast } from "@/context/ToastContext";
import { useAppRegistry } from "@/hooks/useAppRegistry";
import {
  APP_BUILDER_SCAFFOLD_VERSION,
  appBuilderChatPrefill,
  appBuilderSourceRoot,
} from "@/lib/app-builder";
import { launchManagedApp } from "@/lib/app-builder-launch";
import {
  acknowledgeAppDirectOpen,
  activeKeyFromPath,
  appRoute,
  localBindingKey,
  readAppDirectOpenIntent,
  shouldPreserveAppDirectOpenDuringOrganizationChange,
  subscribeAppDirectOpen,
  type AppEntry,
  type ManagedAppEntry,
} from "@/lib/apps-workspace";
import {
  readDesktopShell,
  type DesktopLocalAppDefinition,
} from "@/lib/desktop-shell";
import {
  localAppFailureHelpPrompt,
  localAppStatusRefetchInterval,
  resolveLocalAppAttestedWebview,
} from "@/lib/local-apps";
import { invalidateMessengerThreadSummaryQueries } from "@/lib/messenger-query-cache";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import type {
  Agent,
  ChatConversation,
  ChatMessage,
  ChatStreamEvent,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowUp,
  Home,
  Loader2,
  MessageSquare,
  Play,
  Plus,
} from "lucide-react";
import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { mergeChatConversationsForStatus, mergeChatMessages } from "./Chat.parts";
import {
  applyChatStreamProgressEvent,
  CHAT_LIST_PREVIEW_LIMIT,
  EMPTY_CHAT_BODY_SHA256,
} from "./Chat.workspace-helpers";

type WorkspaceTab = {
  key: string;
  title: string;
};

function chooseBuilderAgent(agents: Agent[]) {
  const available = agents.filter((agent) => agent.status !== "terminated");
  return available.find((agent) => agent.role === "ceo")
    ?? available.find((agent) => agent.status === "active")
    ?? available[0]
    ?? null;
}

function AppsHome({
  createError,
  createPending,
  onCreate,
}: {
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
              creates and verifies the source, then starts the finished App locally and opens it here.
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

        </div>
      </main>
    </div>
  );
}

function LocalRuntimePane({
  appKey,
  definition,
  managedApp,
  openIntentVersion,
  organizationId,
}: {
  appKey: string;
  definition: DesktopLocalAppDefinition;
  managedApp?: ManagedAppEntry["app"] | null;
  openIntentVersion: number;
  organizationId: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const desktopShell = readDesktopShell();
  const localApps = desktopShell?.localApps;
  const handledOpenIntent = useRef(0);
  const [pendingOpenIntent, setPendingOpenIntent] = useState(0);
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
    mutationFn: () => localApps!.start(definition.id),
    onSuccess: (next) => {
      queryClient.setQueryData(
        queryKeys.localApps.status(definition.localBindingId),
        next,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.localApps.status(definition.localBindingId),
      });
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.localApps.status(definition.localBindingId),
      });
    },
  });
  useEffect(() => {
    if (openIntentVersion <= handledOpenIntent.current) return;
    handledOpenIntent.current = openIntentVersion;
    acknowledgeAppDirectOpen(organizationId, appKey, openIntentVersion);
    setPendingOpenIntent(openIntentVersion);
  }, [appKey, openIntentVersion, organizationId]);
  useEffect(() => {
    if (
      pendingOpenIntent === 0
      || !localApps?.supported
      || !runtimeQuery.isSuccess
    ) {
      return;
    }
    if (runtime?.status === "starting" || runtime?.status === "stopping") return;
    setPendingOpenIntent(0);
    if (runtime?.status === "stopped") runtimeMutation.mutate();
  }, [
    localApps?.supported,
    pendingOpenIntent,
    runtime?.status,
    runtimeMutation,
    runtimeQuery.isSuccess,
  ]);
  const running = runtime?.status === "running";
  const pending = runtimeQuery.isPending
    || runtimeMutation.isPending
    || runtime?.status === "starting"
    || runtime?.status === "stopping";
  const error = runtimeQuery.error ?? targetQuery.error ?? runtimeMutation.error;
  const failed = runtime?.status === "failed" || Boolean(error);
  const readyToOpen = runtime?.status === "stopped"
    && !runtimeMutation.isPending
    && openIntentVersion === 0;
  const openAiHelp = () => {
    const search = new URLSearchParams({
      prefill: localAppFailureHelpPrompt(definition.title),
      localAppRecoveryDraft: crypto.randomUUID(),
    });
    navigate(`/messenger/chat?${search.toString()}`);
  };

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
                {failed
                  ? "The App could not open"
                  : readyToOpen
                    ? definition.title
                  : `Opening ${definition.title}…`}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {failed
                  ? "Rudder stopped the failed process safely. Try opening it again."
                  : readyToOpen
                    ? "Open this App when you are ready."
                  : "Rudder is preparing the App on this device."}
              </p>
              {runtime?.error ? (
                <p className="mt-3 text-sm text-destructive">{runtime.error}</p>
              ) : null}
              {failed && !runtimeMutation.isPending ? (
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      if (running) void targetQuery.refetch();
                      else runtimeMutation.mutate();
                    }}
                    data-testid="apps-retry-app"
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden />
                    Try again
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="apps-ask-ai"
                    onClick={openAiHelp}
                  >
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                    Ask AI for help
                  </Button>
                  {managedApp?.conversationId ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => navigate(`/messenger/chat/${managedApp.conversationId}`)}
                    >
                      Continue in Chat
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {readyToOpen ? (
                <Button
                  type="button"
                  className="mt-6"
                  onClick={() => runtimeMutation.mutate()}
                  data-testid="apps-open-app"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  Open App
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
  const desktopShell = readDesktopShell();
  const desktopAppBuilder = desktopShell?.appBuilder;
  const retryMutation = useMutation({
    mutationFn: async () => {
      if (!desktopShell || !desktopAppBuilder?.supported) {
        throw new Error("This App can open in Rudder Desktop.");
      }
      return launchManagedApp({
        app: entry.app,
        desktopShell,
        expectedStatus: "launch_failed",
      });
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
            {retryMutation.isPending || entry.app.buildStatus === "verified_source_ready" || entry.app.buildStatus === "verifying"
              ? <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden />
              : <AppWindow className="h-6 w-6" aria-hidden />}
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-foreground">
            {entry.app.name}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {entry.app.buildStatus === "launch_failed"
              ? "The source is preserved. Retry opening it or continue in Chat to fix the failure."
              : entry.app.buildStatus === "failed"
                ? "App Builder stopped before verification. Continue in Chat to resume the work."
              : entry.app.buildStatus === "verified_source_ready" || entry.app.buildStatus === "verifying"
                ? "Rudder is verifying the source, starting the local runtime, and opening the App."
                : "App Builder is developing and checking the App. It will open automatically when ready."}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {entry.app.buildStatus === "launch_failed" ? (
              <Button
                type="button"
                disabled={retryMutation.isPending || !desktopAppBuilder?.supported}
                onClick={() => retryMutation.mutate()}
                data-testid="apps-retry-managed-app"
              >
                {retryMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                  : <Play className="h-3.5 w-3.5" aria-hidden />}
                Try opening again
              </Button>
            ) : null}
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
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(
                `/library?directory=${encodeURIComponent(entry.app.sourceRoot)}`,
              )}
            >
              Open source
            </Button>
          </div>
          {retryMutation.error ? (
            <p className="mt-4 text-sm leading-6 text-destructive" role="alert">
              {retryMutation.error instanceof Error
                ? retryMutation.error.message
                : "The App could not be opened."}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function ActiveAppPane({
  entry,
  openIntentVersion,
  organizationId,
}: {
  entry: AppEntry;
  openIntentVersion: number;
  organizationId: string;
}) {
  if (entry.kind === "managed") {
    if (!entry.definition) return <ManagedSetupPane entry={entry} />;
    return (
      <LocalRuntimePane
        key={entry.definition.id}
        appKey={entry.key}
        definition={entry.definition}
        managedApp={entry.app}
        openIntentVersion={openIntentVersion}
        organizationId={organizationId}
      />
    );
  }
  return (
    <LocalRuntimePane
      key={entry.definition.id}
      appKey={entry.key}
      definition={entry.definition}
      openIntentVersion={openIntentVersion}
      organizationId={organizationId}
    />
  );
}

export function Apps() {
  const { selectedOrganizationId } = useOrganization();
  const { pushToast } = useToast();
  const {
    setChatSendInFlight,
    setStreamAbortController,
    setStreamDraftForChat,
  } = useChatGenerationActions();
  const appBuilderStreamOwnersRef = useRef<Record<string, string>>({});
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

  const {
    entries,
    registryReady,
  } = useAppRegistry(true);
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });
  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.key, entry])),
    [entries],
  );
  const activeEntry = entryByKey.get(activeKey) ?? null;
  const openIntentVersion = useSyncExternalStore(
    subscribeAppDirectOpen,
    () => readAppDirectOpenIntent(selectedOrganizationId ?? "", activeKey),
    () => 0,
  );

  useEffect(() => {
    if (previousOrganizationId.current === selectedOrganizationId) return;
    previousOrganizationId.current = selectedOrganizationId;
    setTabs([{ key: "home", title: "Home" }]);
    setFocusedTabKey("home");
    if (!shouldPreserveAppDirectOpenDuringOrganizationChange(
      activeKey,
      openIntentVersion,
    )) {
      navigate("/apps", { replace: true });
    }
  }, [activeKey, navigate, openIntentVersion, selectedOrganizationId]);

  useEffect(() => {
    if (!registryReady) return;
    setTabs((current) => {
      const next = current.filter((tab) => tab.key === "home" || entryByKey.has(tab.key));
      if (next.length === current.length) return current;
      for (const tab of current) {
        if (!next.some((candidate) => candidate.key === tab.key)) {
          tabRefs.current.delete(tab.key);
        }
      }
      return next;
    });
  }, [entryByKey, registryReady]);

  useEffect(() => {
    if (!registryReady) return;
    setFocusedTabKey((current) => {
      if (current === "home" || entryByKey.has(current)) return current;
      return activeKey === "home" || entryByKey.has(activeKey) ? activeKey : "home";
    });
  }, [activeKey, entryByKey, registryReady]);

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
    if (activeKey !== "home" && !activeEntry && registryReady) {
      navigate("/apps", { replace: true });
    }
  }, [
    activeEntry,
    activeKey,
    navigate,
    registryReady,
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
        appBuilderChatPrefill(appName, false, sourceRoot, app.id),
        idea,
      ].join("\n\n");
      const startedAt = new Date();
      const abortController = new AbortController();
      const streamKey = `app-builder:${startedAt.getTime()}:${crypto.randomUUID()}`;
      let streamConversation: ChatConversation | null = null;
      let acknowledged = false;
      const ownsStream = () => Boolean(
        streamConversation
        && appBuilderStreamOwnersRef.current[streamConversation.id] === streamKey,
      );
      const refreshChatCaches = (chatId: string) => Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.chats.detail(selectedOrganizationId, chatId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.chats.messages(selectedOrganizationId, chatId),
        }),
        ...(["active", "all"] as const).flatMap((status) => [
          queryClient.invalidateQueries({
            queryKey: queryKeys.chats.list(selectedOrganizationId, status),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.chats.listPreview(
              selectedOrganizationId,
              status,
              CHAT_LIST_PREVIEW_LIMIT,
            ),
          }),
        ]),
        invalidateMessengerThreadSummaryQueries(queryClient, selectedOrganizationId),
      ]);
      const clearOwnedStreamState = (removeDraft: boolean) => {
        if (!streamConversation || !ownsStream()) return false;
        delete appBuilderStreamOwnersRef.current[streamConversation.id];
        setStreamAbortController(streamConversation.id, null);
        setChatSendInFlight(streamConversation.id, false);
        if (removeDraft) {
          setStreamDraftForChat(
            streamConversation.id,
            (current) => current?.streamKey === streamKey ? null : current,
          );
        }
        return true;
      };
      const acknowledgement = new Promise<ChatConversation>((resolve, reject) => {
        const onEvent = (event: ChatStreamEvent) => {
          if (event.type === "ack") {
            if (!event.conversation || acknowledged) return;
            acknowledged = true;
            streamConversation = event.conversation;
            appBuilderStreamOwnersRef.current[streamConversation.id] = streamKey;
            setStreamAbortController(streamConversation.id, abortController);
            setChatSendInFlight(streamConversation.id, true);
            setStreamDraftForChat(streamConversation.id, {
              chatId: streamConversation.id,
              streamKey,
              userBody: body,
              userCreatedAt: new Date(event.userMessage.createdAt),
              userMessageId: event.userMessage.id,
              chatTurnId: event.userMessage.chatTurnId ?? null,
              turnVariant: event.userMessage.turnVariant ?? 0,
              editedFromCreatedAt: null,
              body: "",
              generationId: event.generationId ?? null,
              attemptEpoch: event.attemptEpoch ?? null,
              lastCommittedRenderSeq: event.generationSeq ?? 0,
              renderedBodyHash: event.bodyHash ?? EMPTY_CHAT_BODY_SHA256,
              state: "streaming",
              createdAt: startedAt,
              transcript: [],
              replyingAgentId: streamConversation.chatRuntime.runtimeAgentId
                ?? streamConversation.preferredAgentId
                ?? null,
            });
            queryClient.setQueryData(
              queryKeys.chats.detail(selectedOrganizationId, streamConversation.id),
              streamConversation,
            );
            queryClient.setQueryData<ChatMessage[]>(
              queryKeys.chats.messages(selectedOrganizationId, streamConversation.id),
              (current) => mergeChatMessages(current ?? [], [event.userMessage]),
            );
            for (const status of ["active", "all"] as const) {
              queryClient.setQueryData<ChatConversation[]>(
                queryKeys.chats.list(selectedOrganizationId, status),
                (current) => mergeChatConversationsForStatus(current ?? [], streamConversation!, status),
              );
              queryClient.setQueryData<ChatConversation[]>(
                queryKeys.chats.listPreview(
                  selectedOrganizationId,
                  status,
                  CHAT_LIST_PREVIEW_LIMIT,
                ),
                (current) => mergeChatConversationsForStatus(current ?? [], streamConversation!, status),
              );
            }
            navigate(`/messenger/chat/${streamConversation.id}`);
            resolve(streamConversation);
            return;
          }

          if (!streamConversation) return;
          if (
            event.type === "assistant_delta"
            || event.type === "assistant_state"
            || event.type === "transcript_entry"
          ) {
            setStreamDraftForChat(
              streamConversation.id,
              (current) => applyChatStreamProgressEvent(current, streamKey, event),
            );
            return;
          }
          if (event.type === "final") {
            queryClient.setQueryData<ChatMessage[]>(
              queryKeys.chats.messages(selectedOrganizationId, streamConversation.id),
              (current) => mergeChatMessages(current ?? [], event.messages),
            );
            setStreamDraftForChat(
              streamConversation.id,
              (current) => current?.streamKey === streamKey ? null : current,
            );
            void refreshChatCaches(streamConversation.id).catch(() => undefined);
            return;
          }
          if (event.type === "error") {
            setStreamDraftForChat(
              streamConversation.id,
              (current) => current?.streamKey === streamKey
                ? { ...current, state: "failed" }
                : current,
            );
            throw new Error(event.error);
          }
        };
        void chatsApi.sendFirstMessageStream(selectedOrganizationId, body, {
          preferredAgentId: agent.id,
          issueCreationMode: "manual_approval",
          planMode: false,
          contextLinks: [],
          signal: abortController.signal,
          onEvent,
        }).then(() => {
          if (!acknowledged) {
            reject(new Error("The App Builder Chat did not start."));
            return;
          }
          if (streamConversation && ownsStream()) {
            clearOwnedStreamState(false);
            void refreshChatCaches(streamConversation.id).catch(() => undefined);
          }
        }).catch((error) => {
          if (!acknowledged) {
            reject(error);
            return;
          }
          const isAbort = error instanceof DOMException
            ? error.name === "AbortError"
            : error instanceof Error && error.name === "AbortError";
          if (streamConversation && clearOwnedStreamState(true)) {
            void refreshChatCaches(streamConversation.id).catch(() => undefined);
            if (!isAbort) {
              void appBuilderApi.updateBuild(selectedOrganizationId, app.id, {
                status: "failed",
                expectedStatus: "preparing",
              }).catch(() => undefined);
            }
          }
          if (!isAbort) {
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
          expectedStatus: "preparing",
        }).catch(() => undefined);
        pushToast({
          title: "The App Chat started, but registration needs attention",
          body: "The App remains visible in Apps. Continue in this Chat while Rudder reconnects.",
          tone: "error",
        });
      }
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
            createError={createAppMutation.error}
            createPending={createAppMutation.isPending}
            onCreate={(idea) => createAppMutation.mutate(idea)}
          />
        ) : selectedOrganizationId ? (
          <ActiveAppPane
            entry={activeEntry}
            openIntentVersion={openIntentVersion}
            organizationId={selectedOrganizationId}
          />
        ) : (
          <AppsHome
            createError={createAppMutation.error}
            createPending={createAppMutation.isPending}
            onCreate={(idea) => createAppMutation.mutate(idea)}
          />
        )}
      </div>
    </section>
  );
}
