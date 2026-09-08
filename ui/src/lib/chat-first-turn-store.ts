import { CHAT_COMPOSER_DRAFT_VERSION, readChatComposerDraft, saveChatComposerDraft } from "./chat-draft-storage";
import { readChatPendingAttachmentsForScope, resolveChatPendingAttachmentScopeKey, updateChatPendingAttachmentsForScope } from "./chat-pending-attachments";
import { chatResponseAnnotationsForDraft, type ChatResponseAnnotationState } from "./chat-response-annotations";

export type PendingFirstChatTurn = {
  streamKey: string;
  body: string;
  files: File[];
  createdAt: Date;
  annotationState?: ChatResponseAnnotationState;
};

/** Provider-owned, memory-only operation state; subscribing is not navigation. */
export class FirstChatTurnStore {
  private owner: string | null = null;
  private operations = new Map<string, { owner: string; turn: PendingFirstChatTurn; draftScope?: string }>();
  private recoveredByScope = new Map<string, PendingFirstChatTurn>();
  private snapshot: { pending: PendingFirstChatTurn | null; recovery: number; recoveredTurn: PendingFirstChatTurn | null } = { pending: null, recovery: 0, recoveredTurn: null };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(pending: PendingFirstChatTurn | null, recovery = this.snapshot.recovery, recoveredTurn: PendingFirstChatTurn | null = null) {
    this.snapshot = { pending, recovery, recoveredTurn };
    this.listeners.forEach((listener) => listener());
  }
  setOwner(owner: string | null) {
    if (this.owner === owner) return;
    this.owner = owner;
    this.publish(null);
  }
  begin(owner: string, turn: PendingFirstChatTurn, draftScope?: string) {
    if (owner !== this.owner || this.snapshot.pending) return false;
    this.operations.set(turn.streamKey, { owner, turn, draftScope });
    if (draftScope) this.recoveredByScope.delete(draftScope);
    this.publish(turn);
    return true;
  }
  owns(owner: string, streamKey: string) {
    return this.owner === owner && this.snapshot.pending?.streamKey === streamKey;
  }
  finish(owner: string, streamKey: string, recover = false) {
    if (!recover && this.operations.get(streamKey)?.owner === owner) this.operations.delete(streamKey);
    if (!this.owns(owner, streamKey)) return false;
    this.publish(null, this.snapshot.recovery + (recover ? 1 : 0), recover ? this.snapshot.pending : null);
    return true;
  }
  readRecoveredTurn(orgId: string, conversationId: string | null) {
    return this.recoveredByScope.get(resolveChatPendingAttachmentScopeKey(orgId, conversationId));
  }
  /** Operation recovery survives route revocation; only the current claim may publish to the composer. */
  recoverDraft(owner: string, streamKey: string, orgId: string, sourceConversationId: string | null) {
    const operation = this.operations.get(streamKey);
    if (!operation || operation.owner !== owner) return null;
    const { turn } = operation;
    const sourceScope = resolveChatPendingAttachmentScopeKey(orgId, sourceConversationId);
    const current = readChatComposerDraft(orgId, sourceConversationId);
    const conflict = current.body.length > 0 || current.inlineAnnotations.length > 0
      || readChatPendingAttachmentsForScope(sourceScope).length > 0
      || [...this.operations.values()].some((other) => other !== operation && other.draftScope === sourceScope);
    const conversationId = conflict ? `first-turn-recovery:${streamKey}` : sourceConversationId;
    const scope = resolveChatPendingAttachmentScopeKey(orgId, conversationId);
    saveChatComposerDraft(orgId, conversationId, {
      version: CHAT_COMPOSER_DRAFT_VERSION,
      body: turn.body,
      inlineAnnotations: turn.annotationState ? chatResponseAnnotationsForDraft(turn.annotationState) : [],
    });
    updateChatPendingAttachmentsForScope(scope, () => turn.files);
    // File objects (including annotation attachments) deliberately remain memory-only.
    this.recoveredByScope.set(scope, turn);
    this.operations.delete(streamKey);
    if (this.owns(owner, streamKey)) {
      this.publish(null, this.snapshot.recovery + (conflict ? 0 : 1), conflict ? null : turn);
    }
    return { conversationId, turn };
  }
}
