import { LocalAppPanelView } from "@/components/side-panel/LocalAppPanelView";
import { BrowserLiveSurface } from "@/components/workbench/BrowserLiveSurface";
import type { BrowserShortcutAction } from "@rudderhq/shared";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  sidePanelTargetKey,
  type SidePanelTarget,
} from "../lib/side-panel-targets";

const LazyAutomationDetail = lazy(async () => ({
  default: (await import("@/pages/AutomationDetail")).AutomationDetail,
}));
const LazyLibraryLiveSurface = lazy(async () => ({
  default: (await import("@/components/workbench/LibraryLiveSurface"))
    .LibraryLiveSurface,
}));

export type LiveSurfaceTarget = Extract<
  SidePanelTarget,
  {
    kind:
      | "automation"
      | "browser"
      | "library_directory"
      | "library_document"
      | "library_entry"
      | "library_file"
      | "local_app";
  }
>;

export type LiveSurfaceRenderContext = {
  active: boolean;
  closeTarget: (target: SidePanelTarget) => void;
  openTarget: (target: SidePanelTarget) => void;
  replaceTarget: (target: SidePanelTarget) => void;
  surface: "side_panel" | "workbench";
  target: LiveSurfaceTarget;
};

export type LiveSurfaceRenderer = (
  context: LiveSurfaceRenderContext,
) => ReactNode;

export type LiveSurfaceOwnerCallbacks = {
  canOpenNewTab?: boolean;
  savedViewId?: string | null;
  onCloseTarget?: (target: SidePanelTarget) => void;
  onCycleTab?: (direction: -1 | 1) => void;
  onLocalAppTitleChange?: (title: string) => void;
  onOpenBrowserSettings?: () => void;
  onOpenTarget?: (target: SidePanelTarget) => void;
  onRegisterShortcutController?: (
    key: string,
    controller: ((action: BrowserShortcutAction) => void) | null,
  ) => void;
  onReplaceTarget?: (target: SidePanelTarget) => void;
};

type LiveSurfaceOwnerRegistration = {
  active: boolean;
  callbacks: LiveSurfaceOwnerCallbacks;
  element: HTMLElement;
  hostId: string;
  ownerId: string;
  renderSurface?: LiveSurfaceRenderer;
  runtimeId: string;
  target: LiveSurfaceTarget;
};

type LiveSurfaceRuntimeRecord = {
  interactionLocked: boolean;
  leaseOwnerId: string | null;
  owners: Map<string, LiveSurfaceOwnerRegistration>;
  renderSurface: LiveSurfaceRenderer | null;
  runtimeId: string;
  shortcutController: ((action: BrowserShortcutAction) => void) | null;
  target: LiveSurfaceTarget;
  webContentsId: number | null;
};

export type LiveSurfaceGuestOwner = {
  hostId: string;
  ownerId: string;
  runtimeId: string;
  surface: "side_panel" | "workbench";
  targetKind: LiveSurfaceTarget["kind"];
};

type LiveSurfaceRuntimeContextValue = {
  autoClaimSurface: (runtimeId: string, ownerId: string) => boolean;
  claimSurface: (runtimeId: string, ownerId: string) => boolean;
  closeTargetForGuest: (webContentsId: number) => boolean;
  closeTargetForRuntime: (runtimeId: string) => boolean;
  dispatchBrowserShortcutForGuest: (
    webContentsId: number,
    action: BrowserShortcutAction,
  ) => boolean;
  dispatchBrowserShortcutForRuntime: (
    runtimeId: string,
    action: BrowserShortcutAction,
  ) => boolean;
  disposeSurface: (runtimeId: string) => void;
  getGuestOwner: (webContentsId: number) => LiveSurfaceGuestOwner | null;
  getLiveBrowserCount: (organizationId: string) => number;
  getRuntimeTarget: (runtimeId: string) => LiveSurfaceTarget | null;
  hasSurface: (runtimeId: string) => boolean;
  listRecords: () => LiveSurfaceRuntimeRecord[];
  openTargetForGuest: (
    webContentsId: number,
    target: SidePanelTarget,
  ) => boolean;
  registerBrowserShortcutController: (
    runtimeId: string,
    controller: ((action: BrowserShortcutAction) => void) | null,
  ) => void;
  registerOwner: (
    registration: LiveSurfaceOwnerRegistration,
  ) => () => void;
  registerWebContentsId: (
    runtimeId: string,
    webContentsId: number | null,
  ) => void;
  revision: number;
  setInteractionLocked: (runtimeId: string, locked: boolean) => void;
  updateOwner: (registration: LiveSurfaceOwnerRegistration) => void;
  updateTarget: (runtimeId: string, target: LiveSurfaceTarget) => boolean;
  waitForOwner: (
    runtimeId: string,
    ownerId: string,
    timeoutMs?: number,
  ) => Promise<boolean>;
};

