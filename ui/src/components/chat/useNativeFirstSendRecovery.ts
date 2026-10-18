import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatsApi,
  type NativeFirstSendInput,
  type NativeFirstSendReconciliation,
  type NativeChatCapabilities,
} from "@/api/chats";
import {
  prepareNativeFirstSendIntent,
  readNativeFirstSendIntent,
  updateNativeFirstSendIntent,
  type NativeFirstSendDraft,
  type NativeFirstSendIntent,
} from "@/lib/native-chat-first-send-storage";

export type NativeFirstSendRecoveryView =
  | { kind: "idle" }
  | { kind: "checking" }
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
    setRecoveryState({ kind: "blocked", message: "The first message is being admitted.", intent: result.intent });
    return requestFromIntent(result.intent);
  }, [check, ensureCapabilities, orgId, setRecoveryState, userId]);

  const markUnknown = useCallback(async (clientMutationId: string) => {
    const intent = await updateNativeFirstSendIntent(orgId!, userId!, clientMutationId, "unknown");
    setRecoveryState({ kind: "blocked", message: "The first message may have been accepted. Check its status before retrying.", intent });
  }, [orgId, setRecoveryState, userId]);

  const markAccepted = useCallback(async (clientMutationId: string, conversationId: string) => {
    const intent = await updateNativeFirstSendIntent(orgId!, userId!, clientMutationId, "accepted", conversationId);
    setRecoveryState({ kind: "blocked", message: "The first message was accepted by Native Chat.", intent });
  }, [orgId, setRecoveryState, userId]);

  const markSettled = useCallback(async (clientMutationId: string, conversationId: string) => {
    // A direct stream acknowledgement records accepted before a terminal event
    // can settle the identity. Reconciliation may already have done that step.
    const current = readNativeFirstSendIntent(orgId!, userId!);
    if (current?.clientMutationId === clientMutationId && current.status !== "accepted" && current.status !== "settled") {
      await updateNativeFirstSendIntent(orgId!, userId!, clientMutationId, "accepted", conversationId);
    }
    await updateNativeFirstSendIntent(orgId!, userId!, clientMutationId, "settled", conversationId);
    setRecoveryState({ kind: "idle" });
  }, [orgId, setRecoveryState, userId]);

  const retry = useCallback(async () => {
    await check();
  }, [check]);

  const openAccepted = useCallback(async () => {
    if (recovery.kind !== "accepted") return null;
    const intent = await updateNativeFirstSendIntent(
      orgId!,
      userId!,
      recovery.intent.clientMutationId,
      "settled",
      recovery.receipt.conversation.id,
    );
    setRecoveryState({ kind: "idle" });
    return { intent, receipt: recovery.receipt };
  }, [orgId, recovery, setRecoveryState, userId]);

  const retryOriginal = useCallback(async () => {
    if (recovery.kind !== "not_found") return null;
    const intent = await updateNativeFirstSendIntent(
      orgId!,
      userId!,
      recovery.intent.clientMutationId,
      "pending",
    );
    setRecoveryState({ kind: "blocked", message: "Retrying the exact saved first message.", intent });
    return requestFromIntent(recovery.intent);
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
