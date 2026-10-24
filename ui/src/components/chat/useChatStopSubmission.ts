import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import type { ChatSendRecovery } from "@/components/chat/ChatSendRecoveryNotice";
import type { useChatSendRecoveryDiscovery } from "@/components/chat/useChatSendRecoveryDiscovery";
import type { ChatStreamDraft, useChatGenerations } from "@/context/ChatGenerationContext";
import type { useToast } from "@/context/ToastContext";
import { settleStoppedChatInput } from "@/lib/chat-send-recovery-settlement";
import { CHAT_STOP_CONFIRMATION_PENDING_MESSAGE, CHAT_STOP_OWNER_LOST_MESSAGE, CHAT_STOP_REJECTED_MESSAGE, CHAT_STOP_REQUIRES_FRESH_ACTION_MESSAGE } from "@/lib/chat-stop-feedback";
import { chatStopRecoveryActionKey, clearPendingChatStopRecovery, createChatStopRecoveryRetrier, hasCompleteNativeStopFence, hydrateIncompleteNativeChatStopRecovery, readPendingChatStopRecovery, savePendingChatStopRecovery, type PendingChatStopRecovery } from "@/lib/chat-stop-recovery";
import { queryKeys } from "@/lib/queryKeys";
import { EMPTY_CHAT_BODY_SHA256 } from "@/pages/Chat.workspace-helpers";
import type { ChatConversation } from "@rudderhq/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, type Dispatch, type SetStateAction } from "react";

type Ref<T> = { current: T };
type Setter<T> = Dispatch<SetStateAction<T>>;
type StopSubmissionOptions = Pick<ReturnType<typeof useChatGenerations>, "abortChatStream" | "setChatSendInFlight" | "setStreamDraftForChat">
  & Pick<ReturnType<typeof useToast>, "pushToast" | "dismissToast"> & {
  nativeRecoveryQuery: { dataUpdatedAt: number };
  ownerLostStopStreamKeysRef: Ref<Set<string>>;
  queryClient: QueryClient;
  recoveryDiscovery: Pick<ReturnType<typeof useChatSendRecoveryDiscovery>, "clearRecovery" | "retry">;
  selectedConversation: Pick<ChatConversation, "id"> | null | undefined;
  selectedOrganizationId: string | null;
  setChatSendRecovery: Setter<(ChatSendRecovery & { orgId: string; conversationId: string }) | null>;
  setConfirmedOwnerLoss: Setter<{ orgId: string; chatId: string; generationId: string; recoveryReadUpdatedAt: number } | null>;
  setConfirmedStoppedChat: Setter<{ orgId: string; chatId: string } | null>;
  setStoppingChatIds: Setter<Set<string>>;
  stopRecoveryImmediateRetryKeysRef: Ref<Set<string>>;
  stopRecoveryMatchesCurrentStream: (recovery: PendingChatStopRecovery) => boolean;
  stopRecoveryRetrier: ReturnType<typeof createChatStopRecoveryRetrier>;
  stopRecoveryStreamKeysRef: Ref<Record<string, string>>;
  stoppingChatIdsRef: Ref<Set<string>>;
  streamDraftsRef: Ref<Record<string, ChatStreamDraft>>;
  streamOwnershipRef: Ref<Record<string, { streamKey: string }>>;
  streamScopeKeyForChatId: (chatId: string) => string;
};