const LiveSurfaceRuntimeContext =
  createContext<LiveSurfaceRuntimeContextValue | null>(null);

function exactViewInstanceId(target: LiveSurfaceTarget) {
  const viewInstanceId = target.viewInstanceId?.trim()
    || (target.kind === "browser" ? target.tabId.trim() : "");
  if (!viewInstanceId) {
    throw new Error(`${target.kind} live surface requires a viewInstanceId`);
  }
  return viewInstanceId;
}

export function createLiveSurfaceRuntimeId(
  organizationId: string,
  target: LiveSurfaceTarget,
) {
  return JSON.stringify([
    organizationId.trim(),
    target.kind,
    exactViewInstanceId(target),
  ]);
}

function organizationIdFromRuntimeId(runtimeId: string) {
  try {
    const parsed = JSON.parse(runtimeId);
    return Array.isArray(parsed) && typeof parsed[0] === "string"
      ? parsed[0]
      : "";
  } catch {
    return "";
  }
}

function liveTargetsMatch(
  left: LiveSurfaceTarget,
  right: LiveSurfaceTarget,
) {
  return left.kind === right.kind
    && exactViewInstanceId(left) === exactViewInstanceId(right);
}

function serializableValuesMatch(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null
    || right === null
    || typeof left !== "object"
    || typeof right !== "object"
  ) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => (
        serializableValuesMatch(value, right[index])
      ));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter(
    (key) => leftRecord[key] !== undefined,
  );
  const rightKeys = Object.keys(rightRecord).filter(
    (key) => rightRecord[key] !== undefined,
  );
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.hasOwn(rightRecord, key)
      && serializableValuesMatch(leftRecord[key], rightRecord[key])
    ));
}

function ownerSurface(ownerId: string): "side_panel" | "workbench" {
  return ownerId.startsWith("main:") ? "workbench" : "side_panel";
}

