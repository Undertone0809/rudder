import type { ChatConversation } from "@rudderhq/shared";
import { stopChatGenerationSchema } from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import { conflict } from "../errors.js";
import {
  cancelActiveChatGeneration,
  getActiveChatGeneration,
} from "../services/chat-generation-locks.js";
import {
  startingChatGenerationGates,
  type ChatStreamRouteContext,
} from "./chats.stream-support.js";

export function registerChatStopRoute(ctx: ChatStreamRouteContext) {
  const {
    router,
    svc,
    assertConversationAccess,
    assertChatLocalMutationAllowed,
    assertSideChatMutationAllowed,
    wakeTerminalProjector,
  } = ctx;

  router.post("/chats/:id/messages/stream/stop", async (req, res) => {
    const parsed = stopChatGenerationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid chat Stop request", details: parsed.error.issues });
      return;
    }
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);

    const controlActionId = parsed.data.controlActionId ?? randomUUID();
    const startupGate = startingChatGenerationGates.get(conversation.id) ?? null;
    let startupStopRequested = false;
    let startupInterruptRequested = false;
    try {
      let active = getActiveChatGeneration(conversation.id);
      if (active && !active.generationId && startupGate) {
        startupStopRequested = true;
        startupGate.stopRequested = true;
        startupInterruptRequested = cancelActiveChatGeneration(conversation.id);
        const startupGenerationId = await startupGate.generationReady;
        active = startupGenerationId ? getActiveChatGeneration(conversation.id) : null;
        if (!startupGenerationId) {
          res.json({
            stopped: startupInterruptRequested,
            controlActionId,
            generationId: null,
            disposition: startupInterruptRequested ? "startup_cancelled" : "interrupted_unverified",
          });
          return;
        }
      }
      const latestActiveGeneration = active?.generationId
        ? null
        : await svc.getLatestActiveGeneration(conversation.id);
      const generationId = parsed.data.expectedGenerationId
        ?? active?.generationId
        ?? latestActiveGeneration?.id
        ?? null;
      if (!generationId) {
        res.json({
          stopped: false,
          controlActionId,
          generationId: null,
          disposition: "no_active_generation",
        });
        return;
      }

      let durableCheckpoint = await svc.generationProtocol.getLatestVisibleCheckpoint({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        generationId,
      });
      if (durableCheckpoint.generation.runtimeTerminalAt && !parsed.data.controlActionId) {
        wakeTerminalProjector();
        res.json({
          stopped: false,
          controlActionId,
          generationId,
          disposition: "no_active_generation",
        });
        return;
      }
      const expectedAttemptEpoch = parsed.data.expectedAttemptEpoch
        ?? durableCheckpoint.generation.attemptEpoch;
      const requestedControlVersion = parsed.data.expectedControlVersion
        ?? durableCheckpoint.generation.controlVersion;
      const requestedRenderSeq = parsed.data.lastCommittedRenderSeq
        ?? durableCheckpoint.generationSeq;
      const requestedBodyHash = parsed.data.renderedBodyHash
        ?? durableCheckpoint.bodyHash;
      let stop: Awaited<ReturnType<typeof svc.generationProtocol.beginStopAction>> | null = null;
      for (let attempt = 0; attempt < 2 && !stop; attempt += 1) {
        try {
          stop = await svc.generationProtocol.beginStopAction({
            orgId: conversation.orgId,
            conversationId: conversation.id,
            controlActionId,
            expectedGenerationId: generationId,
            expectedAttemptEpoch,
            expectedControlVersion: requestedControlVersion,
            admissionControlVersion: attempt === 0
              ? requestedControlVersion
              : durableCheckpoint.generation.controlVersion,
            requestedRenderSeq,
            requestedBodyHash,
          });
        } catch (error) {
          const status = error && typeof error === "object" && "status" in error
            ? Number((error as { status?: unknown }).status)
            : null;
          if (attempt > 0 || status !== 409) throw error;
          durableCheckpoint = await svc.generationProtocol.getLatestVisibleCheckpoint({
            orgId: conversation.orgId,
            conversationId: conversation.id,
            generationId,
          });
          if (durableCheckpoint.generation.runtimeTerminalAt && !parsed.data.controlActionId) {
            wakeTerminalProjector();
            res.json({
              stopped: false,
              controlActionId,
              generationId,
              disposition: "no_active_generation",
            });
            return;
          }
          if (durableCheckpoint.generation.attemptEpoch !== expectedAttemptEpoch) throw error;
        }
      }
      if (!stop) throw new Error("Failed to establish the chat Stop cutoff");
      const wasWaitingForNetwork = durableCheckpoint.generation.status === "waiting_for_network";
      if (
        stop.idempotent
        && parsed.data.expectedControlVersion !== undefined
        && stop.action.expectedControlVersion !== parsed.data.expectedControlVersion
      ) {
        throw conflict("Control action id was already used for a different Stop request");
      }

      if (stop.outcome === "completion_committed") {
        res.json({
          stopped: false,
          controlActionId,
          generationId,
          disposition: "completion_committed",
        });
        return;
      }

      if (stop.outcome === "already_terminal") {
        const alreadyStopped = stop.generation.status === "stopped"
          || stop.action.localDisposition === "stopped";
        wakeTerminalProjector();
        res.json({
          stopped: alreadyStopped,
          controlActionId,
          generationId,
          disposition: alreadyStopped ? "stopped" : "no_active_generation",
          acceptedThroughSeq: stop.action.acceptedThroughSeq,
          frozenBodyHash: stop.action.frozenBodyHash,
        });
        return;
      }

      if (stop.outcome === "stop_in_progress" && !stop.generation.runtimeTerminalAt) {
        const localInterruptRequested = startupInterruptRequested || cancelActiveChatGeneration(conversation.id);
        res.json({
          stopped: Boolean(localInterruptRequested),
          controlActionId,
          generationId,
          disposition: "stopping",
          acceptedThroughSeq: stop.action.acceptedThroughSeq,
          frozenBodyHash: stop.action.frozenBodyHash,
        });
        return;
      }

      if (stop.idempotent && stop.generation.runtimeTerminalAt) {
        const terminalDisposition = stop.generation.status === "stopped"
          || stop.action.localDisposition === "stopped"
          ? "stopped"
          : "stopping";
        wakeTerminalProjector();
        res.json({
          stopped: true,
          controlActionId,
          generationId,
          disposition: terminalDisposition,
          acceptedThroughSeq: stop.action.acceptedThroughSeq,
          frozenBodyHash: stop.action.frozenBodyHash,
        });
        return;
      }

      const localInterruptRequested = startupInterruptRequested || cancelActiveChatGeneration(conversation.id);
      let stopped = Boolean(localInterruptRequested);
      let disposition = "stopping";
      if (startupStopRequested) {
        await svc.generationProtocol.recordRuntimeTerminal({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          generationId,
          expectedAttemptEpoch: stop.generation.attemptEpoch,
          finalStatus: "stopped",
          terminalReason: "operator_stop",
          controlActionId,
        });
        wakeTerminalProjector();
      } else if (wasWaitingForNetwork) {
        stopped = true;
        disposition = "stopped";
        await svc.generationProtocol.recordRuntimeTerminal({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          generationId,
          expectedAttemptEpoch: stop.generation.attemptEpoch,
          finalStatus: "stopped",
          terminalReason: "operator_stop",
          controlActionId,
        });
        wakeTerminalProjector();
      } else if (!localInterruptRequested) {
        disposition = "interrupted_unverified";
        await svc.generationProtocol.recordRuntimeTerminal({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          generationId,
          expectedAttemptEpoch: stop.generation.attemptEpoch,
          finalStatus: "interrupted_unverified",
          terminalReason: "stop_without_local_runtime_owner",
          controlActionId,
        });
        wakeTerminalProjector();
      }
      res.json({
        stopped,
        controlActionId,
        generationId,
        disposition,
        acceptedThroughSeq: stop.action.acceptedThroughSeq,
        frozenBodyHash: stop.action.frozenBodyHash,
      });
    } finally {
      if (startupStopRequested) startupGate?.resolveStopApplied();
    }
  });
}