export function useChatStopSubmission({
  abortChatStream,
  dismissToast,
  nativeRecoveryQuery,
  ownerLostStopStreamKeysRef,
  pushToast,
  queryClient,
  recoveryDiscovery,
  selectedConversation,
  selectedOrganizationId,
  setChatSendInFlight,
  setChatSendRecovery,
  setConfirmedOwnerLoss,
  setConfirmedStoppedChat,
  setStoppingChatIds,
  setStreamDraftForChat,
  stopRecoveryImmediateRetryKeysRef,
  stopRecoveryMatchesCurrentStream,
  stopRecoveryRetrier,
  stopRecoveryStreamKeysRef,
  stoppingChatIdsRef,
  streamDraftsRef,
  streamOwnershipRef,
  streamScopeKeyForChatId,
}: StopSubmissionOptions) {
  return useCallback((
    recovery: PendingChatStopRecovery,
  ) => {
    const { chatId, frozenDraft, orgId } = recovery;
    let request = recovery.request;
    let recoveryToSubmit = recovery;
    const actionKey = chatStopRecoveryActionKey(recovery);
    const stopToastId = `chat-stop:${actionKey}`;
    if (stoppingChatIdsRef.current.has(chatId)) {
      stopRecoveryImmediateRetryKeysRef.current.add(actionKey);
      return;
    }
    const persistedRecovery = readPendingChatStopRecovery(orgId, chatId);
    if (
      persistedRecovery
      && persistedRecovery.request.controlActionId !== request.controlActionId
    ) {
      stopRecoveryRetrier.resolve(recovery);
      return;
    }
    stoppingChatIdsRef.current.add(chatId);
    setStoppingChatIds((current) => new Set(current).add(chatId));
    const streamScopeKey = streamScopeKeyForChatId(chatId);
    const streamKey = frozenDraft?.streamKey ?? null;
    if (frozenDraft) {
      const ownedStream = streamOwnershipRef.current[chatId];
      const currentDraft = streamDraftsRef.current[streamScopeKey];
      if (
        (!ownedStream || ownedStream.streamKey === streamKey)
        && (!currentDraft || currentDraft.streamKey === streamKey)
      ) {
        stopRecoveryStreamKeysRef.current[chatId] = streamKey!;
      }
      setStreamDraftForChat(streamScopeKey, (current) => {
        if (current && current.streamKey !== frozenDraft.streamKey) return current;
        return { ...frozenDraft, state: "stopping" };
      });
    }
    let stopActionSettled = false;
    void (async () => {
      try {
        if (recoveryToSubmit.executionAuthority !== "legacy_ts" && !hasCompleteNativeStopFence(request)) {
          const generationId = request.expectedGenerationId ?? frozenDraft?.generationId ?? null;
          const attemptEpoch = request.expectedAttemptEpoch ?? frozenDraft?.attemptEpoch ?? null;
          let control: Awaited<ReturnType<typeof chatsApi.readNativeChatControl>> | null = null;
          const abandonObsoleteRecovery = async () => {
            stopRecoveryRetrier.resolve(recoveryToSubmit);
            stopActionSettled = true;
            clearPendingChatStopRecovery(orgId, chatId, request.controlActionId);
            if (frozenDraft && stopRecoveryMatchesCurrentStream(recoveryToSubmit)) {
              setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === frozenDraft.streamKey
                ? { ...frozenDraft, state: recovery.previousStreamState ?? "streaming" }
                : current);
              delete stopRecoveryStreamKeysRef.current[chatId];
            }
            await Promise.allSettled([
              queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(orgId, chatId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(orgId, chatId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(orgId, chatId) }),
            ]);
            pushToast({
              title: "Stop needs a fresh confirmation",
              id: stopToastId,
              body: CHAT_STOP_REQUIRES_FRESH_ACTION_MESSAGE,
              tone: "warn",
            });
          };
          if (generationId && attemptEpoch) {
            try {
              control = await chatsApi.readNativeChatControl(chatId, orgId, generationId);
            } catch {
              // An old incomplete request cannot be safely replayed when its
              // original target cannot be revalidated after reopening.
            }
          }
          const hydratedRecovery = hydrateIncompleteNativeChatStopRecovery(
            recoveryToSubmit,
            control,
            EMPTY_CHAT_BODY_SHA256,
          );
          if (!hydratedRecovery) {
            await abandonObsoleteRecovery();
            return;
          }
          recoveryToSubmit = hydratedRecovery;
          request = hydratedRecovery.request;
          if (!savePendingChatStopRecovery(recoveryToSubmit)) {
            throw new Error("The saved Stop request could not be refreshed safely.");
          }
        }
        const result = await chatsApi.stopMessageStream(chatId, request);
        const nativeStop = recoveryToSubmit.executionAuthority !== "legacy_ts";
        const acknowledgedActionId = nativeStop ? result.controlActionId : result.controlActionId ?? request.controlActionId;
        if (acknowledgedActionId !== request.controlActionId
          || (nativeStop && (!request.expectedGenerationId || result.generationId !== request.expectedGenerationId))) {
          stopRecoveryRetrier.schedule(recoveryToSubmit);
          pushToast({
            title: "Stop confirmation pending",
            id: stopToastId,
            body: "Rudder did not confirm this exact Stop action and response; the original action will be retried.",
            tone: "warn",
          });
          return;
        }
        if (nativeStop && result.disposition === "control_lost") {
          stopRecoveryRetrier.resolve(recoveryToSubmit);
          stopActionSettled = true;
          setConfirmedOwnerLoss({
            orgId,
            chatId,
            generationId: result.generationId!,
            recoveryReadUpdatedAt: nativeRecoveryQuery.dataUpdatedAt,
          });
          if (streamKey) ownerLostStopStreamKeysRef.current.add(streamKey);
          const mutationId = recoveryToSubmit.sendMutationIdentity?.kind === "chat_send"
            ? recoveryToSubmit.sendMutationIdentity.mutation.clientMutationId
            : null;
          const inputSettled = await settleStoppedChatInput(recoveryToSubmit);
          if (inputSettled) {
            setChatSendRecovery((current) => current?.orgId === orgId
              && current.conversationId === chatId
              && (!mutationId || current.clientMutationId === mutationId) ? null : current);
          }
          clearPendingChatStopRecovery(orgId, chatId, request.controlActionId);
          if (inputSettled && recoveryToSubmit.sendMutationIdentity?.kind === "native_first_send") {
            recoveryDiscovery.clearRecovery();
          }
          if (streamKey && stopRecoveryMatchesCurrentStream(recoveryToSubmit)) {
            abortChatStream(streamScopeKey);
            setStreamDraftForChat(streamScopeKey, (current) => (
              current?.streamKey === streamKey ? null : current
            ));
            setChatSendInFlight(streamScopeKey, false);
          }
          if (stopRecoveryStreamKeysRef.current[chatId] === streamKey) {
            delete stopRecoveryStreamKeysRef.current[chatId];
          }
          await Promise.allSettled([
            queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(orgId, chatId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.queue(orgId, chatId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.nativeRecovery(orgId, chatId) }),
          ]);
          dismissToast(stopToastId);
          pushToast({
            title: "Run interrupted",
            body: CHAT_STOP_OWNER_LOST_MESSAGE,
            tone: "warn",
          });
          return;
        }
        // Old persisted recovery records have no authority marker. Treat them
        // fail-closed like Native Stop: a cutoff ACK alone cannot prove that
        // an earlier provider actually stopped.
        const cutoffAccepted = result.stopped || [
          "stopping",
          "stop_requested",
          "stopped",
          "interrupted_unverified",
        ].includes(result.disposition ?? "");
        const completionCommitted = !result.stopped && result.disposition === "completion_committed";
        const stopped = result.stopped
          && (!nativeStop || result.disposition === "stopped");
        const alreadyTerminal = !result.stopped && result.disposition === "no_active_generation";
        const terminalConfirmed = nativeStop
          ? stopped || completionCommitted || alreadyTerminal
          : result.stopped || completionCommitted || alreadyTerminal || cutoffAccepted;

        if (nativeStop && !terminalConfirmed) {
          if (cutoffAccepted && stopRecoveryMatchesCurrentStream(recoveryToSubmit)) {
            abortChatStream(streamScopeKey);
            setStreamDraftForChat(streamScopeKey, (current) => (
              current?.streamKey === streamKey ? { ...current, state: "stopping" } : current
            ));
          }
          stopRecoveryRetrier.schedule(recoveryToSubmit);
          if (!result.idempotent) {
            pushToast({
              title: "Stop confirmation pending",
              id: stopToastId,
              body: "Rudder recorded the Stop request. The response stays frozen until its terminal state is confirmed.",
              tone: "warn",
            });
          }
          return;
        }

        if (nativeStop && !await settleStoppedChatInput(recoveryToSubmit)) {
          stopRecoveryRetrier.schedule(recoveryToSubmit);
          pushToast({
            title: "Stop confirmed; send recovery is still pending",
            body: "The stopped response is confirmed, but the exact send identity could not be settled in browser storage. Rudder will retry safely.",
            tone: "warn",
          });
          return;
        }

        if (nativeStop) {
          const mutationId = recoveryToSubmit.sendMutationIdentity?.kind === "chat_send"
            ? recoveryToSubmit.sendMutationIdentity.mutation.clientMutationId : null;
          setChatSendRecovery((current) => current?.orgId === orgId
            && current.conversationId === chatId
            && current.clientMutationId === mutationId ? null : current);
          if (selectedOrganizationId === orgId && selectedConversation?.id === chatId) {
            recoveryDiscovery.clearRecovery();
            recoveryDiscovery.retry();
          }
          if (stopped) setConfirmedStoppedChat({ orgId, chatId });
        }
        stopRecoveryRetrier.resolve(recoveryToSubmit);
        stopActionSettled = true;
        if ((cutoffAccepted || alreadyTerminal) && stopRecoveryMatchesCurrentStream(recoveryToSubmit)) {
          abortChatStream(streamScopeKey);
        } else if (streamKey && stopRecoveryStreamKeysRef.current[chatId] === streamKey) {
          delete stopRecoveryStreamKeysRef.current[chatId];
        }
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chats.messages(orgId, chatId),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chats.queue(orgId, chatId),
        });
        void Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(orgId, chatId) }),
        ]);
        if (streamKey && stopRecoveryMatchesCurrentStream(recoveryToSubmit)) {
          setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey ? null : current);
          setChatSendInFlight(streamScopeKey, false);
        }
        const cleared = clearPendingChatStopRecovery(orgId, chatId, request.controlActionId);
        const remainingRecovery = readPendingChatStopRecovery(orgId, chatId);
        if (!cleared && remainingRecovery?.request.controlActionId === request.controlActionId) {
          stopActionSettled = false;
          stopRecoveryRetrier.schedule(recoveryToSubmit);
          return;
        }

        dismissToast(stopToastId);
        pushToast({
          title: completionCommitted
            ? "Response completed"
            : stopped
            ? "Response stopped"
            : alreadyTerminal
              ? "Response already ended"
              : cutoffAccepted
                ? "Response frozen"
              : "No active response",
          body: completionCommitted
            ? "The final response committed before Stop reached the cutoff."
            : stopped
              ? nativeStop
                ? "Rudder confirmed that the response stopped."
                : "Rudder interrupted the current reply."
              : alreadyTerminal
                ? "The response had already reached a terminal state."
              : cutoffAccepted
                ? "Visible output is frozen; runtime termination could not be independently confirmed."
                : "No active response was found.",
          tone: stopped || completionCommitted ? "info" : "warn",
        });
      } catch (error) {
        const definitivelyRejected = error instanceof ApiError
          && error.status >= 400
          && error.status < 500;
        const nativeStop = recoveryToSubmit.executionAuthority !== "legacy_ts";
        if (definitivelyRejected && !nativeStop) {
          stopRecoveryRetrier.resolve(recoveryToSubmit);
          stopActionSettled = true;
          if (streamKey && stopRecoveryMatchesCurrentStream(recoveryToSubmit)) {
            setStreamDraftForChat(streamScopeKey, (current) => current?.streamKey === streamKey
              ? { ...frozenDraft!, state: recoveryToSubmit.previousStreamState ?? "streaming" }
              : current);
          }
          if (streamKey && stopRecoveryStreamKeysRef.current[chatId] === streamKey) {
            delete stopRecoveryStreamKeysRef.current[chatId];
          }
          clearPendingChatStopRecovery(orgId, chatId, request.controlActionId);
        } else {
          stopRecoveryRetrier.schedule(recoveryToSubmit);
        }
        pushToast({
          title: definitivelyRejected && !nativeStop ? "Stop was rejected" : "Stop confirmation pending",
          id: stopToastId,
          body: definitivelyRejected && !nativeStop
            ? CHAT_STOP_REJECTED_MESSAGE
            : CHAT_STOP_CONFIRMATION_PENDING_MESSAGE,
          tone: definitivelyRejected && !nativeStop ? "error" : "warn",
        });
      } finally {
        setStoppingChatIds((current) => {
          if (!current.has(chatId)) return current;
          const next = new Set(current);
          next.delete(chatId);
          return next;
        });
        stoppingChatIdsRef.current.delete(chatId);
        const retryImmediately = stopRecoveryImmediateRetryKeysRef.current.delete(actionKey)
          && !stopActionSettled;
        const pendingRecovery = retryImmediately
          ? readPendingChatStopRecovery(orgId, chatId) ?? recoveryToSubmit
          : null;
        if (pendingRecovery?.request.controlActionId === request.controlActionId) {
          stopRecoveryRetrier.retryNow(pendingRecovery);
        }
      }
    })();
  }, [abortChatStream, dismissToast, pushToast, queryClient, selectedConversation?.id, selectedOrganizationId, recoveryDiscovery.clearRecovery, recoveryDiscovery.retry, setChatSendInFlight, setStreamDraftForChat, stopRecoveryMatchesCurrentStream, stopRecoveryRetrier, streamScopeKeyForChatId]);
}
