import { authApi } from "@/api/auth";
import { useOptionalOrganization } from "@/context/OrganizationContext";
import { readDesktopShell } from "@/lib/desktop-shell";
import { getKeyboardShortcutPlatform } from "@/lib/keyboard-shortcuts";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import {
  sidePanelCanonicalTargetKey,
  sidePanelFullPageHref,
  sidePanelTargetKey,
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type SidePanelContextState = {
  activeKey: string | null;
  hasPanelState: boolean;
  open: boolean;
  tabs: SidePanelTarget[];
};

export type SidePanelContextOwner = {
  contextKey: string;
  organizationId: string | null;
  principalId: string | null;
};

type SidePanelContextScope = SidePanelContextOwner;

export type SidePanelOpenResult =
  | { admitted: true }
  | { admitted: false; reason: "browser_capacity" };

export type SidePanelOpenOptions = {
  allowNewBrowserGuest?: boolean;
};

export type DisplayedSidePanelContextHold = {
  organizationId: string;
  contextKey: string;
};

export type SidePanelDetachResult =
  | {
    detached: true;
    revision: number;
    target: SidePanelTarget;
  }
  | {
    detached: false;
    reason: "not_found" | "revision_mismatch";
    revision: number | null;
  };

export type SidePanelBrowserResetDecision = "preserve" | "remove";
export type SidePanelBrowserResetHandler = (
  owner: SidePanelContextOwner,
  target: Extract<SidePanelTarget, { kind: "browser" }>,
) => SidePanelBrowserResetDecision;

type SidePanelContextValue = {
  activeKey: string | null;
  principalId: string | null;
  open: boolean;
  tabs: SidePanelTarget[];
  contextKey: string;
  ownerOrganizationId: string | null;
  displayedContextHold: DisplayedSidePanelContextHold | null;
  clearCurrentContext: () => void;
  clearDisplayedContextHold: () => void;
  detachTargetForContext: (
    contextKey: string | null,
    exactKey: string,
    expectedRevision: number,
    organizationId?: string | null,
    principalId?: string | null,
  ) => SidePanelDetachResult;
  getTargetRevisionForContext: (
    contextKey: string | null,
    exactKey: string,
    organizationId?: string | null,
    principalId?: string | null,
  ) => number | null;
  hidePanel: () => void;
  holdDisplayedContext: (organizationId: string, contextKey?: string | null) => boolean;
  openTarget: (target: SidePanelTarget, options?: SidePanelOpenOptions) => SidePanelOpenResult;
  openTargetInNewTab: (target: SidePanelTarget, options?: SidePanelOpenOptions) => SidePanelOpenResult;
  openTargetForContext: (
    contextKey: string | null,
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
    organizationId?: string | null,
    principalId?: string | null,
  ) => SidePanelOpenResult;
  showPanel: () => void;
  showPanelForContext: (
    contextKey: string | null,
    organizationId?: string | null,
    principalId?: string | null,
  ) => void;
  openEmpty: () => void;
  closePanel: () => void;
  closeTarget: (key: string) => void;
  registerCloseRequestHandler: (handler: (target: SidePanelTarget) => void | Promise<void>) => () => void;
  registerBrowserResetHandler: (handler: SidePanelBrowserResetHandler) => () => void;
  registerBeforeOpen: (handler: () => void) => () => void;
  replaceTarget: (key: string, target: SidePanelTarget) => void;
  replaceTargetForContext: (
    contextKey: string | null,
    key: string,
    target: SidePanelTarget,
    organizationId?: string | null,
    principalId?: string | null,
  ) => boolean;
  reorderTarget: (key: string, targetKey: string, position: "before" | "after") => void;
  setActiveKey: (key: string | null) => void;
  setContextKey: (contextKey: string | null, organizationId?: string | null) => void;
};

const SidePanelContext = createContext<SidePanelContextValue | null>(null);
const DEFAULT_SIDE_PANEL_CONTEXT_KEY = "global";
export const MAX_BROWSER_TABS_PER_CONTEXT = 8;
const SIDE_CHAT_PANEL_STATE_STORAGE_KEY = "rudder:side-chat-panel-state:v1";

type SideChatPanelStateSnapshot = Pick<SidePanelContextState, "activeKey" | "open" | "tabs">;

function sideChatPanelStateStorageKey(
  principalId: string | null,
  organizationId: string | null,
  contextKey: string,
) {
  const principalScope = principalId === null ? "anonymous" : `user-${encodeURIComponent(principalId)}`;
  const organizationScope = organizationId === null ? "no-organization" : `org-${encodeURIComponent(organizationId)}`;
  return `${SIDE_CHAT_PANEL_STATE_STORAGE_KEY}:${principalScope}:${organizationScope}:${encodeURIComponent(contextKey)}`;
}

function sideChatPanelStateStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parsePersistedSideChatTarget(value: unknown): Extract<SidePanelTarget, { kind: "side_chat" }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<Extract<SidePanelTarget, { kind: "side_chat" }>>;
  if (
    candidate.kind !== "side_chat"
    || typeof candidate.sourceConversationId !== "string"
    || !candidate.sourceConversationId.trim()
    || typeof candidate.clientMutationId !== "string"
    || !candidate.clientMutationId.trim()
    || (candidate.sourceMessageId !== null && typeof candidate.sourceMessageId !== "string")
    || (candidate.conversationId !== null && typeof candidate.conversationId !== "string")
  ) return null;
  return {
    kind: "side_chat",
    sourceConversationId: candidate.sourceConversationId,
    sourceMessageId: candidate.sourceMessageId,
    sourcePreview: null,
    ...(Array.isArray(candidate.inlineAnnotations)
      ? { inlineAnnotations: candidate.inlineAnnotations }
      : {}),
    conversationId: candidate.conversationId,
    clientMutationId: candidate.clientMutationId,
    label: typeof candidate.label === "string" ? candidate.label : "Side Chat",
  };
}

