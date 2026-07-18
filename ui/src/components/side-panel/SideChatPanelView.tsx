import { chatsApi } from "@/api/chats";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { latestSideChatAnchor, sideChatConversationMessages, sideChatIsReadOnly } from "@/lib/side-chat";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, Loader2, Send, Sparkles } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

function messageRoleLabel(message: ChatMessage) {
  if (message.role === "assistant") return "Assistant";
  if (message.role === "user") return "You";
  return "System";
}

function expiryLabel(expiresAt: Date | string | null | undefined) {
  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "Expired";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

export function SideChatPanelView({
  organizationId,
  target,
  onReplaceTarget,
}: {
  organizationId: string;
  target: SideChatTarget;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState("");
  const [streamingBody, setStreamingBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const sourceMessagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.sourceConversationId),
    queryFn: () => chatsApi.listMessages(target.sourceConversationId),
    enabled: !target.sourceMessageId || !target.sourcePreview,
  });
  const sourceMessages = sourceMessagesQuery.data ?? [];
  const resolvedAnchor = useMemo(() => {
    if (target.sourceMessageId) {
      return sourceMessages.find((message) => message.id === target.sourceMessageId) ?? null;
    }
    return latestSideChatAnchor(sourceMessages);
  }, [sourceMessages, target.sourceMessageId]);
  const sourceMessageId = target.sourceMessageId ?? resolvedAnchor?.id ?? null;
  const sourcePreview = target.sourcePreview ?? resolvedAnchor?.body ?? null;

  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(organizationId, target.conversationId ?? "__side-chat-draft__"),
    queryFn: () => chatsApi.get(target.conversationId!),
    enabled: Boolean(target.conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.conversationId ?? "__side-chat-draft__"),
    queryFn: () => chatsApi.listMessages(target.conversationId!),
    enabled: Boolean(target.conversationId),
  });
  const conversation = conversationQuery.data ?? null;
  const messages = sideChatConversationMessages(messagesQuery.data ?? []);
  const readOnly = sideChatIsReadOnly(conversation);
  const kept = conversation?.sideChatState === "kept";
  const canKeep = conversation?.sideChatState === "active" && !readOnly;
  const stateLabel = readOnly
    ? conversation?.sideChatState === "expired" ? "Expired · read-only" : "Completed · read-only"
    : kept ? "Kept in Messenger" : expiryLabel(conversation?.sideChatExpiresAt);

  const setConversationCache = (updated: ChatConversation) => {
    queryClient.setQueryData(queryKeys.chats.detail(organizationId, updated.id), updated);
  };

  const completeMutation = useMutation({
    mutationFn: () => chatsApi.completeSideChat(target.conversationId!),
    onSuccess: (updated) => {
      setConversationCache(updated);
      void queryClient.invalidateQueries({ queryKey: ["messenger", organizationId] });
      pushToast({ title: "Side Chat completed", body: "This tab is now read-only.", tone: "success" });
    },
  });
  const keepMutation = useMutation({
    mutationFn: () => chatsApi.keepSideChat(target.conversationId!),
    onSuccess: (updated) => {
      setConversationCache(updated);
      void queryClient.invalidateQueries({ queryKey: ["messenger", organizationId] });
      pushToast({ title: "Kept in Messenger", body: "This Side Chat now appears with your conversations.", tone: "success" });
    },
  });

  const appendMessage = (conversationId: string, message: ChatMessage) => {
    queryClient.setQueryData<ChatMessage[]>(
      queryKeys.chats.messages(organizationId, conversationId),
      (current = []) => current.some((candidate) => candidate.id === message.id) ? current : [...current, message],
    );
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending || readOnly || !sourceMessageId) return;
    setSending(true);
    setSendError(null);
    setStreamingBody("");
    setDraft("");
    try {
      let conversationId = target.conversationId;
      if (!conversationId) {
        const created = await chatsApi.createSideChat(target.sourceConversationId, {
          sourceMessageId,
          clientMutationId: target.clientMutationId,
        });
        conversationId = created.id;
        setConversationCache(created);
        queryClient.setQueryData(queryKeys.chats.messages(organizationId, created.id), []);
        onReplaceTarget(sidePanelTargetKey(target), {
          ...target,
          sourceMessageId,
          sourcePreview,
          conversationId: created.id,
        });
      }
      await chatsApi.sendMessageStream(conversationId, body, {
        onEvent: async (streamEvent) => {
          if (streamEvent.type === "ack") appendMessage(conversationId!, streamEvent.userMessage);
          if (streamEvent.type === "assistant_delta") setStreamingBody((current) => current + streamEvent.delta);
          if (streamEvent.type === "final") {
            for (const message of streamEvent.messages) appendMessage(conversationId!, message);
            setStreamingBody("");
          }
          if (streamEvent.type === "error") throw new Error(streamEvent.error);
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, conversationId) }),
      ]);
    } catch (error) {
      setDraft((current) => current || body);
      setSendError(error instanceof Error ? error.message : "Could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const anchorLoading = (!target.sourceMessageId || !target.sourcePreview) && sourceMessagesQuery.isPending;
  const noAnchor = !anchorLoading && !sourceMessageId;

  return (
    <div className="flex min-h-full flex-col gap-4" data-testid="side-chat-panel-view">
      <section className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-[color:var(--accent-base)]" />
            Side Chat
          </div>
          {stateLabel ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="side-chat-state">
              <Clock3 className="h-3 w-3" />
              {stateLabel}
            </span>
          ) : null}
        </div>
        <div className="mt-3 border-l-2 border-[color:var(--accent-base)] pl-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.13em] text-muted-foreground">From the main chat</div>
          {anchorLoading ? (
            <div className="h-10 animate-pulse rounded bg-[color:var(--surface-active)]" />
          ) : noAnchor ? (
            <p className="text-sm text-destructive">The main chat needs a completed assistant response first.</p>
          ) : (
            <div className="line-clamp-5 text-sm leading-6 text-muted-foreground" data-testid="side-chat-anchor-preview">
              <MarkdownBody>{sourcePreview ?? "Assistant response"}</MarkdownBody>
            </div>
          )}
        </div>
      </section>

      <div className="min-h-[8rem] flex-1 space-y-3" data-testid="side-chat-messages">
        {messages.length === 0 && !streamingBody ? (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--border-soft)] px-3 py-5 text-center text-sm text-muted-foreground">
            Ask a focused follow-up. The main chat stays exactly where it is.
          </div>
        ) : null}
        {messages.map((message) => (
          <article
            key={message.id}
            className={cn(
              "rounded-[var(--radius-md)] border px-3 py-2.5 text-sm",
              message.role === "user"
                ? "ml-6 border-[color:var(--border-soft)] bg-[color:var(--surface-active)]"
                : "mr-3 border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)]",
            )}
          >
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{messageRoleLabel(message)}</div>
            <MarkdownBody className="text-sm leading-6">{message.body || message.kind}</MarkdownBody>
          </article>
        ))}
        {streamingBody ? (
          <article className="mr-3 rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-2.5 text-sm" data-testid="side-chat-streaming-reply">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Assistant
            </div>
            <MarkdownBody className="text-sm leading-6">{streamingBody}</MarkdownBody>
          </article>
        ) : null}
      </div>

      {sendError ? <div role="alert" className="text-sm text-destructive">{sendError}</div> : null}

      {readOnly ? (
        <div className="rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-3 py-3 text-sm text-muted-foreground" data-testid="side-chat-read-only">
          <Check className="mr-2 inline h-4 w-4" />
          This Side Chat is complete. You can review it here or close the tab.
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-2" data-testid="side-chat-composer">
          <Textarea
            value={draft}
            rows={3}
            disabled={sending || noAnchor}
            placeholder="Ask a focused follow-up…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
            <Button type="submit" size="sm" disabled={!draft.trim() || sending || noAnchor}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send
            </Button>
          </div>
        </form>
      )}

      {target.conversationId ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--border-soft)] pt-3">
          {canKeep ? (
            <Button type="button" variant="outline" size="sm" disabled={sending || keepMutation.isPending} onClick={() => keepMutation.mutate()}>
              {keepMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Keep in Messenger
            </Button>
          ) : null}
          {!readOnly && !kept ? (
            <Button type="button" size="sm" disabled={sending || completeMutation.isPending} onClick={() => completeMutation.mutate()} data-testid="side-chat-done">
              {completeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Done &amp; return
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