function ownerReady(owner: LiveSurfaceOwnerRegistration | null | undefined) {
  if (!ownerClaimable(owner)) return false;
  const rect = owner.element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function ownerClaimable(
  owner: LiveSurfaceOwnerRegistration | null | undefined,
): owner is LiveSurfaceOwnerRegistration {
  return Boolean(owner?.active && owner.element.isConnected);
}

export function LiveSurfaceRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const recordsRef = useRef(new Map<string, LiveSurfaceRuntimeRecord>());
  const webContentsRuntimeIdsRef = useRef(new Map<number, string>());
  const [revision, setRevision] = useState(0);
  const touch = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  const registerOwner = useCallback((
    registration: LiveSurfaceOwnerRegistration,
  ) => {
    const current = recordsRef.current.get(registration.runtimeId);
    if (current && !liveTargetsMatch(current.target, registration.target)) {
      return () => undefined;
    }
    const record = current ?? {
      interactionLocked: false,
      leaseOwnerId: null,
      owners: new Map<string, LiveSurfaceOwnerRegistration>(),
      renderSurface: registration.renderSurface ?? null,
      runtimeId: registration.runtimeId,
      shortcutController: null,
      target: registration.target,
      webContentsId: null,
    };
    record.owners.set(registration.ownerId, registration);
    if (registration.renderSurface) record.renderSurface = registration.renderSurface;
    recordsRef.current.set(registration.runtimeId, record);
    touch();

    return () => {
      const latest = recordsRef.current.get(registration.runtimeId);
      if (!latest) return;
      latest.owners.delete(registration.ownerId);
      if (latest.leaseOwnerId === registration.ownerId) {
        latest.leaseOwnerId = null;
      }
      touch();
    };
  }, [touch]);

  const updateOwner = useCallback((
    registration: LiveSurfaceOwnerRegistration,
  ) => {
    const record = recordsRef.current.get(registration.runtimeId);
    if (!record || !liveTargetsMatch(record.target, registration.target)) return;
    const existing = record.owners.get(registration.ownerId);
    if (!existing) return;
    const targetChanged = !serializableValuesMatch(
      existing.target,
      registration.target,
    );
    const changed = existing.active !== registration.active
      || existing.callbacks !== registration.callbacks
      || existing.element !== registration.element
      || existing.hostId !== registration.hostId
      || existing.renderSurface !== registration.renderSurface
      || targetChanged;
    if (!changed) return;
    record.owners.set(registration.ownerId, registration);
    if (
      targetChanged
      && record.leaseOwnerId === registration.ownerId
      && !record.interactionLocked
    ) {
      record.target = registration.target;
    }
    if (registration.renderSurface) record.renderSurface = registration.renderSurface;
    touch();
  }, [touch]);

  const claimSurface = useCallback((runtimeId: string, ownerId: string) => {
    const record = recordsRef.current.get(runtimeId);
    const owner = record?.owners.get(ownerId);
    if (!record || !ownerReady(owner)) return false;
    if (record.leaseOwnerId === ownerId) return true;
    record.leaseOwnerId = ownerId;
    touch();
    return true;
  }, [touch]);

  const autoClaimSurface = useCallback((runtimeId: string, ownerId: string) => {
    const record = recordsRef.current.get(runtimeId);
    const owner = record?.owners.get(ownerId);
    if (!record || !ownerClaimable(owner)) return false;
    if (record.leaseOwnerId && record.leaseOwnerId !== ownerId) return false;
    if (record.leaseOwnerId === ownerId) return true;
    record.leaseOwnerId = ownerId;
    touch();
    return true;
  }, [touch]);

  const waitForOwner = useCallback(async (
    runtimeId: string,
    ownerId: string,
    timeoutMs = 5_000,
  ) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const owner = recordsRef.current.get(runtimeId)?.owners.get(ownerId);
      if (ownerReady(owner)) return true;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 16);
      });
    }
    return false;
  }, []);

  const setInteractionLocked = useCallback((
    runtimeId: string,
    locked: boolean,
  ) => {
    const record = recordsRef.current.get(runtimeId);
    if (!record || record.interactionLocked === locked) return;
    record.interactionLocked = locked;
    touch();
  }, [touch]);

  const updateTarget = useCallback((
    runtimeId: string,
    target: LiveSurfaceTarget,
  ) => {
    const record = recordsRef.current.get(runtimeId);
    if (!record || !liveTargetsMatch(record.target, target)) return false;
    record.target = target;
    touch();
    return true;
  }, [touch]);

  const disposeSurface = useCallback((runtimeId: string) => {
    const record = recordsRef.current.get(runtimeId);
    if (!record) return;
    if (record.webContentsId !== null) {
      webContentsRuntimeIdsRef.current.delete(record.webContentsId);
    }
    recordsRef.current.delete(runtimeId);
    touch();
  }, [touch]);

  const registerWebContentsId = useCallback((
    runtimeId: string,
    webContentsId: number | null,
  ) => {
    const record = recordsRef.current.get(runtimeId);
    if (!record || record.webContentsId === webContentsId) return;
    if (record.webContentsId !== null) {
      webContentsRuntimeIdsRef.current.delete(record.webContentsId);
    }
    record.webContentsId = webContentsId;
    if (webContentsId !== null) {
      webContentsRuntimeIdsRef.current.set(webContentsId, runtimeId);
    }
  }, []);

  const getGuestOwner = useCallback((webContentsId: number) => {
    const runtimeId = webContentsRuntimeIdsRef.current.get(webContentsId);
    const record = runtimeId ? recordsRef.current.get(runtimeId) : null;
    const owner = record?.leaseOwnerId
      ? record.owners.get(record.leaseOwnerId)
      : null;
    if (!record || !owner) return null;
    return {
      hostId: owner.hostId,
      ownerId: owner.ownerId,
      runtimeId: record.runtimeId,
      surface: ownerSurface(owner.ownerId),
      targetKind: record.target.kind,
    };
  }, []);

  const openTargetForGuest = useCallback((
    webContentsId: number,
    target: SidePanelTarget,
  ) => {
    const runtimeId = webContentsRuntimeIdsRef.current.get(webContentsId);
    const record = runtimeId ? recordsRef.current.get(runtimeId) : null;
    const owner = record?.leaseOwnerId
      ? record.owners.get(record.leaseOwnerId)
      : null;
    if (!owner?.callbacks.onOpenTarget) return false;
    owner.callbacks.onOpenTarget(target);
    return true;
  }, []);

  const closeTargetForRuntime = useCallback((runtimeId: string) => {
    const record = recordsRef.current.get(runtimeId);
    const owner = record?.leaseOwnerId
      ? record.owners.get(record.leaseOwnerId)
      : null;
    if (!record || !owner?.callbacks.onCloseTarget) return false;
    owner.callbacks.onCloseTarget(record.target);
    return true;
  }, []);

  const closeTargetForGuest = useCallback((webContentsId: number) => {
    const runtimeId = webContentsRuntimeIdsRef.current.get(webContentsId);
    return runtimeId ? closeTargetForRuntime(runtimeId) : false;
  }, [closeTargetForRuntime]);

  const registerBrowserShortcutController = useCallback((
    runtimeId: string,
    controller: ((action: BrowserShortcutAction) => void) | null,
  ) => {
    const record = recordsRef.current.get(runtimeId);
    if (!record || record.target.kind !== "browser") return;
    record.shortcutController = controller;
  }, []);

  const dispatchBrowserShortcutForRuntime = useCallback((
    runtimeId: string,
    action: BrowserShortcutAction,
  ) => {
    const record = recordsRef.current.get(runtimeId);
    if (
      !record
      || record.target.kind !== "browser"
      || !record.leaseOwnerId
      || !record.shortcutController
    ) return false;
    record.shortcutController(action);
    return true;
  }, []);

  const dispatchBrowserShortcutForGuest = useCallback((
    webContentsId: number,
    action: BrowserShortcutAction,
  ) => {
    const runtimeId = webContentsRuntimeIdsRef.current.get(webContentsId);
    return runtimeId
      ? dispatchBrowserShortcutForRuntime(runtimeId, action)
      : false;
  }, [dispatchBrowserShortcutForRuntime]);

  const getLiveBrowserCount = useCallback((organizationId: string) => (
    Array.from(recordsRef.current.values()).filter((record) => (
      record.target.kind === "browser"
      && organizationIdFromRuntimeId(record.runtimeId) === organizationId
    )).length
  ), []);
  const getRuntimeTarget = useCallback(
    (runtimeId: string) => recordsRef.current.get(runtimeId)?.target ?? null,
    [],
  );
  const hasSurface = useCallback(
    (runtimeId: string) => recordsRef.current.has(runtimeId),
    [],
  );
  const listRecords = useCallback(
    () => Array.from(recordsRef.current.values()),
    [],
  );

  const value = useMemo<LiveSurfaceRuntimeContextValue>(() => ({
    autoClaimSurface,
    claimSurface,
    closeTargetForGuest,
    closeTargetForRuntime,
    dispatchBrowserShortcutForGuest,
    dispatchBrowserShortcutForRuntime,
    disposeSurface,
    getGuestOwner,
    getLiveBrowserCount,
    getRuntimeTarget,
    hasSurface,
    listRecords,
    openTargetForGuest,
    registerBrowserShortcutController,
    registerOwner,
    registerWebContentsId,
    revision,
    setInteractionLocked,
    updateOwner,
    updateTarget,
    waitForOwner,
  }), [
    autoClaimSurface,
    claimSurface,
    closeTargetForGuest,
    closeTargetForRuntime,
    dispatchBrowserShortcutForGuest,
    dispatchBrowserShortcutForRuntime,
    disposeSurface,
    getGuestOwner,
    getLiveBrowserCount,
    getRuntimeTarget,
    hasSurface,
    listRecords,
    openTargetForGuest,
    registerBrowserShortcutController,
    registerOwner,
    registerWebContentsId,
    revision,
    setInteractionLocked,
    updateOwner,
    updateTarget,
    waitForOwner,
  ]);

  return (
    <LiveSurfaceRuntimeContext.Provider value={value}>
      {children}
    </LiveSurfaceRuntimeContext.Provider>
  );
}