function readPersistedSideChatPanelState(
  principalId: string | null,
  organizationId: string | null,
  contextKey: string,
): SidePanelContextState | null {
  try {
    const raw = sideChatPanelStateStorage()?.getItem(
      sideChatPanelStateStorageKey(principalId, organizationId, contextKey),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SideChatPanelStateSnapshot> | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs
      .map(parsePersistedSideChatTarget)
      .filter((target): target is Extract<SidePanelTarget, { kind: "side_chat" }> => target !== null);
    if (tabs.length === 0) return null;
    const activeTab = tabs.find((target) => sidePanelTargetKey(target) === parsed.activeKey) ?? tabs[0]!;
    return {
      activeKey: sidePanelTargetKey(activeTab),
      hasPanelState: true,
      open: parsed.open === true && sidePanelTargetKey(activeTab) === parsed.activeKey,
      tabs,
    };
  } catch {
    return null;
  }
}

function persistSideChatPanelState(
  principalId: string | null,
  organizationId: string | null,
  contextKey: string,
  state: SidePanelContextState,
) {
  const storage = sideChatPanelStateStorage();
  if (!storage) return;
  const tabs = state.tabs.filter((target): target is Extract<SidePanelTarget, { kind: "side_chat" }> => (
    target.kind === "side_chat"
  )).map((target) => ({ ...target, sourcePreview: null }));
  const key = sideChatPanelStateStorageKey(principalId, organizationId, contextKey);
  if (tabs.length === 0) {
    storage.removeItem(key);
    return;
  }
  const activeSideChat = tabs.find((target) => sidePanelTargetKey(target) === state.activeKey) ?? tabs[0]!;
  storage.setItem(key, JSON.stringify({
    activeKey: sidePanelTargetKey(activeSideChat),
    open: state.open && sidePanelTargetKey(activeSideChat) === state.activeKey,
    tabs,
  } satisfies SideChatPanelStateSnapshot));
}

function normalizeContextKey(contextKey: string | null | undefined): string {
  return contextKey?.trim() || DEFAULT_SIDE_PANEL_CONTEXT_KEY;
}

function sidePanelContextScopeKey(scope: SidePanelContextScope): string {
  return JSON.stringify([
    scope.principalId,
    scope.organizationId,
    normalizeContextKey(scope.contextKey),
  ]);
}

function sameSidePanelOwner(left: SidePanelContextScope, right: SidePanelContextScope): boolean {
  return left.principalId === right.principalId
    && left.organizationId === right.organizationId;
}

function sidePanelContextScopeFromKey(scopeKey: string): SidePanelContextScope | null {
  try {
    const parsed = JSON.parse(scopeKey) as unknown;
    if (
      Array.isArray(parsed)
      && (typeof parsed[0] === "string" || parsed[0] === null)
      && (typeof parsed[1] === "string" || parsed[1] === null)
      && typeof parsed[2] === "string"
    ) {
      return {
        principalId: parsed[0],
        organizationId: parsed[1],
        contextKey: parsed[2],
      };
    }
  } catch {
    return null;
  }
  return null;
}

function contextStatesForPrincipalOrganization(
  states: Record<string, SidePanelContextState>,
  principalId: string | null,
  organizationId: string | null,
): Record<string, SidePanelContextState> {
  return Object.fromEntries(Object.entries(states).filter(([scopeKey]) => {
    try {
      const parsed = JSON.parse(scopeKey) as unknown;
      return Array.isArray(parsed)
        && parsed[0] === principalId
        && parsed[1] === organizationId;
    } catch {
      return false;
    }
  }));
}

function readOrCreateContextState(
  states: Record<string, SidePanelContextState>,
  scope: SidePanelContextScope,
): SidePanelContextState {
  const key = sidePanelContextScopeKey(scope);
  const existing = states[key];
  if (existing) return existing;
  const restored = readPersistedSideChatPanelState(
    scope.principalId,
    scope.organizationId,
    normalizeContextKey(scope.contextKey),
  ) ?? emptyContextState();
  states[key] = restored;
  return restored;
}

function mobileSidePanelTargetHref(target: SidePanelTarget): string {
  const href = sidePanelFullPageHref(target);
  if (href) return href;
  if (target.kind === "issue_proposal") {
    return `/messenger/chat/${target.conversationId}?messageId=${encodeURIComponent(target.messageId)}`;
  }
  if (target.kind === "subagents") return `/messenger/chat/${target.conversationId}`;
  if (target.kind === "subagent") {
    return target.conversationId
      ? `/messenger/chat/${target.conversationId}${target.sourceMessageId ? `?messageId=${encodeURIComponent(target.sourceMessageId)}` : ""}`
      : "/messenger/chat";
  }
  if (target.kind === "goal_chat") return target.conversationId
    ? `/messenger/chat/${target.conversationId}`
    : `/goals/${target.goalId}`;
  if (target.kind === "local_file") return "/library";
  if (target.kind === "local_apps" || target.kind === "local_app") return "/apps";
  return "/messenger/chat";
}

function openSidePanelTargetOnMobile(target: SidePanelTarget): boolean {
  if (typeof window === "undefined" || window.innerWidth >= 768) return false;
  if (
    target.kind === "side_chat"
    || target.kind === "goal_chat"
    || target.kind === "run_debug_chat"
    || target.kind === "local_file"
  ) return false;
  const href = mobileSidePanelTargetHref(target);
  if (/^https?:\/\//i.test(href) && !href.startsWith(window.location.origin)) {
    window.location.assign(href);
    return true;
  }
  const organizationPrefix = extractOrganizationPrefixFromPath(window.location.pathname);
  const nextPath = applyOrganizationPrefix(href, organizationPrefix);
  window.history.pushState({}, "", nextPath);
  window.dispatchEvent(new PopStateEvent("popstate"));
  return true;
}

function emptyContextState(): SidePanelContextState {
  return { activeKey: null, hasPanelState: false, open: false, tabs: [] };
}

function contextHasPanelState(state: SidePanelContextState | undefined) {
  return Boolean(state && (state.hasPanelState || state.tabs.length > 0 || state.activeKey !== null));
}

function belongsToMainWorkbenchSurface(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(
    "[data-testid='messenger-main-workbench'],"
    + "[data-testid='live-surface-runtime-host'][data-owner-id^='main:']",
  ));
}

