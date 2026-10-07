import type { approvals, Db, organizations } from "@rudderhq/db";
import { updateOrganizationBrandingSchema } from "@rudderhq/shared";
import { createHash } from "node:crypto";
import { conflict, forbidden, HttpError, notFound, unauthorized, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { agentService } from "./agents.js";
import {
  operationProposalDecisionStatusFromPayload,
  operationProposalFromPayload,
  safeTrim,
  withOperationProposalDecisionState,
} from "./chats.helpers.js";
import { handoffOrganizationBrandingAuthority, organizationBrandingOrgIsSelected } from "./organization-branding-fence.js";
import type { organizationService } from "./orgs.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";

type ApprovalRow = typeof approvals.$inferSelect;
type OrganizationOperationProposal = NonNullable<ReturnType<typeof operationProposalFromPayload>> & {
  targetType: "organization";
};

type ChatSystemEventInput = {
  orgId: string;
  role: "system";
  kind: "system_event";
  body: string;
  structuredPayload: Record<string, unknown>;
  clientMutationId?: string;
};

type ChatSystemEventWriter<TChatMessage> = (
  conversationId: string,
  input: ChatSystemEventInput,
) => Promise<TChatMessage | undefined>;

export function createChatOrganizationBrandingService<TReadMessage, TUpdatedMessage, TAddedMessage>(input: {
  db: Db;
  organizationsSvc: ReturnType<typeof organizationService>;
  agentsSvc: ReturnType<typeof agentService>;
  bridge?: RustFoundationBridge;
  getMessage: (conversationId: string, messageId: string) => Promise<TReadMessage | null>;
  updateMessageStructuredPayload: (
    conversationId: string,
    messageId: string,
    payload: Record<string, unknown> | null,
  ) => Promise<TUpdatedMessage | null | undefined>;
  addMessage: ChatSystemEventWriter<TAddedMessage>;
}) {
  const { db, organizationsSvc, agentsSvc, bridge, getMessage, updateMessageStructuredPayload, addMessage } = input;
  const brandingFields = new Set(["brandColor", "logoAssetId"]);

  function isBrandingPatch(patch: Record<string, unknown>) {
    return Object.keys(patch).some((key) => brandingFields.has(key));
  }

  function idempotencyKey(source: "chat-proposal" | "chat-approval", sourceId: string) {
    return createHash("sha256")
      .update(`rudder.${source}.organization-branding.v1\0${sourceId}`)
      .digest("hex");
  }

  async function isRustOwned(orgId: string) {
    if (bridge?.organizationBrandingMode === "required" && organizationBrandingOrgIsSelected(orgId)) return true;
    return (await organizationsSvc.getBrandingMutationOwner(orgId)) === "rust";
  }

  async function validateForRust(validationInput: {
    orgId: string;
    patch: Record<string, unknown>;
    actor?: RustFoundationActor | null;
  }) {
    const rustOwned = isBrandingPatch(validationInput.patch) && await isRustOwned(validationInput.orgId);
    if (!rustOwned) return { rustOwned: false as const };

    if (Object.keys(validationInput.patch).some((key) => !brandingFields.has(key))) {
      throw unprocessable("Rust-owned Chat branding changes cannot be combined with other organization fields");
    }
    const parsed = updateOrganizationBrandingSchema.safeParse(validationInput.patch);
    if (!parsed.success) {
      throw unprocessable("Chat organization branding proposal did not match the branding contract", parsed.error.issues);
    }
    if (!bridge) throw conflict("Rust owns organization branding; Chat cannot fall back to the Node writer");
    const actor = validationInput.actor;
    if (!actor || actor.type === "none") {
      throw unauthorized("Authenticated actor context is required for Rust organization branding");
    }
    if (actor.type === "agent") {
      if (!actor.agentId) throw forbidden("Agent authentication required");
      const actorAgent = await agentsSvc.getById(actor.agentId);
      if (!actorAgent || actorAgent.orgId !== validationInput.orgId) {
        throw forbidden("Agent key cannot access another organization");
      }
      if (actorAgent.role !== "ceo") throw forbidden("Only CEO agents can update organization branding");
    } else if (actor.type !== "board") {
      throw forbidden("Authenticated board or CEO agent actor required for organization branding");
    }

    return { rustOwned: true as const, parsed: parsed.data, actor, bridge };
  }

  async function updateOrganizationFromChatProposal(updateInput: {
    orgId: string;
    patch: Record<string, unknown>;
    source: "chat-proposal" | "chat-approval";
    sourceId: string;
    actor?: RustFoundationActor | null;
  }) {
    const validated = await validateForRust(updateInput);
    if (!validated.rustOwned) {
      const updated = await organizationsSvc.update(
        updateInput.orgId,
        updateInput.patch as Partial<typeof organizations.$inferInsert> & { logoAssetId?: string | null },
      );
      return { updated, rustOwned: false };
    }
    const { parsed, actor, bridge: rustBridge } = validated;

    if (
      rustBridge.organizationBrandingMode === "required"
      && organizationBrandingOrgIsSelected(updateInput.orgId)
    ) {
      await handoffOrganizationBrandingAuthority(db, updateInput.orgId);
    }

    const response = await rustBridge.organizationBrandingForActor(
      actor,
      updateInput.orgId,
      Buffer.from(JSON.stringify(parsed), "utf8"),
      idempotencyKey(updateInput.source, updateInput.sourceId),
    );
    if (response.status < 200 || response.status >= 300) {
      let message = `Rust organization branding request failed with status ${response.status}`;
      try {
        const body = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
        if (typeof body.error === "string") message = body.error;
        else if (typeof body.reason === "string") message = body.reason;
      } catch {
        // Preserve the status and fail closed when Rust did not return JSON.
      }
      throw new HttpError(response.status, message);
    }
    const updated = await organizationsSvc.getById(updateInput.orgId);
    if (!updated) throw notFound("Organization not found");
    return { updated, rustOwned: true };
  }

  async function resolveOperationProposal(resolveInput: {
    conversationId: string;
    messageId: string;
    orgId: string;
    messagePayload: Record<string, unknown> | null;
    proposal: OrganizationOperationProposal;
    currentState: ReturnType<typeof operationProposalDecisionStatusFromPayload>;
    actorUserId: string | null;
    actor?: RustFoundationActor | null;
    decisionNote?: string | null;
  }) {
    const rustOwnedBrandingRetry = resolveInput.currentState.status === "approved"
      && isBrandingPatch(resolveInput.proposal.patch)
      && await isRustOwned(resolveInput.proposal.targetId);
    if (resolveInput.currentState.status !== "pending" && !rustOwnedBrandingRetry) {
      throw unprocessable("Only pending lightweight changes can be resolved");
    }

    const decisionNote = rustOwnedBrandingRetry
      ? resolveInput.currentState.decisionNote
      : safeTrim(resolveInput.decisionNote);
    const decidedAt = rustOwnedBrandingRetry
      ? resolveInput.currentState.decidedAt ?? new Date().toISOString()
      : new Date().toISOString();
    const decidedByUserId = rustOwnedBrandingRetry
      ? resolveInput.currentState.decidedByUserId
      : resolveInput.actorUserId;

    const { updated, rustOwned } = await updateOrganizationFromChatProposal({
      orgId: resolveInput.proposal.targetId,
      patch: resolveInput.proposal.patch,
      source: "chat-proposal",
      sourceId: resolveInput.messageId,
      actor: resolveInput.actor,
    });
    if (!updated) throw notFound("Organization not found");
    const message = rustOwnedBrandingRetry
      ? await getMessage(resolveInput.conversationId, resolveInput.messageId)
      : await updateMessageStructuredPayload(
        resolveInput.conversationId,
        resolveInput.messageId,
        withOperationProposalDecisionState(resolveInput.messagePayload, {
          status: "approved",
          decisionNote,
          decidedByUserId,
          decidedAt,
        }),
      );
    if (!message) throw notFound("Operation proposal not found");

    const systemMessage = await addMessage(resolveInput.conversationId, {
      orgId: resolveInput.orgId,
      role: "system",
      kind: "system_event",
      body: `Applied lightweight change: ${resolveInput.proposal.summary}.`,
      structuredPayload: {
        eventType: "operation_applied",
        source: "chat",
        sourceMessageId: resolveInput.messageId,
        targetType: "organization",
        targetId: resolveInput.proposal.targetId,
        decisionNote,
      },
      ...(rustOwned ? { clientMutationId: `chat-proposal:${resolveInput.messageId}:organization-applied` } : {}),
    });
    const actorIsAgent = rustOwned && resolveInput.actor?.type === "agent";
    await logActivity(db, {
      orgId: resolveInput.orgId,
      actorType: actorIsAgent ? "agent" : "user",
      actorId: actorIsAgent
        ? resolveInput.actor?.type === "agent" ? resolveInput.actor.agentId ?? "unknown-agent" : "unknown-agent"
        : resolveInput.actorUserId ?? "board",
      ...(actorIsAgent && resolveInput.actor?.type === "agent" ? { agentId: resolveInput.actor.agentId } : {}),
      action: "organization.updated",
      entityType: "organization",
      entityId: resolveInput.proposal.targetId,
      details: {
        source: "chat_lightweight_change",
        sourceMessageId: resolveInput.messageId,
        decisionNote,
        ...resolveInput.proposal.patch,
      },
      ...(rustOwned ? { idempotencyKey: `chat-proposal:${resolveInput.messageId}:organization-activity` } : {}),
    });
    return { message, systemMessage };
  }

  async function applyApprovedApproval(applyInput: {
    approval: ApprovalRow;
    actorUserId: string | null;
    actor?: RustFoundationActor | null;
    recoveryOnly: boolean;
    conversationId: string;
    proposal: OrganizationOperationProposal;
  }) {
    const rustOwnedBranding = isBrandingPatch(applyInput.proposal.patch)
      && await isRustOwned(applyInput.proposal.targetId);
    if (applyInput.recoveryOnly && !rustOwnedBranding) return null;
    const { updated, rustOwned } = await updateOrganizationFromChatProposal({
      orgId: applyInput.proposal.targetId,
      patch: applyInput.proposal.patch,
      source: "chat-approval",
      sourceId: applyInput.approval.id,
      actor: applyInput.actor,
    });
    if (!updated) throw notFound("Organization not found");
    await addMessage(applyInput.conversationId, {
      orgId: applyInput.approval.orgId,
      role: "system",
      kind: "system_event",
      body: `Applied approved organization change: ${applyInput.proposal.summary}.`,
      structuredPayload: {
        eventType: "operation_applied",
        approvalId: applyInput.approval.id,
        targetType: "organization",
        targetId: applyInput.proposal.targetId,
      },
      ...(rustOwned ? { clientMutationId: `chat-approval:${applyInput.approval.id}:organization-applied` } : {}),
    });
    await logActivity(db, {
      orgId: applyInput.approval.orgId,
      actorType: "user",
      actorId: applyInput.actorUserId ?? "board",
      action: "organization.updated",
      entityType: "organization",
      entityId: applyInput.proposal.targetId,
      details: applyInput.proposal.patch,
      ...(rustOwned ? { idempotencyKey: `chat-approval:${applyInput.approval.id}:organization-activity` } : {}),
    });
    return updated;
  }

  async function validateApprovedApproval(approval: ApprovalRow, actor?: RustFoundationActor | null) {
    if (approval.type !== "chat_operation") return;
    const payload = approval.payload as Record<string, unknown>;
    const proposal = operationProposalFromPayload(
      (payload.operationProposal as Record<string, unknown> | null | undefined) ?? payload,
    );
    if (!proposal || proposal.targetType !== "organization") return;
    if (proposal.targetId !== approval.orgId) {
      throw unprocessable("Organization approvals can only update the same organization");
    }
    if (!isBrandingPatch(proposal.patch)) return;
    await validateForRust({ orgId: proposal.targetId, patch: proposal.patch, actor });
  }

  return { isBrandingPatch, resolveOperationProposal, applyApprovedApproval, validateApprovedApproval };
}