export function useLiveSurfaceRuntime() {
  const value = useContext(LiveSurfaceRuntimeContext);
  if (!value) {
    throw new Error(
      "useLiveSurfaceRuntime must be used inside LiveSurfaceRuntimeProvider",
    );
  }
  return value;
}

export function useOptionalLiveSurfaceRuntime() {
  return useContext(LiveSurfaceRuntimeContext);
}

export type LiveSurfaceAnchorProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  active: boolean;
  autoClaim?: boolean;
  callbacks?: LiveSurfaceOwnerCallbacks;
  hostId: string;
  ownerId: string;
  renderSurface?: LiveSurfaceRenderer;
  runtimeId: string;
  target: LiveSurfaceTarget;
};

export function LiveSurfaceAnchor({
  active,
  autoClaim = true,
  callbacks = {},
  hostId,
  ownerId,
  renderSurface,
  runtimeId,
  target,
  ...divProps
}: LiveSurfaceAnchorProps) {
  const {
    autoClaimSurface,
    registerOwner,
    updateOwner,
  } = useLiveSurfaceRuntime();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const stableCallbacks = useMemo<LiveSurfaceOwnerCallbacks>(() => ({
    get canOpenNewTab() {
      return callbacksRef.current.canOpenNewTab;
    },
    get savedViewId() {
      return callbacksRef.current.savedViewId;
    },
    onCloseTarget: (nextTarget) => (
      callbacksRef.current.onCloseTarget?.(nextTarget)
    ),
    onCycleTab: (direction) => (
      callbacksRef.current.onCycleTab?.(direction)
    ),
    onLocalAppTitleChange: (title) => (
      callbacksRef.current.onLocalAppTitleChange?.(title)
    ),
    onOpenBrowserSettings: () => (
      callbacksRef.current.onOpenBrowserSettings?.()
    ),
    onOpenTarget: (nextTarget) => (
      callbacksRef.current.onOpenTarget?.(nextTarget)
    ),
    onRegisterShortcutController: (key, controller) => (
      callbacksRef.current.onRegisterShortcutController?.(key, controller)
    ),
    onReplaceTarget: (nextTarget) => (
      callbacksRef.current.onReplaceTarget?.(nextTarget)
    ),
  }), []);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    return registerOwner({
      active,
      callbacks: stableCallbacks,
      element,
      hostId,
      ownerId,
      renderSurface,
      runtimeId,
      target,
    });
    // Registration identity is exact and must survive metadata/active updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, ownerId, registerOwner, runtimeId]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const registration: LiveSurfaceOwnerRegistration = {
      active,
      callbacks: stableCallbacks,
      element,
      hostId,
      ownerId,
      renderSurface,
      runtimeId,
      target,
    };
    updateOwner(registration);
    if (active && autoClaim) autoClaimSurface(runtimeId, ownerId);
  }, [
    active,
    autoClaim,
    autoClaimSurface,
    hostId,
    ownerId,
    renderSurface,
    runtimeId,
    stableCallbacks,
    target,
    updateOwner,
  ]);

  return <div {...divProps} ref={elementRef} data-owner-id={ownerId} />;
}