function newViewInstanceId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function targetWithViewInstance(
  tabs: SidePanelTarget[],
  target: SidePanelTarget,
  forceNew: boolean,
): SidePanelTarget {
  if (!sidePanelTargetSupportsSavedView(target)) return target;
  if (target.kind === "browser") {
    return { ...target, viewInstanceId: target.viewInstanceId ?? target.tabId };
  }
  if (!forceNew && target.viewInstanceId) return target;
  if (!forceNew) {
    const canonicalKey = sidePanelCanonicalTargetKey(target);
    const existing = tabs.find((candidate) => (
      sidePanelTargetSupportsSavedView(candidate)
      && sidePanelCanonicalTargetKey(candidate) === canonicalKey
    ));
    if (existing && existing.kind !== "browser" && "viewInstanceId" in existing && existing.viewInstanceId) {
      return { ...target, viewInstanceId: existing.viewInstanceId } as SidePanelTarget;
    }
  }
  return { ...target, viewInstanceId: newViewInstanceId() } as SidePanelTarget;
}

function browserTargetForPhysicalReuse(
  target: Extract<SidePanelTarget, { kind: "browser" }>,
  physicalTab: Extract<SidePanelTarget, { kind: "browser" }>,
) {
  return {
    ...target,
    tabId: physicalTab.tabId,
    viewInstanceId: physicalTab.viewInstanceId ?? physicalTab.tabId,
    savedViewRecovery: physicalTab.savedViewRecovery ?? target.savedViewRecovery,
  } satisfies Extract<SidePanelTarget, { kind: "browser" }>;
}

type SidePanelTargetUpsertResult = {
  activeKey: string | null;
  tabs: SidePanelTarget[];
  openResult: SidePanelOpenResult;
};

function upsertSidePanelTarget(
  tabs: SidePanelTarget[],
  activeKey: string | null,
  target: SidePanelTarget,
  allowNewBrowserGuest = true,
): SidePanelTargetUpsertResult {
  const nextKey = sidePanelTargetKey(target);
  const matchingBrowser = target.kind === "browser" && target.dedupeKey
    ? tabs.find((candidate) => candidate.kind === "browser" && candidate.dedupeKey === target.dedupeKey)
    : undefined;
  if (target.kind === "browser" && matchingBrowser?.kind === "browser") {
    const matchingKey = sidePanelTargetKey(matchingBrowser);
    const replacement = browserTargetForPhysicalReuse(target, matchingBrowser);
    return {
      activeKey: matchingKey,
      tabs: tabs.map((candidate) => (sidePanelTargetKey(candidate) === matchingKey ? replacement : candidate)),
      openResult: { admitted: true },
    };
  }
  const matchingTarget = tabs.find((candidate) => sidePanelTargetKey(candidate) === nextKey);
  if (matchingTarget) {
    const replacement = target.kind === "browser" && matchingTarget.kind === "browser"
      ? browserTargetForPhysicalReuse(target, matchingTarget)
      : target;
    return {
      activeKey: nextKey,
      tabs: tabs.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? replacement : candidate)),
      openResult: { admitted: true },
    };
  }
  const nextTabs = [...tabs, target];
  if (target.kind !== "browser") {
    return { activeKey: nextKey, tabs: nextTabs, openResult: { admitted: true } };
  }
  const browserTabCount = tabs.filter((candidate) => candidate.kind === "browser").length;
  if (
    allowNewBrowserGuest
    && browserTabCount < MAX_BROWSER_TABS_PER_CONTEXT
  ) {
    return { activeKey: nextKey, tabs: nextTabs, openResult: { admitted: true } };
  }

  return {
    activeKey,
    tabs,
    openResult: { admitted: false, reason: "browser_capacity" },
  };
}

function browserViewInstanceId(
  target: Extract<SidePanelTarget, { kind: "browser" }>,
) {
  return target.viewInstanceId?.trim() || target.tabId.trim();
}

function sidePanelBrowserInstances(
  states: Record<string, SidePanelContextState>,
  principalId?: string | null,
  organizationId?: string | null,
) {
  const instances = new Set<string>();
  const scopedStates = principalId === undefined
    ? states
    : contextStatesForPrincipalOrganization(states, principalId, organizationId ?? null);
  for (const state of Object.values(scopedStates)) {
    for (const target of state.tabs) {
      if (target.kind === "browser") {
        instances.add(browserViewInstanceId(target));
      }
    }
  }
  return instances;
}

