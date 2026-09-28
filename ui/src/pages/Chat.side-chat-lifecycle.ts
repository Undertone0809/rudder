import { chatsApi } from "@/api/chats";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { getTerminalSideChatCloseStatus } from "@/lib/side-chat-close";
import { reconcileSideChatCloseCache } from "@/lib/side-chat-close-cache";
import { cacheKeptSideChat } from "@/lib/side-chat-history-cache";
import { clearSideChatSendDraft } from "@/lib/side-chat-draft-storage";
import {
  sideChatGenerationScopeKey,
  sidePanelTargetKey,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { useLocation, useNavigate } from "@/lib/router";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "@/lib/organization-routes";
import { useSidePanel } from "@/context/SidePanelContext";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

export function useChatSideChatLifecycle(organizationId: string | null | undefined) {
  const sidePanel = useSidePanel();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [closingSideChatKeys, setClosingSideChatKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [movingSideChatKey, setMovingSideChatKey] = useState<string | null>(null);
  const sideChatCloseHandlersRef = useRef(new Map<string, () => Promise<string | null>>());
  const closingSideChatKeysRef = useRef(new Set<string>());
  const movingSideChatKeyRef = useRef<string | null>(null);

  const registerSideChatCloseHandler = useCallback((
    scopeKey: string,
    handler: (() => Promise<string | null>) | null,
  ) => {
    if (handler) sideChatCloseHandlersRef.current.set(scopeKey, handler);
    else sideChatCloseHandlersRef.current.delete(scopeKey);
  }, []);

  const closeSideChatTab = async (tab: SideChatTarget) => {
    const tabKey = sidePanelTargetKey(tab);
    if (movingSideChatKeyRef.current === tabKey) return;
    if (closingSideChatKeysRef.current.has(tabKey)) return;
    closingSideChatKeysRef.current.add(tabKey);
    setClosingSideChatKeys(new Set(closingSideChatKeysRef.current));
    const registeredClose = sideChatCloseHandlersRef.current.get(
      sideChatGenerationScopeKey(organizationId ?? "__none__", tab),
    );
    const reconcileCloseCache = (conversationId: string, status?: 404 | 409 | 410) => {
      reconcileSideChatCloseCache(queryClient, {
        organizationId: organizationId ?? "__none__",
        messengerOrganizationId: organizationId ?? null,
        conversationId,
        target: tab,
        principalId: sidePanel.principalId ?? null,
        status,
        refreshHistory: !registeredClose,
      });
    };
    const clearDraft = () => {
      if (!organizationId) return;
      clearSideChatSendDraft(
        sidePanel.principalId ?? null,
        organizationId,
        tab.sourceConversationId,
        tab.clientMutationId,
      );
    };
    try {
      const destroyedConversationId = registeredClose
        ? await registeredClose()
        : tab.conversationId
          ? await chatsApi.destroySideChat(tab.conversationId).then(() => tab.conversationId)
          : null;
      clearDraft();
      if (destroyedConversationId) reconcileCloseCache(destroyedConversationId);
      sidePanel.closeTarget(tabKey);
      if (destroyedConversationId && destroyedConversationId !== tab.conversationId) {
        sidePanel.closeTarget(sidePanelTargetKey({ ...tab, conversationId: destroyedConversationId }));
      }
    } catch (error) {
      if (error instanceof Error && error.name === "ChatGenerationCloseSupersededError") return;
      const terminalStatus = getTerminalSideChatCloseStatus(error);
      if (terminalStatus !== null) {
        clearDraft();
        if (tab.conversationId) reconcileCloseCache(tab.conversationId, terminalStatus);
        sidePanel.closeTarget(tabKey);
        return;
      }
      pushToast({
        title: "Could not close Side Chat",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    } finally {
      closingSideChatKeysRef.current.delete(tabKey);
      setClosingSideChatKeys(new Set(closingSideChatKeysRef.current));
    }
  };

  const moveSideChatMutation = useMutation({
    mutationFn: (tab: SideChatTarget) => chatsApi.keepSideChat(tab.conversationId!),
    onSuccess: (updated, tab) => {
      void cacheKeptSideChat(
        queryClient,
        updated,
        organizationId ?? "__none__",
        tab.sourceConversationId,
        sidePanel.principalId,
      );
      void queryClient.invalidateQueries({ queryKey: ["messenger", organizationId] });
      sidePanel.closeTarget(sidePanelTargetKey(tab));
      pushToast({
        title: "Moved to Messenger",
        body: "This is now a normal Messenger chat.",
        tone: "success",
      });
      const prefix = extractOrganizationPrefixFromPath(location.pathname);
      navigate(applyOrganizationPrefix(`/messenger/chat/${updated.id}`, prefix));
    },
    onError: (error, tab) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chats.detail(
          organizationId ?? "__none__",
          tab.conversationId ?? "__side-chat-draft__",
        ),
      });
      pushToast({
        title: "Could not move Side Chat",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const moveSideChatToMessenger = (tab: SideChatTarget) => {
    const tabKey = sidePanelTargetKey(tab);
    if (movingSideChatKeyRef.current || closingSideChatKeysRef.current.has(tabKey)) return;
    movingSideChatKeyRef.current = tabKey;
    setMovingSideChatKey(tabKey);
    void moveSideChatMutation.mutateAsync(tab)
      .catch(() => undefined)
      .finally(() => {
        if (movingSideChatKeyRef.current !== tabKey) return;
        movingSideChatKeyRef.current = null;
        setMovingSideChatKey(null);
      });
  };

  return {
    closeSideChatTab,
    closingSideChatKeys,
    movingSideChatKey,
    moveSideChatToMessenger,
    registerSideChatCloseHandler,
  };
}