function RuntimeSurface({
  record,
  owner,
  visible,
}: {
  record: LiveSurfaceRuntimeRecord;
  owner: LiveSurfaceOwnerRegistration | null;
  visible: boolean;
}) {
  const runtime = useLiveSurfaceRuntime();
  const target = record.target;
  const callbacks = owner?.callbacks;
  const surface = owner ? ownerSurface(owner.ownerId) : "side_panel";
  const closeTarget = (nextTarget: SidePanelTarget) => {
    callbacks?.onCloseTarget?.(nextTarget);
  };
  const openTarget = (nextTarget: SidePanelTarget) => {
    callbacks?.onOpenTarget?.(nextTarget);
  };
  const replaceTarget = (nextTarget: SidePanelTarget) => {
    if (
      nextTarget.kind === "automation"
      || nextTarget.kind === "browser"
      || nextTarget.kind === "library_directory"
      || nextTarget.kind === "library_document"
      || nextTarget.kind === "library_entry"
      || nextTarget.kind === "library_file"
      || nextTarget.kind === "local_app"
    ) {
      runtime.updateTarget(record.runtimeId, nextTarget);
    }
    if (!record.interactionLocked) {
      callbacks?.onReplaceTarget?.(nextTarget);
    }
  };
  const renderedCustomSurface = record.renderSurface?.({
    active: visible,
    closeTarget,
    openTarget,
    replaceTarget,
    surface,
    target,
  });

  if (target.kind === "browser") {
    return (
      <BrowserLiveSurface
        active={visible}
        canOpenNewTab={callbacks?.canOpenNewTab ?? false}
        surface={surface}
        target={target}
        targetKey={sidePanelTargetKey(target)}
        onCloseTarget={closeTarget}
        onCycleTab={callbacks?.onCycleTab}
        onOpenBrowserSettings={callbacks?.onOpenBrowserSettings}
        onOpenTarget={openTarget}
        onRegisterShortcutController={
          (key, controller) => {
            runtime.registerBrowserShortcutController(
              record.runtimeId,
              controller,
            );
            callbacks?.onRegisterShortcutController?.(key, controller);
          }
        }
        onReplaceTarget={(_key, nextTarget) => replaceTarget(nextTarget)}
        onWebContentsIdChange={(webContentsId) => {
          runtime.registerWebContentsId(record.runtimeId, webContentsId);
        }}
      />
    );
  }
  if (target.kind === "local_app") {
    return (
      <LocalAppPanelView
        active={visible}
        savedViewId={callbacks?.savedViewId}
        target={target}
        onTitleChange={callbacks?.onLocalAppTitleChange}
      />
    );
  }
  if (renderedCustomSurface !== undefined) {
    return <>{renderedCustomSurface}</>;
  }
  if (target.kind === "automation") {
    return (
      <Suspense fallback={<div className="h-full" />}>
        <LazyAutomationDetail
          automationId={target.automationId}
          onClose={() => closeTarget(target)}
          onOpenRunChat={(conversationId) => openTarget({
            kind: "chat",
            conversationId,
            label: "Automation run",
            messageId: null,
          })}
          surface={surface}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<div className="h-full" />}>
      <LazyLibraryLiveSurface
        active={visible}
        organizationId={organizationIdFromRuntimeId(record.runtimeId)}
        onOpenTarget={openTarget}
        surface={surface}
        target={target}
      />
    </Suspense>
  );
}

