import {
  chatsApi,
  type NativeChatCapabilities,
  type NativeFirstSendInput,
  type NativeFirstSendReconciliation,
} from "@/api/chats";
import { seedAcceptedChatSendMutation } from "@/lib/chat-send-mutation-storage";
import {
  prepareNativeFirstSendIntent,
  readNativeFirstSendIntent,
  updateNativeFirstSendIntent,
  type NativeFirstSendDraft,
  type NativeFirstSendIntent,
} from "@/lib/native-chat-first-send-storage";
import { useCallback, useEffect, useRef, useState } from "react";

export type NativeFirstSendRecoveryView =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "sending" }
  | { kind: "blocked"; message: string; intent?: NativeFirstSendIntent }
  | { kind: "not_found"; intent: NativeFirstSendIntent }
  | { kind: "accepted"; intent: NativeFirstSendIntent; receipt: Extract<NativeFirstSendReconciliation, { outcome: "accepted" }> };

function requestFromIntent(intent: NativeFirstSendIntent): NativeFirstSendInput {
  return {
    ...intent.draft,
    clientMutationId: intent.clientMutationId,
  };
}

export function useNativeFirstSendRecovery(
  orgId: string | null | undefined,
  userId: string | null | undefined,
  enabled: boolean,
) {
  const [capabilities, setCapabilities] = useState<NativeChatCapabilities | null>(null);
  const [capabilityState, setCapabilityState] = useState<"checking" | "ready" | "error">("checking");
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<NativeFirstSendRecoveryView>({ kind: "checking" });
  const recoveryRef = useRef<NativeFirstSendRecoveryView>({ kind: "checking" });
  const capabilityRef = useRef<NativeChatCapabilities | null>(null);
  const capabilityStateRef = useRef<"checking" | "ready" | "error">("checking");
  const capabilityErrorRef = useRef<string | null>(null);
  const checkPromiseRef = useRef<{ scopeKey: string; promise: Promise<void> } | null>(null);
  const scopeRef = useRef("");

  const scopeKey = enabled && orgId && userId ? `${orgId}:${userId}` : "";

  const setRecoveryState = useCallback((value: NativeFirstSendRecoveryView) => {
    recoveryRef.current = value;
    setRecovery(value);
  }, []);

  const check = useCallback((): Promise<void> => {
    if (!scopeKey || !orgId || !userId) {
      capabilityRef.current = null;
      capabilityStateRef.current = "ready";
      capabilityErrorRef.current = null;
      setCapabilities(null);
      setCapabilityState("ready");
      setCapabilityError(null);
      setRecoveryState({ kind: "idle" });
      return Promise.resolve();
    }
    if (checkPromiseRef.current?.scopeKey === scopeKey) return checkPromiseRef.current.promise;
    scopeRef.current = scopeKey;

    const task = (async () => {
      setRecoveryState({ kind: "checking" });
      capabilityRef.current = null;
      setCapabilityState("checking");
      capabilityStateRef.current = "checking";
      capabilityErrorRef.current = null;
      setCapabilityError(null);

      let intent: NativeFirstSendIntent | null = null;
      let storageError: unknown = null;
      try {
        intent = readNativeFirstSendIntent(orgId, userId);
      } catch (error) {
        storageError = error;
      }

      let capabilityResolved = false;
      try {
        const discovered = await chatsApi.getNativeChatCapabilities();
        if (scopeRef.current !== scopeKey) return;
        capabilityResolved = true;
        capabilityRef.current = discovered;
        setCapabilities(discovered);
        setCapabilityState("ready");
        capabilityStateRef.current = "ready";

        if (storageError) {
          const message = storageError instanceof Error
            ? storageError.message
            : "Saved first-message state could not be checked. Sending is paused.";
          capabilityErrorRef.current = message;
          setCapabilityError(message);
          setRecoveryState({ kind: "blocked", message, ...(intent ? { intent } : {}) });
          return;
        }
        if (!intent || intent.status === "settled") {
          setRecoveryState({ kind: "idle" });
          return;
        }
        if (!discovered?.firstSend) {
          const message = "A Native Chat first message is still awaiting reconciliation, but this server cannot confirm Native Chat ownership. Do not send it through another path.";
          setRecoveryState({ kind: "blocked", message, intent });
          return;
        }

        const receipt = await chatsApi.reconcileNativeFirstSend(orgId, requestFromIntent(intent));
        if (scopeRef.current !== scopeKey) return;
        if (receipt.clientMutationId !== intent.clientMutationId) {
          throw new Error("Native Chat returned a different first-message identity. Recovery is paused.");
        }
        if (receipt.outcome === "accepted") {
          if (receipt.message.body !== intent.draft.body) {
            throw new Error("Native Chat returned a different accepted message body. Recovery is paused.");
          }
          await seedAcceptedChatSendMutation({
            orgId,
            conversationId: receipt.conversation.id,
            clientMutationId: intent.clientMutationId,
            body: intent.draft.body,
            modelOverride: intent.draft.modelOverride,
            effortOverride: intent.draft.effortOverride,
          });
          const accepted = await updateNativeFirstSendIntent(
            orgId,
            userId,
            intent.clientMutationId,
            "accepted",
            receipt.conversation.id,
          );
          if (scopeRef.current === scopeKey) setRecoveryState({ kind: "accepted", intent: accepted, receipt });
          return;
        }
        const notFound = await updateNativeFirstSendIntent(
          orgId,
          userId,
          intent.clientMutationId,
          "not_found",
        );
        if (scopeRef.current === scopeKey) setRecoveryState({ kind: "not_found", intent: notFound });
      } catch (error) {
        if (scopeRef.current !== scopeKey) return;
        if (intent && intent.status !== "accepted" && intent.status !== "settled") {
          await updateNativeFirstSendIntent(orgId, userId, intent.clientMutationId, "unknown").catch(() => undefined);
        }
        const message = error instanceof Error
          ? error.message
          : "Native Chat could not confirm the previous first message. Sending is paused.";
        if (!capabilityResolved) {
          capabilityRef.current = null;
          capabilityErrorRef.current = message;
          capabilityStateRef.current = "error";
          setCapabilityState("error");
        }
        setCapabilityError(message);
        setRecoveryState({ kind: "blocked", message, ...(intent ? { intent } : {}) });
      }
    })();

    let trackedTask: Promise<void>;
    trackedTask = task.finally(() => {
      if (checkPromiseRef.current?.promise === trackedTask) checkPromiseRef.current = null;
    });
    checkPromiseRef.current = { scopeKey, promise: trackedTask };
    return trackedTask;
  }, [orgId, scopeKey, setRecoveryState, userId]);

  useEffect(() => {
    scopeRef.current = scopeKey;
    if (!scopeKey) {
      capabilityRef.current = null;
      capabilityStateRef.current = "ready";
      capabilityErrorRef.current = null;
      setCapabilities(null);
      setCapabilityState("ready");
      setCapabilityError(null);
      setRecoveryState({ kind: "idle" });
      return;
    }
    void check();
    return () => {
      if (scopeRef.current === scopeKey) scopeRef.current = "";
    };
  }, [check, scopeKey, setRecoveryState]);

  const ensureCapabilities = useCallback(async () => {
    if (!scopeKey || !orgId || !userId) throw new Error("Select an organization and sign in before sending.");
    if (capabilityStateRef.current === "ready") return capabilityRef.current;
    await check();
    const stateAfterCheck: string = capabilityStateRef.current;
    if (stateAfterCheck !== "ready") {
      throw new Error(capabilityErrorRef.current ?? capabilityError ?? "Native Chat capability could not be confirmed. Sending is paused.");
    }
    return capabilityRef.current;
  }, [capabilityError, check, orgId, scopeKey, userId]);

  const prepare = useCallback(async (draft: NativeFirstSendDraft) => {
    const discovered = await ensureCapabilities();
    // Never choose the legacy route while an earlier Native identity is
    // unresolved, even if the currently selected ingress has changed.
    const previous = readNativeFirstSendIntent(orgId!, userId!);
    if (previous && previous.status !== "settled") {
      throw new Error("A previous first message must be reconciled before sending another.");
    }
    if (!discovered?.firstSend) return null;
    if (recoveryRef.current.kind !== "idle") {
      throw new Error(recoveryRef.current.kind === "blocked"
        ? recoveryRef.current.message
        : "A previous first message must be reconciled before sending another.");
    }
    const result = await prepareNativeFirstSendIntent(orgId!, userId!, draft);
    if (!result.created) {
      await check();
      throw new Error("A previous first message is already saved. Check its status before sending another.");
    }
    setRecoveryState({ kind: "sending" });
    return requestFromIntent(result.intent);
  }, [check, ensureCapabilities, orgId, setRecoveryState, userId]);

  const markUnknown = useCallback(async (clientMutationId: string) => {
    const intent = await updateNativeFirstSendIntent(orgId!, userId!, clientMutationId, "unknown");
    setRecoveryState({ kind: "blocked", message: "The first message may have been accepted. Check its status before retrying.", intent });
  }, [orgId, setRecoveryState, userId]);

  const markAccepted = useCallback(async (clientMutationId: string, conversationId: string) => {
    const intent = await updateNativeFirstSendIntent(orgId!, userId!, clientMutationId, "accepted", conversationId);
    const identity = await seedAcceptedChatSendMutation({
      orgId: orgId!,
      conversationId,
      clientMutationId,
      body: intent.draft.body,
      modelOverride: intent.draft.modelOverride,
      effortOverride: intent.draft.effortOverride,
    });
    if (scopeRef.current === scopeKey) {
      setRecoveryState({ kind: "sending" });
    }
    return identity;
  }, [orgId, scopeKey, setRecoveryState, userId]);

  const markSettled = useCallback(async (clientMutationId: string, conversationId: string) => {
    const current = readNativeFirstSendIntent(orgId!, userId!);
    // A late terminal callback must never settle a newer New Chat identity.
    // The global slot is only a fallback for attempts that were not handed off.
    if (!current || current.clientMutationId !== clientMutationId
      || current.conversationId !== conversationId) return;
    if (current.status === "settled") {
      if (scopeRef.current === scopeKey) setRecoveryState({ kind: "idle" });
      return;
    }
    if (current.status !== "accepted") return;
    await updateNativeFirstSendIntent(orgId!, userId!, clientMutationId, "settled", conversationId);
    if (scopeRef.current === scopeKey) setRecoveryState({ kind: "idle" });
  }, [orgId, scopeKey, setRecoveryState, userId]);

  const retry = useCallback(async () => {
    await check();
  }, [check]);

  const openAccepted = useCallback(async () => {
    if (recovery.kind !== "accepted") return null;
    if (scopeRef.current !== scopeKey) return null;
    await seedAcceptedChatSendMutation({
      orgId: orgId!,
      conversationId: recovery.receipt.conversation.id,
      clientMutationId: recovery.intent.clientMutationId,
      body: recovery.intent.draft.body,
      modelOverride: recovery.intent.draft.modelOverride,
      effortOverride: recovery.intent.draft.effortOverride,
    });
    if (scopeRef.current !== scopeKey) return null;
    const intent = await updateNativeFirstSendIntent(
      orgId!,
      userId!,
      recovery.intent.clientMutationId,
      "settled",
      recovery.receipt.conversation.id,
    );
    if (scopeRef.current === scopeKey) setRecoveryState({ kind: "idle" });
    return { intent, receipt: recovery.receipt };
  }, [orgId, recovery, scopeKey, setRecoveryState, userId]);

  const retryOriginal = useCallback(async () => {
    if (recovery.kind !== "not_found") return null;
    const intent = await updateNativeFirstSendIntent(
      orgId!,
      userId!,
      recovery.intent.clientMutationId,
      "pending",
    );
    setRecoveryState({ kind: "sending" });
    return requestFromIntent(intent);
  }, [orgId, recovery, setRecoveryState, userId]);

  return {
    capabilities,
    capabilityState,
    capabilityError,
    recovery,
    check,
    ensureCapabilities,
    prepare,
    markUnknown,
    markAccepted,
    markSettled,
    retry,
    openAccepted,
    retryOriginal,
  };
}
