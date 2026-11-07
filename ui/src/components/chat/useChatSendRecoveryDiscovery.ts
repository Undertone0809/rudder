import { chatsApi } from "@/api/chats";
import type { ChatSendRecovery } from "@/components/chat/ChatSendRecoveryNotice";
import { recoverPendingChatSendMutation } from "@/lib/chat-send-mutation-storage";
import { queryKeys } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

type Scope = { orgId: string; conversationId: string };

const RECOVERY_DISCOVERY_TIMEOUT_MS = 15_000;
type DiscoveryState = {
  scopeKey: string;
  checking: boolean;
  recovery: ChatSendRecovery | null;
  problem: string | null;
  completedNotice: string | null;
};

const EMPTY_STATE: DiscoveryState = {
  scopeKey: "",
  checking: false,
  recovery: null,
  problem: null,
  completedNotice: null,
};

function scopeKey(scope: Scope | null) {
  return scope ? JSON.stringify([scope.orgId, scope.conversationId]) : "";
}

/** Read-only discovery for the active chat. It never allocates or dispatches a send. */
export function useChatSendRecoveryDiscovery(scope: Scope | null) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<DiscoveryState>(EMPTY_STATE);
  const [retryVersion, setRetryVersion] = useState(0);
  const key = scopeKey(scope);
  const hasScope = scope !== null;

  useEffect(() => {
    if (!scope) {
      setState(EMPTY_STATE);
      return;
    }

    const activeScope = { ...scope };
    const activeKey = scopeKey(activeScope);
    const controller = new AbortController();
    let current = true;
    let timedOut = false;
    setState({ scopeKey: activeKey, checking: true, recovery: null, problem: null, completedNotice: null });
    const timeout = window.setTimeout(() => {
      if (!current || controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
      setState({
        scopeKey: activeKey,
        checking: false,
        recovery: null,
        problem: "Recovery check timed out. Your previous send is unchanged. Check again before sending.",
        completedNotice: null,
      });
    }, RECOVERY_DISCOVERY_TIMEOUT_MS);

    void recoverPendingChatSendMutation({
      orgId: activeScope.orgId,
      conversationId: activeScope.conversationId,
      signal: controller.signal,
      reconcilePendingMutation: (clientMutationId, body, signal) => chatsApi.reconcilePendingMessageSend(
        activeScope.conversationId,
        { clientMutationId, body },
        { signal },
      ),
    }).then(async (result) => {
      if (!current || controller.signal.aborted) return;
      if (!result) {
        setState((previous) => previous.scopeKey === activeKey
          ? { ...previous, checking: false }
          : previous);
        return;
      }

      if (result.reconciliation?.outcome === "accepted") {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(activeScope.orgId, activeScope.conversationId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(activeScope.orgId, activeScope.conversationId) }),
        ]).catch(() => undefined);
      }

      if (result.status === "recovered") {
        setState({
          scopeKey: activeKey,
          checking: false,
          recovery: null,
          problem: null,
          completedNotice: "The earlier message already finished. Your current draft was not sent; send it when you are ready.",
        });
        return;
      }

      setState({
        scopeKey: activeKey,
        checking: false,
        recovery: {
          clientMutationId: result.clientMutationId,
          body: result.body,
          modelOverride: result.modelOverride,
          effortOverride: result.effortOverride,
          action: result.status === "retry_required" ? "retry" : "resume",
        },
        problem: null,
        completedNotice: null,
      });
    }).catch((error: unknown) => {
      if (!current || controller.signal.aborted || timedOut) return;
      setState({
        scopeKey: activeKey,
        checking: false,
        recovery: null,
        problem: error instanceof Error
          ? error.message
          : "Rudder could not confirm the earlier send. Your draft is preserved and no new message was sent.",
        completedNotice: null,
      });
    }).finally(() => {
      window.clearTimeout(timeout);
    });

    return () => {
      current = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [key, retryVersion, queryClient, scope?.orgId, scope?.conversationId]);

  const retry = useCallback(() => {
    setState((current) => current.scopeKey === key
      ? { ...current, checking: true, problem: null }
      : current);
    setRetryVersion((version) => version + 1);
  }, [key]);
  const clearRecovery = useCallback(() => {
    setState((current) => current.scopeKey === key ? { ...current, recovery: null } : current);
  }, [key]);
  const clearCompletedNotice = useCallback(() => {
    setState((current) => current.scopeKey === key ? { ...current, completedNotice: null } : current);
  }, [key]);

  return useMemo(() => ({
    checking: hasScope && (state.scopeKey !== key || state.checking),
    recovery: state.scopeKey === key ? state.recovery : null,
    problem: state.scopeKey === key ? state.problem : null,
    completedNotice: state.scopeKey === key ? state.completedNotice : null,
    retry,
    clearRecovery,
    clearCompletedNotice,
  }), [state, hasScope, key, retry, clearRecovery, clearCompletedNotice]);
}