export function LiveSurfaceRuntimeLayer() {
  const runtime = useLiveSurfaceRuntime();
  const records = runtime.listRecords();
  const [, forceGeometryUpdate] = useState(0);

  useEffect(() => {
    const update = () => forceGeometryUpdate((current) => current + 1);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    for (const record of runtime.listRecords()) {
      for (const owner of record.owners.values()) {
        observer?.observe(owner.element);
      }
    }
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [runtime]);

  return (
    <div
      className="pointer-events-none fixed inset-0"
      data-testid="live-surface-runtime-layer"
      aria-label="Live workspace surfaces"
    >
      {records.map((record) => {
        const owner = record.leaseOwnerId
          ? record.owners.get(record.leaseOwnerId) ?? null
          : null;
        const visible = ownerReady(owner);
        const rect = visible
          ? owner!.element.getBoundingClientRect()
          : null;
        const inert = !visible || record.interactionLocked;
        return (
          <div
            key={record.runtimeId}
            data-testid="live-surface-runtime-host"
            data-host-id={owner?.hostId}
            data-owner-id={owner?.ownerId}
            data-runtime-id={record.runtimeId}
            data-target-kind={record.target.kind}
            data-view-instance-id={exactViewInstanceId(record.target)}
            aria-hidden={!visible}
            hidden={!visible}
            inert={inert ? true : undefined}
            className={`fixed flex min-h-0 flex-col overflow-hidden bg-[color:var(--surface-panel)] ${
              owner?.ownerId.startsWith("side:")
                ? "rounded-[var(--desktop-workspace-radius)]"
                : owner?.ownerId.startsWith("main:")
                  ? record.target.kind === "browser"
                    ? "rounded-[var(--desktop-workspace-radius)]"
                    : "rounded-b-[var(--desktop-workspace-radius)]"
                  : ""
            }`}
            style={{
              height: rect ? `${rect.height}px` : "0px",
              left: rect ? `${rect.left}px` : "0px",
              pointerEvents: inert ? "none" : "auto",
              top: rect ? `${rect.top}px` : "0px",
              width: rect ? `${rect.width}px` : "0px",
              zIndex: owner?.ownerId.startsWith("side:") ? 70 : 40,
            }}
          >
            <RuntimeSurface
              record={record}
              owner={owner}
              visible={visible && !record.interactionLocked}
            />
          </div>
        );
      })}
    </div>
  );
}
