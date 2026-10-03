import { chatsApi, type ChatContinueQueuedMessageRequest, type ChatSteerQueuedMessageRequest } from "@/api/chats";
import { ApiError, ApiTimeoutError } from "@/api/client";
import { Textarea } from "@/components/ui/textarea";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import type { ConfirmDialogOptions } from "@/context/DialogContext";
import type { ToastInput } from "@/context/ToastContext";
import { chatErrorToast } from "@/lib/chat-errors";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { ChatConversation, ChatQueuedMessage, ChatQueueSnapshot } from "@rudderhq/shared";
import type { QueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { activeGenerationIdFromSnapshot, CHAT_STEER_RETRY_DELAYS_MS, EMPTY_CHAT_BODY_SHA256, projectChatQueueDelivery, queuedMessagePayloadForBodyEdit, type PendingChatSteerRetry } from "./Chat.workspace-helpers";

type PendingContinuation = { version: number; failedGenerationId: string; request: ChatContinueQueuedMessageRequest };
type QueueEdit = { itemId: string; value: string; version: number };
type ChatQueueControlsInput = {
  selectedConversation: ChatConversation | null | undefined;
  selectedOrganizationId: string | null;
  selectedConversationExternalBound: boolean;
  serverActiveGenerationId: string | null;
  currentUserId: string | null;
  queryClient: QueryClient;
  queueQuery: { data: ChatQueueSnapshot | undefined };
  activeQueueItems: ChatQueuedMessage[];
  visibleQueueItems: ChatQueuedMessage[];
  streamDrafts: Record<string, ChatStreamDraft>;
  streamScopeKeyForChatId: (chatId: string) => string;
  steerRetryStatesRef: RefObject<Map<string, PendingChatSteerRetry>>;
  submitSteerRetryRef: RefObject<(pending: PendingChatSteerRetry) => void>;
  steeringQueuedItemIdsRef: RefObject<Set<string>>;
  setSteeringQueuedItemIds: Dispatch<SetStateAction<Set<string>>>;
  steeringQueuedItemIds: Set<string>;
  continuingQueuedItemIdsRef: RefObject<Set<string>>;
  setContinuingQueuedItemIds: Dispatch<SetStateAction<Set<string>>>;
  continuingQueuedItemIds: Set<string>;
  continuationRequestsRef: RefObject<Map<string, PendingContinuation>>;
  authorizedContinuationsRef: RefObject<Map<string, Omit<PendingContinuation, "request">>>;
  editingQueuedItem: QueueEdit | null;
  setEditingQueuedItem: Dispatch<SetStateAction<QueueEdit | null>>;
  refreshQueue: (chatId: string) => void;
  pushToast: (input: ToastInput) => string | null;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  canSteerQueuedMessages: boolean;
};

function canContinueQueuedChatInput(input: {
  item: ChatQueuedMessage;
  snapshot: ChatQueueSnapshot | undefined;
  activeGenerationId: string | null;
  currentUserId: string | null;
  conversationOwnerUserId: string | null;
  conversationCanContinue: boolean;
  knownAuthorization?: { version: number; failedGenerationId: string };
  pendingRequest?: {
    version: number;
    failedGenerationId: string;
    request: ChatContinueQueuedMessageRequest;
  };
}) {
  const {
    item,
    snapshot,
    activeGenerationId,
    currentUserId,
    conversationOwnerUserId,
    conversationCanContinue,
    knownAuthorization,
    pendingRequest,
  } = input;
  const actor = item.requestActor;
  const ownerUserId = actor?.userId ?? (actor?.source === "local_implicit" ? "local-board" : null);
  const viewerUserId = currentUserId ?? (actor?.source === "local_implicit" ? "local-board" : null);
  const canReplaceAuthorization = Boolean(
    item.controlActionId
    && knownAuthorization
    && (knownAuthorization.version !== item.version
      || knownAuthorization.failedGenerationId !== snapshot?.latestFailedGenerationId),
  );
  const canReplayPendingRequest = Boolean(
    pendingRequest
    && pendingRequest.failedGenerationId === snapshot?.latestFailedGenerationId
    && pendingRequest.version <= item.version
    && (!item.controlActionId || item.controlActionId === pendingRequest.request.controlActionId)
    && (item.version === pendingRequest.version
      || item.controlActionId === pendingRequest.request.controlActionId),
  );
  const eligible = Boolean(
    conversationCanContinue
    && snapshot?.latestFailedGenerationId
    && !activeGenerationId
    && actor?.type === "board"
    && ownerUserId
    && viewerUserId === ownerUserId
    && (!conversationOwnerUserId || conversationOwnerUserId === ownerUserId)
    && item.status === "queued"
    && item.deliveryIntent === "queue"
    && item.version > 0
    && (!item.controlActionId || canReplaceAuthorization || canReplayPendingRequest)
    && item.deliveryAttempts === 0
    && item.deliveryLeaseEpoch === 0
    && !item.deliveryLeaseToken
    && !item.continuationGenerationId
    && !item.continuationMessageId
    && !item.sourceMessageId
    && !item.deliveredMessageId
    && !item.providerClientMessageId
    && !item.providerThreadId
    && !item.providerTurnId
    && !item.providerEvidence
    && !item.cancelledAt,
  );
  return eligible;
}

function chatQueueContinueErrorToast(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return {
        title: "You can't continue this queued message",
        body: "Only the queued message owner who owns this conversation can continue it.",
      };
    }
    if (error.status === 409 && /already authorized|already.*continue|bound to another request/iu.test(error.message)) {
      return {
        title: "Continue already requested",
        body: "This queued message already has a continuation request. Refresh the queue to see its current state.",
      };
    }
    if (error.status === 409) {
      return {
        title: "Queue changed",
        body: "The failed reply or queued message changed. Review the refreshed queue before continuing.",
      };
    }
    if (error.status === 404) {
      return {
        title: "Queued message unavailable",
        body: "This queued message is no longer available. The queue was refreshed.",
      };
    }
  }
  if (error instanceof ApiTimeoutError || error instanceof TypeError) {
    return {
      title: "Could not confirm Continue",
      body: "Rudder could not be reached. The request may have completed, so refresh the queue before retrying.",
    };
  }
  return {
    title: "Could not continue queued message",
    body: "Rudder could not authorize this queued message. Refresh the queue and try again.",
  };
}