function withoutBrowserTargets(
  state: SidePanelContextState,
  owner: SidePanelContextOwner,
  resetHandler: SidePanelBrowserResetHandler | null,
): SidePanelContextState {
  const activeIndex = state.activeKey
    ? state.tabs.findIndex((target) => sidePanelTargetKey(target) === state.activeKey)
    : -1;
  const tabs = state.tabs.filter((target) => (
    target.kind !== "browser"
    || resetHandler?.(owner, target) === "preserve"
  ));
  if (tabs.length === state.tabs.length) return state;
  const activeStillExists = state.activeKey !== null
    && tabs.some((target) => sidePanelTargetKey(target) === state.activeKey);
  const fallback = tabs[Math.min(Math.max(activeIndex, 0), tabs.length - 1)] ?? tabs.at(-1) ?? null;
  return {
    ...state,
    activeKey: state.activeKey === null
      ? null
      : activeStillExists
        ? state.activeKey
        : fallback
          ? sidePanelTargetKey(fallback)
          : null,
    tabs,
  };
}

function PrincipalScopedSidePanelProvider({
  children,
  principalId,
  organizationId,
}: {
  children: ReactNode;
  principalId: string | null;
  organizationId: string | null;
}) {
  const initialScope = {
    principalId,
    organizationId,
    contextKey: DEFAULT_SIDE_PANEL_CONTEXT_KEY,
  } satisfies SidePanelContextScope;
  const contextStatesRef = useRef<Record<string, SidePanelContextState>>({
    [sidePanelContextScopeKey(initialScope)]: emptyContextState(),
  });
  const targetRevisionsRef = useRef<Record<string, Record<string, number>>>({
    [sidePanelContextScopeKey(initialScope)]: {},
  });
  const currentScopeRef = useRef<SidePanelContextScope>(initialScope);
  const currentContextKeyRef = useRef(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [contextKey, setCurrentContextKey] = useState(DEFAULT_SIDE_PANEL_CONTEXT_KEY);
  const [currentContextState, setCurrentContextState] = useState<SidePanelContextState>(() => emptyContextState());
  const [displayedContextHold, setDisplayedContextHold] = useState<DisplayedSidePanelContextHold | null>(null);
  const [open, setOpen] = useState(false);
  const principalIdRef = useRef(principalId);
  if (principalIdRef.current !== principalId) {
    principalIdRef.current = principalId;
    const nextScope = {
      principalId,
      organizationId,
      contextKey: currentContextKeyRef.current,
    } satisfies SidePanelContextScope;
    currentScopeRef.current = nextScope;
    const nextScopeKey = sidePanelContextScopeKey(nextScope);
    const nextState = readOrCreateContextState(contextStatesRef.current, nextScope);
    contextStatesRef.current = {
      ...contextStatesRef.current,
      [nextScopeKey]: nextState,
    };
    targetRevisionsRef.current = {
      ...targetRevisionsRef.current,
      [nextScopeKey]: targetRevisionsRef.current[nextScopeKey] ?? {},
    };
    setCurrentContextState(nextState);
    setDisplayedContextHold(null);
    setOpen(contextHasPanelState(nextState) && nextState.open);
  }
  const activeScope = currentScopeRef.current;
  const openRef = useRef(open);
  openRef.current = open;
  const closeRequestHandlerRef = useRef<((target: SidePanelTarget) => void | Promise<void>) | null>(null);
  const browserResetHandlerRef = useRef<SidePanelBrowserResetHandler | null>(null);
  const beforeOpenHandlersRef = useRef(new Set<() => void>());

  const writeContextState = useCallback((
    key: string,
    updater: (state: SidePanelContextState) => SidePanelContextState,
    requestedScope?: SidePanelContextScope,
  ) => {
    const normalizedKey = normalizeContextKey(key);
    const scope = requestedScope ?? {
      ...activeScope,
      contextKey: normalizedKey,
    };
    const scopedKey = sidePanelContextScopeKey(scope);
    const current = readOrCreateContextState(contextStatesRef.current, scope);
    const next = updater(current);
    if (next !== current) {
      const currentTargets = new Map(
        current.tabs.map((target) => [sidePanelTargetKey(target), target] as const),
      );
      const currentRevisions = targetRevisionsRef.current[scopedKey] ?? {};
      const nextRevisions = { ...currentRevisions };
      for (const target of next.tabs) {
        const targetKey = sidePanelTargetKey(target);
        const previousTarget = currentTargets.get(targetKey);
        const previousRevision = currentRevisions[targetKey] ?? 0;
        nextRevisions[targetKey] = previousTarget
          ? previousTarget !== target
            ? previousRevision + 1
            : previousRevision
          : Object.hasOwn(currentRevisions, targetKey)
            ? previousRevision + 1
            : 0;
      }
      targetRevisionsRef.current = {
        ...targetRevisionsRef.current,
        [scopedKey]: nextRevisions,
      };
    }
    contextStatesRef.current = {
      ...contextStatesRef.current,
      [scopedKey]: next,
    };
    try {
      persistSideChatPanelState(scope.principalId, scope.organizationId, normalizedKey, next);
    } catch {
      // Side Chat state still works for this renderer session when storage is unavailable.
    }
    if (scopedKey === sidePanelContextScopeKey(currentScopeRef.current)) {
      setCurrentContextState(next);
    }
    return next;
  }, [activeScope]);

  const notifyBeforeOpen = useCallback(() => {
    if (openRef.current) return;
    for (const handler of beforeOpenHandlersRef.current) handler();
  }, []);

  const registerBeforeOpen = useCallback((handler: () => void) => {
    beforeOpenHandlersRef.current.add(handler);
    return () => {
      beforeOpenHandlersRef.current.delete(handler);
    };
  }, []);

  const setContextKey = useCallback((
    nextContextKey: string | null,
    requestedOrganizationId?: string | null,
  ) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const nextScope: SidePanelContextScope = {
      principalId,
      organizationId: requestedOrganizationId === undefined
        ? organizationId
        : requestedOrganizationId,
      contextKey: normalizedKey,
    };
    if (sidePanelContextScopeKey(currentScopeRef.current) === sidePanelContextScopeKey(nextScope)) return;
    const nextState = readOrCreateContextState(contextStatesRef.current, nextScope);
    if (!openRef.current && contextHasPanelState(nextState) && nextState.open) notifyBeforeOpen();
    currentScopeRef.current = nextScope;
    currentContextKeyRef.current = normalizedKey;
    setCurrentContextState(nextState);
    setOpen(contextHasPanelState(nextState) && nextState.open);
    setCurrentContextKey((previousKey) => (previousKey === normalizedKey ? previousKey : normalizedKey));
  }, [notifyBeforeOpen, organizationId, principalId]);

  const openTarget = useCallback((
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
  ): SidePanelOpenResult => {
    if (openSidePanelTargetOnMobile(target)) return { admitted: true };
    const scope = { ...activeScope, contextKey };
    const isCurrentScope = sidePanelContextScopeKey(scope)
      === sidePanelContextScopeKey(currentScopeRef.current);
    if (isCurrentScope) notifyBeforeOpen();
    let openResult: SidePanelOpenResult = { admitted: true };
    writeContextState(contextKey, (current) => {
      const sideBrowserInstances = sidePanelBrowserInstances(
        contextStatesRef.current,
        activeScope.principalId,
        activeScope.organizationId,
      );
      const allowNewBrowserGuest = target.kind !== "browser"
        || sideBrowserInstances.has(browserViewInstanceId(target))
        || (
          options?.allowNewBrowserGuest !== false
          && sideBrowserInstances.size < MAX_BROWSER_TABS_PER_CONTEXT
        );
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, false),
        allowNewBrowserGuest,
      );
      openResult = result.openResult;
      return {
        activeKey: result.activeKey,
        hasPanelState: true,
        open: true,
        tabs: result.tabs,
      };
    }, scope);
    if (isCurrentScope) setOpen(true);
    return openResult;
  }, [activeScope, contextKey, notifyBeforeOpen, writeContextState]);

  const openTargetInNewTab = useCallback((
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
  ): SidePanelOpenResult => {
    if (openSidePanelTargetOnMobile(target)) return { admitted: true };
    const scope = { ...activeScope, contextKey };
    const isCurrentScope = sidePanelContextScopeKey(scope)
      === sidePanelContextScopeKey(currentScopeRef.current);
    if (isCurrentScope) notifyBeforeOpen();
    let openResult: SidePanelOpenResult = { admitted: true };
    writeContextState(contextKey, (current) => {
      const sideBrowserInstances = sidePanelBrowserInstances(
        contextStatesRef.current,
        activeScope.principalId,
        activeScope.organizationId,
      );
      const allowNewBrowserGuest = target.kind !== "browser"
        || (
          options?.allowNewBrowserGuest !== false
          && sideBrowserInstances.size < MAX_BROWSER_TABS_PER_CONTEXT
        );
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, true),
        allowNewBrowserGuest,
      );
      openResult = result.openResult;
      return {
        activeKey: result.activeKey,
        hasPanelState: true,
        open: true,
        tabs: result.tabs,
      };
    }, scope);
    if (isCurrentScope) setOpen(true);
    return openResult;
  }, [activeScope, contextKey, notifyBeforeOpen, writeContextState]);

  const openTargetForContext = useCallback((
    nextContextKey: string | null,
    target: SidePanelTarget,
    options?: SidePanelOpenOptions,
    requestedOrganizationId?: string | null,
    requestedPrincipalId?: string | null,
  ): SidePanelOpenResult => {
    if (openSidePanelTargetOnMobile(target)) return { admitted: true };
    const normalizedKey = normalizeContextKey(nextContextKey);
    const scope: SidePanelContextScope = {
      ...activeScope,
      principalId: requestedPrincipalId === undefined
        ? activeScope.principalId
        : requestedPrincipalId,
      organizationId: requestedOrganizationId === undefined
        ? activeScope.organizationId
        : requestedOrganizationId,
      contextKey: normalizedKey,
    };
    const isCurrentScope = sidePanelContextScopeKey(scope)
      === sidePanelContextScopeKey(currentScopeRef.current);
    if (isCurrentScope) notifyBeforeOpen();
    let openResult: SidePanelOpenResult = { admitted: true };
    const nextState = writeContextState(normalizedKey, (current) => {
      const sideBrowserInstances = sidePanelBrowserInstances(
        contextStatesRef.current,
        scope.principalId,
        scope.organizationId,
      );
      const allowNewBrowserGuest = target.kind !== "browser"
        || sideBrowserInstances.has(browserViewInstanceId(target))
        || (
          options?.allowNewBrowserGuest !== false
          && sideBrowserInstances.size < MAX_BROWSER_TABS_PER_CONTEXT
        );
      const result = upsertSidePanelTarget(
        current.tabs,
        current.activeKey,
        targetWithViewInstance(current.tabs, target, false),
        allowNewBrowserGuest,
      );
      openResult = result.openResult;
      return {
        activeKey: result.activeKey,
        hasPanelState: true,
        open: true,
        tabs: result.tabs,
      };
    }, scope);
    if (sidePanelContextScopeKey(scope) === sidePanelContextScopeKey(currentScopeRef.current)) {
      setCurrentContextState(nextState);
      setOpen(true);
    }
    return openResult;
  }, [activeScope, notifyBeforeOpen, writeContextState]);

  const showPanel = useCallback(() => {
    if (sidePanelContextScopeKey(activeScope) !== sidePanelContextScopeKey(currentScopeRef.current)) return;
    notifyBeforeOpen();
    writeContextState(contextKey, (current) => ({ ...current, hasPanelState: true, open: true }), activeScope);
    setOpen(true);
  }, [activeScope, contextKey, notifyBeforeOpen, writeContextState]);

  const showPanelForContext = useCallback((
    nextContextKey: string | null,
    requestedOrganizationId?: string | null,
    requestedPrincipalId?: string | null,
  ) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const scope: SidePanelContextScope = {
      principalId: requestedPrincipalId === undefined ? activeScope.principalId : requestedPrincipalId,
      organizationId: requestedOrganizationId === undefined
        ? activeScope.organizationId
        : requestedOrganizationId,
      contextKey: normalizedKey,
    };
    if (!sameSidePanelOwner(scope, currentScopeRef.current)) return;
    notifyBeforeOpen();
    const nextState = writeContextState(
      normalizedKey,
      (current) => ({ ...current, hasPanelState: true, open: true }),
      scope,
    );
    currentScopeRef.current = scope;
    currentContextKeyRef.current = normalizedKey;
    setCurrentContextKey(normalizedKey);
    setCurrentContextState(nextState);
    setOpen(true);
  }, [activeScope, notifyBeforeOpen, writeContextState]);

  const openEmpty = useCallback(() => {
    if (sidePanelContextScopeKey(activeScope) !== sidePanelContextScopeKey(currentScopeRef.current)) return;
    notifyBeforeOpen();
    setOpen(true);
    writeContextState(contextKey, (current) => ({ ...current, activeKey: null, hasPanelState: true, open: true }), activeScope);
  }, [activeScope, contextKey, notifyBeforeOpen, writeContextState]);

  const hidePanel = useCallback(() => {
    if (sidePanelContextScopeKey(activeScope) !== sidePanelContextScopeKey(currentScopeRef.current)) return;
    setDisplayedContextHold(null);
    writeContextState(contextKey, (current) => (
      contextHasPanelState(current)
        ? { ...current, open: false }
        : current
    ), activeScope);
    setOpen(false);
  }, [activeScope, contextKey, writeContextState]);

  const clearCurrentContext = useCallback(() => {
    if (sidePanelContextScopeKey(activeScope) !== sidePanelContextScopeKey(currentScopeRef.current)) return;
    setDisplayedContextHold(null);
    writeContextState(contextKey, () => emptyContextState(), activeScope);
    setOpen(false);
  }, [activeScope, contextKey, writeContextState]);

  const closePanel = hidePanel;

  const clearDisplayedContextHold = useCallback(() => {
    setDisplayedContextHold(null);
  }, []);

  const holdDisplayedContext = useCallback((
    organizationId: string,
    nextContextKey: string | null = currentContextKeyRef.current,
  ) => {
    const normalizedOrganizationId = organizationId.trim();
    const normalizedContextKey = normalizeContextKey(nextContextKey);
    if (
      !normalizedOrganizationId
      || (!normalizedContextKey.startsWith("chat:") && !normalizedContextKey.startsWith("issue:"))
    ) {
      return false;
    }
    setDisplayedContextHold({
      organizationId: normalizedOrganizationId,
      contextKey: normalizedContextKey,
    });
    return true;
  }, []);

  const getTargetRevisionForContext = useCallback((
    nextContextKey: string | null,
    exactKey: string,
    requestedOrganizationId?: string | null,
    requestedPrincipalId?: string | null,
  ) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const scope: SidePanelContextScope = {
      ...activeScope,
      principalId: requestedPrincipalId === undefined
        ? activeScope.principalId
        : requestedPrincipalId,
      organizationId: requestedOrganizationId === undefined
        ? activeScope.organizationId
        : requestedOrganizationId,
      contextKey: normalizedKey,
    };
    const scopedKey = sidePanelContextScopeKey(scope);
    const targetExists = readOrCreateContextState(contextStatesRef.current, scope).tabs
      .some((target) => sidePanelTargetKey(target) === exactKey);
    if (!targetExists) return null;
    return targetRevisionsRef.current[scopedKey]?.[exactKey] ?? 0;
  }, [activeScope]);

  const detachTargetForContext = useCallback((
    nextContextKey: string | null,
    exactKey: string,
    expectedRevision: number,
    requestedOrganizationId?: string | null,
    requestedPrincipalId?: string | null,
  ): SidePanelDetachResult => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const scope: SidePanelContextScope = {
      ...activeScope,
      principalId: requestedPrincipalId === undefined
        ? activeScope.principalId
        : requestedPrincipalId,
      organizationId: requestedOrganizationId === undefined
        ? activeScope.organizationId
        : requestedOrganizationId,
      contextKey: normalizedKey,
    };
    const scopedKey = sidePanelContextScopeKey(scope);
    const current = readOrCreateContextState(contextStatesRef.current, scope);
    const detachingIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === exactKey);
    if (detachingIndex < 0) {
      return { detached: false, reason: "not_found", revision: null };
    }
    const revision = targetRevisionsRef.current[scopedKey]?.[exactKey] ?? 0;
    if (expectedRevision !== revision) {
      return { detached: false, reason: "revision_mismatch", revision };
    }
    const target = current.tabs[detachingIndex]!;
    const nextState = writeContextState(normalizedKey, (contextState) => {
      const nextTabs = contextState.tabs.filter((candidate) => sidePanelTargetKey(candidate) !== exactKey);
      if (nextTabs.length === 0) {
        return { activeKey: null, hasPanelState: true, open: false, tabs: [] };
      }
      if (contextState.activeKey !== exactKey) return { ...contextState, tabs: nextTabs };
      const fallbackTarget = nextTabs[Math.min(detachingIndex, nextTabs.length - 1)] ?? null;
      return {
        activeKey: fallbackTarget ? sidePanelTargetKey(fallbackTarget) : null,
        hasPanelState: true,
        open: true,
        tabs: nextTabs,
      };
    }, scope);
    if (scopedKey === sidePanelContextScopeKey(currentScopeRef.current)) setOpen(nextState.open);
    return { detached: true, revision, target };
  }, [activeScope, writeContextState]);

  const closeTarget = useCallback((key: string) => {
    if (sidePanelContextScopeKey(activeScope) !== sidePanelContextScopeKey(currentScopeRef.current)) return;
    writeContextState(contextKey, (current) => {
      const closingIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === key);
      const nextTabs = current.tabs.filter((candidate) => sidePanelTargetKey(candidate) !== key);
      if (nextTabs.length === 0) {
        setOpen(false);
        return { activeKey: null, hasPanelState: true, open: false, tabs: [] };
      }
      if (current.activeKey !== key) return { ...current, tabs: nextTabs };
      const fallbackTarget = nextTabs[Math.min(Math.max(closingIndex, 0), nextTabs.length - 1)] ?? nextTabs.at(-1) ?? null;
      return { activeKey: fallbackTarget ? sidePanelTargetKey(fallbackTarget) : null, hasPanelState: true, open: true, tabs: nextTabs };
    }, activeScope);
  }, [activeScope, contextKey, writeContextState]);

  const registerCloseRequestHandler = useCallback((handler: (target: SidePanelTarget) => void | Promise<void>) => {
    closeRequestHandlerRef.current = handler;
    return () => {
      if (closeRequestHandlerRef.current === handler) closeRequestHandlerRef.current = null;
    };
  }, []);

  const registerBrowserResetHandler = useCallback((
    handler: SidePanelBrowserResetHandler,
  ) => {
    browserResetHandlerRef.current = handler;
    return () => {
      if (browserResetHandlerRef.current === handler) {
        browserResetHandlerRef.current = null;
      }
    };
  }, []);

  const requestCloseTarget = useCallback((key: string) => {
    const current = readOrCreateContextState(contextStatesRef.current, activeScope);
    const target = current.tabs.find((candidate) => sidePanelTargetKey(candidate) === key);
    if (!target) return;
    const handler = closeRequestHandlerRef.current;
    if (handler) {
      void handler(target);
      return;
    }
    closeTarget(key);
  }, [activeScope, closeTarget]);

  const hasActiveClosableTab = open && Boolean(currentContextState.activeKey);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    const setSidePanelCloseShortcutActive =
      desktopShell?.setSidePanelCloseShortcutActive;
    if (!setSidePanelCloseShortcutActive) return undefined;
    let disposed = false;
    let lastActive: boolean | null = null;
    const syncShortcutOwner = () => {
      if (disposed) return;
      const nextActive = hasActiveClosableTab
        && !belongsToMainWorkbenchSurface(document.activeElement);
      if (lastActive === nextActive) return;
      lastActive = nextActive;
      void setSidePanelCloseShortcutActive(nextActive).catch(() => undefined);
    };
    const queueSync = () => queueMicrotask(syncShortcutOwner);
    document.addEventListener("focusin", queueSync, true);
    document.addEventListener("focusout", queueSync, true);
    syncShortcutOwner();
    return () => {
      disposed = true;
      document.removeEventListener("focusin", queueSync, true);
      document.removeEventListener("focusout", queueSync, true);
    };
  }, [hasActiveClosableTab]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    const setSidePanelCloseShortcutActive = desktopShell?.setSidePanelCloseShortcutActive;
    if (!setSidePanelCloseShortcutActive) return undefined;
    return () => {
      void setSidePanelCloseShortcutActive(false).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onBrowserReset) return undefined;
    return desktopShell.onBrowserReset(() => {
      const nextStates = Object.fromEntries(
        Object.entries(contextStatesRef.current).map(([key, state]) => {
          const scope = sidePanelContextScopeFromKey(key);
          if (!scope) return [key, state];
          return [
            key,
            withoutBrowserTargets(
              state,
              scope,
              browserResetHandlerRef.current,
            ),
          ];
        }),
      );
      contextStatesRef.current = nextStates;
      const current = nextStates[sidePanelContextScopeKey(currentScopeRef.current)] ?? emptyContextState();
      setCurrentContextState(current);
      setOpen(contextHasPanelState(current) && current.open);
    });
  }, []);

  useEffect(() => {
    if (!hasActiveClosableTab) return undefined;
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onCloseSidePanelActiveTab) return undefined;
    return desktopShell.onCloseSidePanelActiveTab(() => {
      const activeKey = currentContextState.activeKey;
      if (activeKey) requestCloseTarget(activeKey);
    });
  }, [currentContextState.activeKey, hasActiveClosableTab, requestCloseTarget]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onOpenEmptySidePanel) return undefined;
    return desktopShell.onOpenEmptySidePanel(openEmpty);
  }, [openEmpty]);

  useEffect(() => {
    if (!open || !currentContextState.activeKey) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (belongsToMainWorkbenchSurface(event.target)) return;
      if (event.key.toLowerCase() !== "w") return;
      const platform = getKeyboardShortcutPlatform();
      if (platform === "mac" ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      requestCloseTarget(currentContextState.activeKey!);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [currentContextState.activeKey, open, requestCloseTarget]);

  const replaceTargetForContext = useCallback((
    nextContextKey: string | null,
    key: string,
    target: SidePanelTarget,
    requestedOrganizationId?: string | null,
    requestedPrincipalId?: string | null,
  ) => {
    const normalizedKey = normalizeContextKey(nextContextKey);
    const scope: SidePanelContextScope = {
      ...activeScope,
      principalId: requestedPrincipalId === undefined
        ? activeScope.principalId
        : requestedPrincipalId,
      organizationId: requestedOrganizationId === undefined
        ? activeScope.organizationId
        : requestedOrganizationId,
      contextKey: normalizedKey,
    };
    const current = readOrCreateContextState(contextStatesRef.current, scope);
    if (!current.tabs.some((candidate) => sidePanelTargetKey(candidate) === key)) return false;
    const nextKey = sidePanelTargetKey(target);
    writeContextState(normalizedKey, (contextState) => ({
      ...contextState,
      activeKey: contextState.activeKey === key ? nextKey : contextState.activeKey,
      tabs: contextState.tabs.map((candidate) => (sidePanelTargetKey(candidate) === key ? target : candidate)),
    }), scope);
    return true;
  }, [activeScope, writeContextState]);

  const replaceTarget = useCallback((key: string, target: SidePanelTarget) => {
    replaceTargetForContext(contextKey, key, target);
  }, [contextKey, replaceTargetForContext]);

  const reorderTarget = useCallback((key: string, targetKey: string, position: "before" | "after") => {
    if (key === targetKey) return;
    writeContextState(contextKey, (current) => {
      const sourceIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === key);
      const targetIndex = current.tabs.findIndex((candidate) => sidePanelTargetKey(candidate) === targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const nextTabs = [...current.tabs];
      const [source] = nextTabs.splice(sourceIndex, 1);
      if (!source) return current;
      const adjustedTargetIndex = nextTabs.findIndex((candidate) => sidePanelTargetKey(candidate) === targetKey);
      const insertionIndex = adjustedTargetIndex + (position === "after" ? 1 : 0);
      nextTabs.splice(insertionIndex, 0, source);
      return { ...current, tabs: nextTabs };
    });
  }, [contextKey, writeContextState]);

  const setActiveKey = useCallback((key: string | null) => {
    if (sidePanelContextScopeKey(activeScope) !== sidePanelContextScopeKey(currentScopeRef.current)) return;
    notifyBeforeOpen();
    writeContextState(contextKey, (current) => ({ ...current, activeKey: key, hasPanelState: true, open: true }), activeScope);
  }, [activeScope, contextKey, notifyBeforeOpen, writeContextState]);

  const ownerOrganizationId = activeScope.organizationId;
  const value = useMemo<SidePanelContextValue>(() => ({
    activeKey: currentContextState.activeKey,
    clearCurrentContext,
    clearDisplayedContextHold,
    closePanel,
    closeTarget,
    contextKey,
    ownerOrganizationId,
    detachTargetForContext,
    displayedContextHold,
    getTargetRevisionForContext,
    hidePanel,
    holdDisplayedContext,
    open,
    openEmpty,
    openTarget,
    openTargetInNewTab,
    openTargetForContext,
    registerCloseRequestHandler,
    registerBrowserResetHandler,
    registerBeforeOpen,
    replaceTarget,
    replaceTargetForContext,
    reorderTarget,
    setActiveKey,
    setContextKey,
    showPanel,
    showPanelForContext,
    tabs: currentContextState.tabs,
    principalId,
  }), [clearCurrentContext, clearDisplayedContextHold, closePanel, closeTarget, contextKey, currentContextState.activeKey, currentContextState.tabs, detachTargetForContext, displayedContextHold, getTargetRevisionForContext, hidePanel, holdDisplayedContext, open, openEmpty, openTarget, openTargetForContext, openTargetInNewTab, ownerOrganizationId, principalId, registerBeforeOpen, registerBrowserResetHandler, registerCloseRequestHandler, reorderTarget, replaceTarget, replaceTargetForContext, setActiveKey, setContextKey, showPanel, showPanelForContext]);

  return <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>;
}

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: false,
  });
  const { selectedOrganizationId } = useOptionalOrganization() ?? {};
  const principalId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;
  const organizationId = selectedOrganizationId ?? null;
  return (
    <PrincipalScopedSidePanelProvider
      principalId={principalId}
      organizationId={organizationId}
    >
      {children}
    </PrincipalScopedSidePanelProvider>
  );
}

export function useSidePanel() {
  const value = useContext(SidePanelContext);
  if (!value) throw new Error("useSidePanel must be used inside SidePanelProvider");
  return value;
}

export function useOptionalSidePanel() {
  return useContext(SidePanelContext);
}
