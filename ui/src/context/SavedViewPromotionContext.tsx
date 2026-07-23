import { ApiError } from "@/api/client";
import { messengerApi } from "@/api/messenger";
import {
  createLiveSurfaceRuntimeId,
  useLiveSurfaceRuntime,
  type LiveSurfaceTarget,
} from "@/context/LiveSurfaceRuntimeContext";
import { useMainWorkbench } from "@/context/MainWorkbenchContext";
import { useOptionalOrganization } from "@/context/OrganizationContext";
import { useSidePanel } from "@/context/SidePanelContext";
import type { MainWorkbenchTarget } from "@/lib/main-workbench-state";
import {
  messengerSavedViewRoute,
  type MessengerSavedViewKeepInput,
} from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import {
  sidePanelTargetKey,
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import type {
  MessengerCustomGroupsResponse,
  MessengerSavedViewKeepResult,
} from "@rudderhq/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type SavedViewPromotionRequest = {
  contextKey: string;
  input: MessengerSavedViewKeepInput;
  organizationId: string;
  target: SidePanelTarget;
  existingResult?: MessengerSavedViewKeepResult | null;
};

export type SavedViewPromotionMoveState = {
  clientMutationId: string | null;
  error: string | null;
  promotionId: string | null;
  retryable: boolean;
  status:
    | "idle"
    | "pending"
    | "reconciling"
    | "server_failed"
    | "commit_unknown"
    | "claim_failed"
    | "claiming"
    | "detaching";
};

type SavedViewPromotionContextValue = {
  finalizeSavedViewRemoval: (
    organizationId: string,
    savedViewId: string,
  ) => void;
  getMoveState: (
    organizationId: string,
    contextKey: string,
    target: SidePanelTarget,
  ) => SavedViewPromotionMoveState;
  isMoving: (
    organizationId: string,
    contextKey: string,
    target: SidePanelTarget,
  ) => boolean;
  promote: (
    request: SavedViewPromotionRequest,
  ) => Promise<MessengerSavedViewKeepResult>;
  retry: (
    organizationId: string,
    contextKey: string,
    target: SidePanelTarget,
  ) => Promise<MessengerSavedViewKeepResult>;
  discard: (
    organizationId: string,
    contextKey: string,
    target: SidePanelTarget,
  ) => boolean;
  setSavedViewRemovalPending: (
    organizationId: string,
    savedViewId: string,
    pending: boolean,
  ) => void;
};

const SavedViewPromotionContext =
  createContext<SavedViewPromotionContextValue | null>(null);