// Keep state, refs and effects in ChatWorkspace; this factory preserves each
// render's closures and returns the same queue element tree without a new boundary.
export function createChatQueueControls(input: ChatQueueControlsInput) {
  const { selectedConversation, selectedOrganizationId, selectedConversationExternalBound, serverActiveGenerationId, currentUserId, queryClient, queueQuery, activeQueueItems, visibleQueueItems, streamDrafts, streamScopeKeyForChatId, steerRetryStatesRef, submitSteerRetryRef, steeringQueuedItemIdsRef, setSteeringQueuedItemIds, steeringQueuedItemIds, continuingQueuedItemIdsRef, setContinuingQueuedItemIds, continuingQueuedItemIds, continuationRequestsRef, authorizedContinuationsRef, editingQueuedItem, setEditingQueuedItem, refreshQueue, pushToast, confirm, canSteerQueuedMessages } = input;
  const clearSteerRetry = (pending: PendingChatSteerRetry) => {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (steerRetryStatesRef.current.get(pending.key) === pending) {
      steerRetryStatesRef.current.delete(pending.key);
    }
  };
  const scheduleSteerRetry = (pending: PendingChatSteerRetry) => {
    if (steerRetryStatesRef.current.get(pending.key) !== pending || pending.timer) return;
    if (pending.retryCount >= CHAT_STEER_RETRY_DELAYS_MS.length) {
      clearSteerRetry(pending);
      pushToast({ ...chatErrorToast(pending.lastError, "steer"), tone: "error" });
      refreshQueue(pending.chatId);
      return;
    }
    const delayMs = CHAT_STEER_RETRY_DELAYS_MS[
      Math.min(pending.retryCount, CHAT_STEER_RETRY_DELAYS_MS.length - 1)
    ];
    pending.retryCount += 1;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (steerRetryStatesRef.current.get(pending.key) === pending) {
        steeringQueuedItemIdsRef.current.delete(pending.itemId);
        setSteeringQueuedItemIds((current) => {
          if (!current.has(pending.itemId)) return current;
          const next = new Set(current);
          next.delete(pending.itemId);
          return next;
        });
        submitSteerRetryRef.current(pending);
      }
    }, delayMs);
  };
  const submitSteerRetry = (pending: PendingChatSteerRetry) => {
    const { chatId, itemId, orgId, request } = pending;
    if (steeringQueuedItemIdsRef.current.has(itemId)) return;
    steeringQueuedItemIdsRef.current.add(itemId);
    setSteeringQueuedItemIds((current) => new Set(current).add(itemId));
    queryClient.setQueryData(
      queryKeys.chats.queue(orgId, chatId),
      (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
        latestFailedGenerationId: current?.latestFailedGenerationId !== undefined
          ? current.latestFailedGenerationId
          : queueQuery.data?.latestFailedGenerationId ?? null,
        activeGenerationId: current?.activeGenerationId ?? request.expectedActiveGenerationId ?? null,
        activeAttemptEpoch: current?.activeAttemptEpoch ?? request.expectedAttemptEpoch ?? null,
        activeControlVersion: current?.activeControlVersion ?? request.expectedControlVersion ?? null,
        activeGenerationStatus: current?.activeGenerationStatus ?? null,
        items: (current?.items ?? []).map((item) => item.id === itemId && (item.status === "queued" || item.status === "failed_actionable")
          ? {
              ...item,
              status: "steer_pending" as const,
              deliveryIntent: "steer" as const,
              deliveryDisposition: "pending" as const,
              controlActionId: request.controlActionId,
              lastDeliveryReason: null,
            }
          : item),
      }),
    );
    void chatsApi.steerQueuedMessage(chatId, itemId, request)
      .then((result) => {
        clearSteerRetry(pending);
        queryClient.setQueryData(
          queryKeys.chats.queue(orgId, chatId),
          (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
            latestFailedGenerationId: current?.latestFailedGenerationId !== undefined
              ? current.latestFailedGenerationId
              : queueQuery.data?.latestFailedGenerationId ?? null,
            activeGenerationId: current?.activeGenerationId ?? request.expectedActiveGenerationId ?? null,
            activeAttemptEpoch: current?.activeAttemptEpoch ?? request.expectedAttemptEpoch ?? null,
            activeControlVersion: current?.activeControlVersion ?? request.expectedControlVersion ?? null,
            activeGenerationStatus: current?.activeGenerationStatus ?? null,
            items: (current?.items ?? []).map((item) => item.id === itemId ? result.item : item),
          }),
        );
        refreshQueue(chatId);
      })
      .catch((error) => {
        if (!(error instanceof ApiError)) {
          pending.lastError = error;
          scheduleSteerRetry(pending);
          refreshQueue(chatId);
          return;
        }
        clearSteerRetry(pending);
        pushToast({ ...chatErrorToast(error, "steer"), tone: "error" });
        refreshQueue(chatId);
      })
      .finally(() => {
        const activeRetry = steerRetryStatesRef.current.get(pending.key);
        if (activeRetry === pending && pending.timer) return;
        steeringQueuedItemIdsRef.current.delete(itemId);
        setSteeringQueuedItemIds((current) => {
          if (!current.has(itemId)) return current;
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
      });
  };
  submitSteerRetryRef.current = submitSteerRetry;
  const steerQueuedMessage = (itemId: string) => {
    if (!selectedConversation || !selectedOrganizationId || steeringQueuedItemIdsRef.current.has(itemId)) return;
    const activeGenerationId = serverActiveGenerationId;
    const expectedAttemptEpoch = queueQuery.data?.activeAttemptEpoch;
    const expectedControlVersion = queueQuery.data?.activeControlVersion;
    const chatId = selectedConversation.id;
    const item = activeQueueItems.find((candidate) => candidate.id === itemId);
    const request: ChatSteerQueuedMessageRequest = {
      controlActionId: item?.status === "failed_actionable"
        ? globalThis.crypto.randomUUID()
        : item?.controlActionId ?? globalThis.crypto.randomUUID(),
      ...(activeGenerationId ? { expectedActiveGenerationId: activeGenerationId } : {}),
      ...(expectedAttemptEpoch !== null && expectedAttemptEpoch !== undefined
        ? { expectedAttemptEpoch }
        : {}),
      ...(expectedControlVersion !== null && expectedControlVersion !== undefined
        ? { expectedControlVersion }
        : {}),
      ...(streamDrafts[streamScopeKeyForChatId(chatId)] ? {
        lastCommittedRenderSeq: streamDrafts[streamScopeKeyForChatId(chatId)].lastCommittedRenderSeq ?? 0,
        renderedBodyHash: streamDrafts[streamScopeKeyForChatId(chatId)].renderedBodyHash ?? EMPTY_CHAT_BODY_SHA256,
      } : {}),
    };
    const pending: PendingChatSteerRetry = {
      key: `${chatId}\u0000${itemId}`,
      orgId: selectedOrganizationId,
      chatId,
      itemId,
      request,
      retryCount: 0,
      timer: null,
    };
    steerRetryStatesRef.current.set(pending.key, pending);
    submitSteerRetry(pending);
  };
  const continueQueuedMessage = async (itemId: string) => {
    if (!selectedConversation || !selectedOrganizationId || continuingQueuedItemIdsRef.current.has(itemId)) return;
    const chatId = selectedConversation.id;
    const queueKey = queryKeys.chats.queue(selectedOrganizationId, chatId);
    const requestKey = `${chatId}\u0000${itemId}`;
    const knownAuthorization = authorizedContinuationsRef.current.get(requestKey);
    const pendingRequest = continuationRequestsRef.current.get(requestKey);
    const snapshot = queryClient.getQueryData<ChatQueueSnapshot>(queueKey) ?? queueQuery.data;
    const item = snapshot?.items.find((candidate) => candidate.id === itemId);
    const failedGenerationId = snapshot?.latestFailedGenerationId;
    if (!item || !failedGenerationId || !canContinueQueuedChatInput({
      item,
      snapshot,
      activeGenerationId: activeGenerationIdFromSnapshot(snapshot),
      currentUserId,
      conversationOwnerUserId: selectedConversation.createdByUserId,
      conversationCanContinue: !selectedConversationExternalBound
        && selectedConversation.conversationKind !== "side_chat",
      knownAuthorization,
      pendingRequest,
    })) {
      pushToast({
        title: "Queue changed",
        body: "The failed reply or queued message is no longer eligible. The queue was refreshed.",
        tone: "warn",
      });
      void queryClient.invalidateQueries({ queryKey: queueKey, exact: true });
      return;
    }

    const previousRequest = continuationRequestsRef.current.get(requestKey);
    const canReplayPreviousRequest = Boolean(
      previousRequest
      && previousRequest.failedGenerationId === failedGenerationId
      && previousRequest.version <= item.version
      && (!item.controlActionId || item.controlActionId === previousRequest.request.controlActionId)
      && (item.version === previousRequest.version
        || item.controlActionId === previousRequest.request.controlActionId),
    );
    const request = canReplayPreviousRequest && previousRequest
      ? previousRequest.request
      : {
          version: item.version,
          expectedFailedGenerationId: failedGenerationId,
          controlActionId: globalThis.crypto.randomUUID(),
        };
    continuationRequestsRef.current.set(requestKey, {
      version: item.version,
      failedGenerationId,
      request,
    });
    continuingQueuedItemIdsRef.current.add(itemId);
    setContinuingQueuedItemIds((current) => new Set(current).add(itemId));

    try {
      const result = await chatsApi.continueQueuedMessage(chatId, item.id, request);
      if (result.controlActionId !== request.controlActionId) {
        throw new Error("Continue response did not match the requested action");
      }
      queryClient.setQueryData<ChatQueueSnapshot>(queueKey, (current) => current ? {
        ...current,
        items: current.items.map((candidate) => candidate.id === result.item.id ? result.item : candidate),
      } : current);
      authorizedContinuationsRef.current.set(requestKey, {
        version: result.item.version,
        failedGenerationId,
      });
      continuationRequestsRef.current.delete(requestKey);
      let queueRefreshed = true;
      try {
        await queryClient.invalidateQueries({ queryKey: queueKey, exact: true });
      } catch {
        queueRefreshed = false;
      }
      pushToast({
        title: result.idempotent ? "Continue already requested" : "Continue requested",
        body: queueRefreshed
          ? "The queued message is authorized to continue from the latest failed reply."
          : "Continue was accepted, but the queue could not refresh. Reload the chat to confirm progress.",
        tone: queueRefreshed ? "success" : "warn",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        continuationRequestsRef.current.delete(requestKey);
      }
      pushToast({ ...chatQueueContinueErrorToast(error), tone: "error" });
      try {
        await queryClient.invalidateQueries({ queryKey: queueKey, exact: true });
      } catch {
        // Keep the request error as the user-visible cause.
      }
    } finally {
      continuingQueuedItemIdsRef.current.delete(itemId);
      setContinuingQueuedItemIds((current) => {
        if (!current.has(itemId)) return current;
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  };
  const editQueuedMessage = (itemId: string, body: string) => {
    const item = activeQueueItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setEditingQueuedItem({ itemId, value: body, version: item.version });
  };
  const saveQueuedMessage = (item: ChatQueuedMessage) => {
    if (!selectedConversation || editingQueuedItem?.itemId !== item.id || !selectedOrganizationId) return;
    const body = editingQueuedItem.value.trim();
    if (!body && (item.payload.inlineAnnotations?.length ?? 0) === 0) {
      pushToast({ title: "Queued message cannot be empty", tone: "error" });
      return;
    }
    const chatId = selectedConversation.id;
    void chatsApi.updateQueuedMessage(chatId, item.id, {
      version: editingQueuedItem.version,
      payload: queuedMessagePayloadForBodyEdit(item.payload, body),
    }).then((updated) => {
      queryClient.setQueryData(
        queryKeys.chats.queue(selectedOrganizationId, chatId),
        (current: Awaited<ReturnType<typeof chatsApi.listQueue>> | undefined) => ({
          latestFailedGenerationId: current?.latestFailedGenerationId !== undefined
            ? current.latestFailedGenerationId
            : queueQuery.data?.latestFailedGenerationId ?? null,
          activeGenerationId: current?.activeGenerationId ?? queueQuery.data?.activeGenerationId ?? null,
          activeAttemptEpoch: current?.activeAttemptEpoch ?? queueQuery.data?.activeAttemptEpoch ?? null,
          activeControlVersion: current?.activeControlVersion ?? queueQuery.data?.activeControlVersion ?? null,
          activeGenerationStatus: current?.activeGenerationStatus ?? queueQuery.data?.activeGenerationStatus ?? null,
        items: (current?.items ?? []).map((candidate) => candidate.id === updated.id ? updated : candidate),
        }),
      );
      setEditingQueuedItem(null);
      refreshQueue(chatId);
    }).catch((error) => {
      pushToast({ title: "Failed to edit queued message", body: error instanceof Error ? error.message : "Try again.", tone: "error" });
    });
  };
  const deleteQueuedMessage = async (itemId: string) => {
    if (!selectedConversation) return;
    const confirmed = await confirm({
      title: "Delete queued message?",
      description: "This permanently removes the queued message before it is sent. This cannot be undone.",
      confirmLabel: "Delete message",
      tone: "destructive",
    });
    if (!confirmed) return;
    const chatId = selectedConversation.id;
    void chatsApi.cancelQueuedMessage(chatId, itemId)
      .then(() => refreshQueue(chatId))
      .catch((error) => {
        pushToast({ title: "Failed to delete queued message", body: error instanceof Error ? error.message : "Try again.", tone: "error" });
      });
  };
  const renderQueue = () => (selectedConversation && visibleQueueItems.length > 0 ? (
        <div data-testid="chat-running-queue" className="mb-2.5 rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)] p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>Queue</span>
            <span>{visibleQueueItems.length} queued</span>
          </div>
          <div className="space-y-1.5">
            {visibleQueueItems.map((item, index) => {
              const itemSteering = steeringQueuedItemIds.has(item.id);
              const itemContinuationPending = continuingQueuedItemIds.has(item.id);
              const delivery = projectChatQueueDelivery(item, itemSteering);
              const itemEditable = delivery.state === "queued" && !itemSteering;
              const itemRetryable = delivery.state === "failed" && !itemSteering;
              const itemContinueEligible = canContinueQueuedChatInput({
                item,
                snapshot: queueQuery.data,
                activeGenerationId: serverActiveGenerationId,
                currentUserId,
                conversationOwnerUserId: selectedConversation?.createdByUserId ?? null,
                conversationCanContinue: !selectedConversationExternalBound
                  && selectedConversation?.conversationKind !== "side_chat",
                knownAuthorization: selectedConversation
                  ? authorizedContinuationsRef.current.get(`${selectedConversation.id}\u0000${item.id}`)
                  : undefined,
                pendingRequest: selectedConversation
                  ? continuationRequestsRef.current.get(`${selectedConversation.id}\u0000${item.id}`)
                  : undefined,
              });
              return (
                <div key={item.id} data-testid="chat-running-queue-item" className="flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] border border-border/60 bg-background/70 px-2.5 py-2 text-sm">
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground">#{index + 1}</span>
                  {editingQueuedItem?.itemId === item.id && itemEditable ? (
                    <>
                      <Textarea aria-label="Edit queued message text" data-testid="chat-running-queue-edit" className="min-h-9 flex-1 resize-none rounded-[var(--radius-sm)] border-border/70 bg-background px-2 py-1.5 text-sm" value={editingQueuedItem.value} onChange={(event) => setEditingQueuedItem((current) => current?.itemId === item.id ? { ...current, value: event.target.value } : current)} />
                      <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-muted" onClick={() => saveQueuedMessage(item)}>Save</button>
                      <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted" onClick={() => setEditingQueuedItem(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-foreground">{item.payload.body}</span>
                      {item.payload.inlineAnnotations?.length ? (
                        <span
                          data-testid="chat-running-queue-annotation-count"
                          className="chat-chip shrink-0 px-2 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {item.payload.inlineAnnotations.length} {item.payload.inlineAnnotations.length === 1 ? "annotation" : "annotations"}
                        </span>
                      ) : null}
                      {delivery.state !== "hidden" ? (
                        <span className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          delivery.state === "failed"
                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                        )}>{delivery.label}</span>
                      ) : null}
                      {itemEditable ? (
                        <>
                          {itemContinueEligible ? (
                            <button
                              type="button"
                              className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                              disabled={itemContinuationPending}
                              onClick={() => void continueQueuedMessage(item.id)}
                            >{itemContinuationPending ? "Continuing…" : "Continue"}</button>
                          ) : null}
                          {canSteerQueuedMessages ? (
                            <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300" onClick={() => steerQueuedMessage(item.id)}>Steer</button>
                          ) : null}
                          <button type="button" aria-label="Edit queued message" className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => editQueuedMessage(item.id, item.payload.body)}><Pencil className="h-3.5 w-3.5" /></button>
                          <button type="button" aria-label="Delete queued message" className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => void deleteQueuedMessage(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      ) : itemRetryable ? (
                        <button type="button" className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300" onClick={() => steerQueuedMessage(item.id)}>Retry</button>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null);
  return { renderQueue };
}