function newId(prefix: string) {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizedTarget(target: SidePanelTarget): MainWorkbenchTarget | null {
  if (
    !sidePanelTargetSupportsSavedView(target)
    || (
      target.kind !== "automation"
      && target.kind !== "browser"
      && target.kind !== "library_directory"
      && target.kind !== "library_document"
      && target.kind !== "library_entry"
      && target.kind !== "library_file"
      && target.kind !== "local_app"
    )
  ) return null;
  const viewInstanceId = target.viewInstanceId
    ?? (target.kind === "browser" ? target.tabId : null);
  return viewInstanceId
    ? { ...target, viewInstanceId } as MainWorkbenchTarget
    : null;
}

function movingKey(
  organizationId: string,
  contextKey: string,
  target: SidePanelTarget,
) {
  const normalized = normalizedTarget(target);
  return normalized
    ? JSON.stringify([
        organizationId,
        contextKey,
        normalized.kind,
        normalized.viewInstanceId,
      ])
    : "";
}

function savedViewRemovalKey(organizationId: string, savedViewId: string) {
  return JSON.stringify([organizationId.trim(), savedViewId]);
}

function cacheKeepResult(
  queryClient: ReturnType<typeof useQueryClient>,
  organizationId: string,
  result: MessengerSavedViewKeepResult,
) {
  const { group, savedView } = result;
  queryClient.setQueryData(
    queryKeys.messenger.savedView(organizationId, savedView.id),
    savedView,
  );
  const groupsKey = queryKeys.messenger.customGroups(organizationId);
  if (queryClient.getQueryData(groupsKey) === undefined) return;
  queryClient.setQueryData<MessengerCustomGroupsResponse>(
    groupsKey,
    (current) => {
      const itemKey = `saved-view:${savedView.id}`;
      const now = savedView.updatedAt ?? new Date();
      const optimisticEntry = {
        id: `optimistic:${itemKey}`,
        orgId: savedView.orgId,
        userId: savedView.userId,
        groupId: group.id,
        itemKey,
        sortOrder: 0,
        createdAt: savedView.createdAt ?? now,
        updatedAt: now,
        item: {
          type: "saved_view" as const,
          itemKey,
          title: savedView.title,
          savedView,
        },
      };
      const groups = current?.groups ?? [];
      const existingGroup = groups.find((candidate) => candidate.id === group.id);
      if (existingGroup) {
        return {
          groups: groups.map((candidate) => {
            if (candidate.id !== group.id) return {
              ...candidate,
              entries: candidate.entries.filter((entry) => (
                entry.item.type !== "saved_view"
                || entry.item.savedView.id !== savedView.id
              )),
            };
            const entries = candidate.entries.filter((entry) => (
              entry.item.type !== "saved_view"
              || entry.item.savedView.id !== savedView.id
            ));
            return {
              ...candidate,
              entries: [
                ...entries,
                { ...optimisticEntry, sortOrder: entries.length },
              ],
            };
          }),
        };
      }
      return {
        groups: [
          ...groups.map((candidate) => ({
            ...candidate,
            entries: candidate.entries.filter((entry) => (
              entry.item.type !== "saved_view"
              || entry.item.savedView.id !== savedView.id
            )),
          })),
          {
            id: group.id,
            orgId: savedView.orgId,
            userId: savedView.userId,
            name: group.name,
            icon: null,
            sortOrder: groups.length,
            collapsed: false,
            pinnedAt: null,
            createdAt: now,
            updatedAt: now,
            entries: [optimisticEntry],
          },
        ],
      };
    },
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not move this view.";
}

class PersistenceTimeoutError extends Error {
  constructor() {
    super("Keeping this view timed out. Retry to check whether it was saved.");
    this.name = "PersistenceTimeoutError";
  }
}

function withPersistenceTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(
      () => reject(new PersistenceTimeoutError()),
      timeoutMs,
    );
    request.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

type RetainedPromotionAttempt = {
  exactKey: string;
  key: string;
  mainOwnerId: string;
  promotionId: string;
  request: SavedViewPromotionRequest;
  result: MessengerSavedViewKeepResult | null;
  runtimeId: string;
  sideOwnerId: string;
  sourceRevision: number;
  target: MainWorkbenchTarget;
};

export function SavedViewPromotionProvider({
  children,
  claimTimeoutMs = 5_000,
  persistenceTimeoutMs = 15_000,
}: {
  children: ReactNode;
  claimTimeoutMs?: number;
  persistenceTimeoutMs?: number;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const sidePanel = useSidePanel();
  const workbench = useMainWorkbench();
  const organization = useOptionalOrganization();
  const liveSurfaceRuntime = useLiveSurfaceRuntime();
  const movingRef = useRef(new Set<string>());
  const attemptsRef = useRef(new Map<string, RetainedPromotionAttempt>());
  const savedViewRemovalStatesRef = useRef(new Map<
    string,
    { pendingCount: number; removed: boolean }
  >());
  const currentOrganizationIdRef = useRef<string | null | undefined>(
    organization?.selectedOrganizationId,
  );
  currentOrganizationIdRef.current = organization?.selectedOrganizationId;
  const [revision, setRevision] = useState(0);
  const touch = useCallback(() => setRevision((current) => current + 1), []);

  const unlockAttempt = useCallback((attempt: RetainedPromotionAttempt) => {
    liveSurfaceRuntime.setInteractionLocked(attempt.runtimeId, false);
    movingRef.current.delete(attempt.key);
    touch();
  }, [liveSurfaceRuntime, touch]);

  const finishClaim = useCallback(async (
    attempt: RetainedPromotionAttempt,
    result: MessengerSavedViewKeepResult,
  ): Promise<MessengerSavedViewKeepResult> => {
    const organizationId = attempt.request.organizationId.trim();
    if (
      currentOrganizationIdRef.current !== undefined
      && currentOrganizationIdRef.current !== organizationId
    ) {
      liveSurfaceRuntime.claimSurface(attempt.runtimeId, attempt.sideOwnerId);
      workbench.dispatch({
        type: "promotion/claim-fail",
        organizationId,
        promotionId: attempt.promotionId,
        savedViewId: result.savedView.id,
        expectedSourceRevision: attempt.sourceRevision,
        error: "organization_changed",
      });
      unlockAttempt(attempt);
      throw new Error(
        "Saved in Messenger. Return to the original organization to retry the move.",
      );
    }
    const stopForSavedViewRemoval = () => {
      if (!savedViewRemovalStatesRef.current.has(
        savedViewRemovalKey(organizationId, result.savedView.id),
      )) {
        return false;
      }
      liveSurfaceRuntime.claimSurface(attempt.runtimeId, attempt.sideOwnerId);
      const promotion = workbench.getState().organizations[organizationId]
        ?.promotionsById[attempt.promotionId];
      if (promotion?.status === "claiming") {
        workbench.dispatch({
          type: "promotion/claim-fail",
          organizationId,
          promotionId: attempt.promotionId,
          savedViewId: result.savedView.id,
          expectedSourceRevision: attempt.sourceRevision,
          error: "saved_view_removal_pending",
        });
      } else if (promotion?.status === "detaching") {
        workbench.dispatch({
          type: "promotion/detach-fail",
          organizationId,
          promotionId: attempt.promotionId,
          savedViewId: result.savedView.id,
          expectedSourceRevision: attempt.sourceRevision,
          error: "saved_view_removal_pending",
        });
      }
      unlockAttempt(attempt);
      return true;
    };
    if (stopForSavedViewRemoval()) {
      throw new Error("Saved View removal interrupted this move.");
    }
    sidePanel.holdDisplayedContext(organizationId, attempt.request.contextKey);
    const claimedState = workbench.dispatch({
      type: "promotion/claim",
      organizationId,
      promotionId: attempt.promotionId,
      savedViewId: result.savedView.id,
      expectedSourceRevision: attempt.sourceRevision,
    });
    if (
      claimedState.organizations[organizationId]
        ?.promotionsById[attempt.promotionId]?.status !== "detaching"
    ) {
      unlockAttempt(attempt);
      throw new Error("The Saved View was kept, but Main could not stage it.");
    }

    navigate(messengerSavedViewRoute(result.savedView.id));
    const ownerReady = await liveSurfaceRuntime.waitForOwner(
      attempt.runtimeId,
      attempt.mainOwnerId,
      claimTimeoutMs,
    );
    if (stopForSavedViewRemoval()) {
      throw new Error("Saved View removal interrupted this move.");
    }
    const claimed = ownerReady
      && liveSurfaceRuntime.claimSurface(
        attempt.runtimeId,
        attempt.mainOwnerId,
      );
    if (!claimed) {
      liveSurfaceRuntime.claimSurface(attempt.runtimeId, attempt.sideOwnerId);
      workbench.dispatch({
        type: "promotion/detach-fail",
        organizationId,
        promotionId: attempt.promotionId,
        savedViewId: result.savedView.id,
        expectedSourceRevision: attempt.sourceRevision,
        error: "main_anchor_claim_failed",
      });
      unlockAttempt(attempt);
      throw new Error(
        "Saved in Messenger, but Main is not ready. Retry the move.",
      );
    }
    if (stopForSavedViewRemoval()) {
      throw new Error("Saved View removal interrupted this move.");
    }

    const detached = sidePanel.detachTargetForContext(
      attempt.request.contextKey,
      attempt.exactKey,
      attempt.sourceRevision,
    );
    if (!detached.detached) {
      liveSurfaceRuntime.claimSurface(attempt.runtimeId, attempt.sideOwnerId);
      workbench.dispatch({
        type: "promotion/detach-fail",
        organizationId,
        promotionId: attempt.promotionId,
        savedViewId: result.savedView.id,
        expectedSourceRevision: attempt.sourceRevision,
        error: detached.reason,
      });
      unlockAttempt(attempt);
      throw new Error(
        "Saved in Messenger, but the Side Panel changed. Retry the move.",
      );
    }

    workbench.dispatch({
      type: "promotion/detach-succeed",
      organizationId,
      promotionId: attempt.promotionId,
      savedViewId: result.savedView.id,
      expectedSourceRevision: attempt.sourceRevision,
    });
    attemptsRef.current.delete(attempt.key);
    unlockAttempt(attempt);
    return result;
  }, [
    claimTimeoutMs,
    liveSurfaceRuntime,
    navigate,
    sidePanel,
    unlockAttempt,
    workbench,
  ]);

  const setSavedViewRemovalPending = useCallback((
    organizationId: string,
    savedViewId: string,
    pending: boolean,
  ) => {
    const key = savedViewRemovalKey(organizationId, savedViewId);
    const current = savedViewRemovalStatesRef.current.get(key);
    if (pending) {
      savedViewRemovalStatesRef.current.set(key, {
        pendingCount: (current?.pendingCount ?? 0) + 1,
        removed: current?.removed ?? false,
      });
      return;
    }
    if (current?.removed) return;
    const pendingCount = Math.max(0, (current?.pendingCount ?? 0) - 1);
    if (pendingCount === 0) savedViewRemovalStatesRef.current.delete(key);
    else savedViewRemovalStatesRef.current.set(key, {
      pendingCount,
      removed: false,
    });
  }, []);

  const finalizeSavedViewRemoval = useCallback((
    organizationIdInput: string,
    savedViewId: string,
  ) => {
    const organizationId = organizationIdInput.trim();
    savedViewRemovalStatesRef.current.set(
      savedViewRemovalKey(organizationId, savedViewId),
      { pendingCount: 0, removed: true },
    );
    for (const attempt of Array.from(attemptsRef.current.values())) {
      if (attempt.request.organizationId.trim() !== organizationId) continue;
      const promotion = workbench.getState().organizations[organizationId]
        ?.promotionsById[attempt.promotionId];
      const promotionSavedViewId = attempt.result?.savedView.id
        ?? (
          promotion && "savedViewId" in promotion
            ? promotion.savedViewId
            : promotion?.source.savedViewId
        );
      if (promotionSavedViewId !== savedViewId || !promotion) continue;
      liveSurfaceRuntime.claimSurface(attempt.runtimeId, attempt.sideOwnerId);
      workbench.dispatch({
        type: "promotion/cancel-saved-view",
        organizationId,
        promotionId: attempt.promotionId,
        savedViewId,
        expectedSourceRevision: promotion.source.sourceRevision,
      });
      attemptsRef.current.delete(attempt.key);
      unlockAttempt(attempt);
    }
  }, [
    liveSurfaceRuntime,
    unlockAttempt,
    workbench,
  ]);

  const persistAndClaim = useCallback(async (
    attempt: RetainedPromotionAttempt,
  ): Promise<MessengerSavedViewKeepResult> => {
    const organizationId = attempt.request.organizationId.trim();
    let result: MessengerSavedViewKeepResult;
    try {
      result = attempt.request.existingResult
        ?? await withPersistenceTimeout(
          messengerApi.keepSavedView(organizationId, attempt.request.input),
          persistenceTimeoutMs,
        );
    } catch (error) {
      workbench.dispatch({
        type: error instanceof ApiError
          ? "promotion/server-fail"
          : "promotion/timeout",
        organizationId,
        promotionId: attempt.promotionId,
        expectedSourceRevision: attempt.sourceRevision,
        error: errorMessage(error),
      });
      unlockAttempt(attempt);
      throw error;
    }

    attempt.result = result;
    cacheKeepResult(queryClient, organizationId, result);
    workbench.dispatch({
      type: "promotion/server-commit",
      organizationId,
      promotionId: attempt.promotionId,
      savedViewId: result.savedView.id,
      expectedSourceRevision: attempt.sourceRevision,
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.messenger.customGroups(organizationId),
    }).catch(() => undefined);
    return finishClaim(attempt, result);
  }, [
    finishClaim,
    persistenceTimeoutMs,
    queryClient,
    unlockAttempt,
    workbench,
  ]);

  const promote = useCallback(async (
    request: SavedViewPromotionRequest,
  ): Promise<MessengerSavedViewKeepResult> => {
    const organizationId = request.organizationId.trim();
    const target = normalizedTarget(request.target);
    if (!organizationId || !target) {
      throw new Error("This Side Panel view cannot move to Messenger.");
    }
    const exactKey = sidePanelTargetKey(request.target);
    const sourceRevision = sidePanel.getTargetRevisionForContext(
      request.contextKey,
      exactKey,
    );
    if (sourceRevision === null) {
      throw new Error("This Side Panel view is no longer available.");
    }
    const runtimeId = createLiveSurfaceRuntimeId(
      organizationId,
      target as LiveSurfaceTarget,
    );
    const key = movingKey(organizationId, request.contextKey, request.target);
    if (!key || movingRef.current.has(key)) {
      throw new Error("This view is already moving.");
    }
    const runtimeAlreadyPromoting = Array.from(
      attemptsRef.current.values(),
    ).some((attempt) => attempt.runtimeId === runtimeId)
      || Object.values(
        workbench.getState().organizations[organizationId]
          ?.promotionsById ?? {},
      ).some((promotion) => promotion.source.runtimeId === runtimeId);
    if (runtimeAlreadyPromoting) {
      throw new Error("This runtime is already moving.");
    }
    if (attemptsRef.current.has(key)) {
      throw new Error("This move has a retained attempt. Use Retry move.");
    }

    const attempt: RetainedPromotionAttempt = {
      exactKey,
      key,
      mainOwnerId: `main:${organizationId}:${target.viewInstanceId}`,
      promotionId: newId("promotion"),
      request,
      result: request.existingResult ?? null,
      runtimeId,
      sideOwnerId: `side:${request.contextKey}:${runtimeId}`,
      sourceRevision,
      target,
    };
    attemptsRef.current.set(key, attempt);
    movingRef.current.add(key);
    touch();
    liveSurfaceRuntime.setInteractionLocked(runtimeId, true);
    workbench.dispatch({
      type: "runtime/admit",
      organizationId,
      runtime: {
        id: runtimeId,
        viewInstanceId: target.viewInstanceId,
        targetKind: target.kind,
        target,
        host: { kind: "side", contextKey: request.contextKey },
      },
    });
    const nextState = workbench.dispatch({
      type: "promotion/start",
      organizationId,
      promotionId: attempt.promotionId,
      clientMutationId: request.input.clientMutationId,
      source: {
        viewInstanceId: target.viewInstanceId,
        savedViewId: request.existingResult?.savedView.id ?? null,
        sourceRevision,
        target,
        originContextKey: request.contextKey,
        runtimeId,
      },
    });
    if (
      nextState.organizations[organizationId]
        ?.promotionsById[attempt.promotionId]?.status !== "pending"
    ) {
      attemptsRef.current.delete(key);
      unlockAttempt(attempt);
      throw new Error("This view could not enter the move transaction.");
    }
    return persistAndClaim(attempt);
  }, [
    liveSurfaceRuntime,
    persistAndClaim,
    sidePanel,
    touch,
    unlockAttempt,
    workbench,
  ]);

  const discardAttempt = useCallback((
    attempt: RetainedPromotionAttempt,
  ) => {
    const organizationId = attempt.request.organizationId.trim();
    const promotion = workbench.getState().organizations[organizationId]
      ?.promotionsById[attempt.promotionId];
    if (
      !promotion
      || (
        promotion.status !== "server_failed"
        && promotion.status !== "commit_unknown"
        && promotion.status !== "claim_failed"
      )
    ) {
      return false;
    }
    const savedViewId = attempt.result?.savedView.id
      ?? promotion.source.savedViewId;
    if (
      savedViewId
      && location.pathname.endsWith(messengerSavedViewRoute(savedViewId))
    ) {
      navigate("/messenger/workbench", { replace: true });
    }
    const nextState = workbench.dispatch({
      type: "promotion/discard",
      organizationId,
      promotionId: attempt.promotionId,
      expectedSourceRevision: promotion.source.sourceRevision,
    });
    if (
      nextState.organizations[organizationId]
        ?.promotionsById[attempt.promotionId]
    ) {
      return false;
    }
    attemptsRef.current.delete(attempt.key);
    unlockAttempt(attempt);
    return true;
  }, [
    location.pathname,
    navigate,
    unlockAttempt,
    workbench,
  ]);

  const discard = useCallback((
    organizationId: string,
    contextKey: string,
    target: SidePanelTarget,
  ) => {
    const attempt = attemptsRef.current.get(
      movingKey(organizationId, contextKey, target),
    );
    return attempt ? discardAttempt(attempt) : false;
  }, [discardAttempt]);

  useEffect(() => sidePanel.registerBrowserResetHandler((
    contextKey,
    target,
  ) => {
    const normalizedTarget = {
      ...target,
      viewInstanceId: target.viewInstanceId ?? target.tabId,
    } satisfies LiveSurfaceTarget;
    const attempt = Array.from(attemptsRef.current.values()).find(
      (candidate) => (
        candidate.request.contextKey === contextKey
        && candidate.runtimeId === createLiveSurfaceRuntimeId(
          candidate.request.organizationId.trim(),
          normalizedTarget,
        )
      ),
    );
    if (!attempt) return "remove";
    const promotion = workbench.getState().organizations[
      attempt.request.organizationId.trim()
    ]?.promotionsById[attempt.promotionId];
    const terminal = promotion?.status === "server_failed"
      || promotion?.status === "commit_unknown"
      || promotion?.status === "claim_failed";
    if (!terminal) return "preserve";
    return discardAttempt(attempt) ? "remove" : "preserve";
  }), [
    discardAttempt,
    sidePanel,
    workbench,
  ]);

  const retry = useCallback(async (
    organizationIdInput: string,
    contextKey: string,
    targetInput: SidePanelTarget,
  ): Promise<MessengerSavedViewKeepResult> => {
    const organizationId = organizationIdInput.trim();
    const key = movingKey(organizationId, contextKey, targetInput);
    const attempt = attemptsRef.current.get(key);
    if (!key || !attempt) {
      throw new Error("There is no retained move to retry.");
    }
    if (movingRef.current.has(key)) {
      throw new Error("This view is already moving.");
    }
    const promotion = workbench.getState().organizations[organizationId]
      ?.promotionsById[attempt.promotionId];
    if (
      !promotion
      || (
        promotion.status !== "server_failed"
        && promotion.status !== "commit_unknown"
        && promotion.status !== "claim_failed"
      )
    ) {
      throw new Error("This move is not ready to retry.");
    }
    const currentRevision = sidePanel.getTargetRevisionForContext(
      contextKey,
      attempt.exactKey,
    );
    if (currentRevision !== attempt.sourceRevision) {
      discardAttempt(attempt);
      throw new Error("The Side Panel view changed. Start a new move.");
    }
    const replaced = sidePanel.replaceTargetForContext(
      contextKey,
      attempt.exactKey,
      { ...targetInput },
    );
    const nextSourceRevision = sidePanel.getTargetRevisionForContext(
      contextKey,
      attempt.exactKey,
    );
    if (
      !replaced
      || nextSourceRevision === null
      || nextSourceRevision <= attempt.sourceRevision
    ) {
      throw new Error("This Side Panel view could not enter retry.");
    }

    const retryType = promotion.status === "server_failed"
      ? "promotion/retry"
      : promotion.status === "commit_unknown"
        ? "promotion/reconcile"
        : "promotion/claim-retry";
    const nextState = workbench.dispatch({
      type: retryType,
      organizationId,
      promotionId: attempt.promotionId,
      expectedSourceRevision: attempt.sourceRevision,
      nextSourceRevision,
    });
    const expectedStatus = retryType === "promotion/reconcile"
      ? "reconciling"
      : retryType === "promotion/claim-retry"
        ? "claiming"
        : "pending";
    if (
      nextState.organizations[organizationId]
        ?.promotionsById[attempt.promotionId]?.status !== expectedStatus
    ) {
      throw new Error("This move could not enter retry.");
    }

    attempt.sourceRevision = nextSourceRevision;
    attempt.request = { ...attempt.request, target: { ...targetInput } };
    movingRef.current.add(key);
    touch();
    liveSurfaceRuntime.setInteractionLocked(attempt.runtimeId, true);
    if (retryType === "promotion/claim-retry") {
      if (!attempt.result) {
        unlockAttempt(attempt);
        throw new Error("The retained Saved View could not be recovered.");
      }
      return finishClaim(attempt, attempt.result);
    }
    return persistAndClaim(attempt);
  }, [
    finishClaim,
    discardAttempt,
    liveSurfaceRuntime,
    persistAndClaim,
    sidePanel,
    touch,
    unlockAttempt,
    workbench,
  ]);

  const isMoving = useCallback((
    organizationId: string,
    contextKey: string,
    target: SidePanelTarget,
  ) => movingRef.current.has(movingKey(
    organizationId,
    contextKey,
    target,
  )), []);

  const getMoveState = useCallback((
    organizationId: string,
    contextKey: string,
    target: SidePanelTarget,
  ): SavedViewPromotionMoveState => {
    const attempt = attemptsRef.current.get(
      movingKey(organizationId, contextKey, target),
    );
    if (!attempt) {
      return {
        clientMutationId: null,
        error: null,
        promotionId: null,
        retryable: false,
        status: "idle",
      };
    }
    const promotion = workbench.state.organizations[organizationId]
      ?.promotionsById[attempt.promotionId];
    if (!promotion) {
      return {
        clientMutationId: attempt.request.input.clientMutationId,
        error: null,
        promotionId: attempt.promotionId,
        retryable: false,
        status: "idle",
      };
    }
    return {
      clientMutationId: promotion.clientMutationId,
      error: "error" in promotion ? promotion.error : null,
      promotionId: promotion.id,
      retryable: promotion.status === "server_failed"
        || promotion.status === "commit_unknown"
        || promotion.status === "claim_failed",
      status: promotion.status,
    };
  }, [workbench.state]);

  const value = useMemo(
    () => ({
      discard,
      finalizeSavedViewRemoval,
      getMoveState,
      isMoving,
      promote,
      retry,
      setSavedViewRemovalPending,
    }),
    [
      discard,
      finalizeSavedViewRemoval,
      getMoveState,
      isMoving,
      promote,
      retry,
      revision,
      setSavedViewRemovalPending,
    ],
  );
  return (
    <SavedViewPromotionContext.Provider value={value}>
      {children}
    </SavedViewPromotionContext.Provider>
  );
}

export function useSavedViewPromotion() {
  const value = useContext(SavedViewPromotionContext);
  if (!value) {
    throw new Error(
      "useSavedViewPromotion must be used inside SavedViewPromotionProvider",
    );
  }
  return value;
}

export function useOptionalSavedViewPromotion() {
  return useContext(SavedViewPromotionContext);
}
