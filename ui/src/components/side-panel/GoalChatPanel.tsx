import type { TranscriptEntry } from "@/agent-runtimes";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import {
  ChatComposerEditor,
  ChatComposerSendButton,
  ChatComposerSurface,
  ChatComposerToolbar,
} from "@/components/chat/ChatComposer";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { ChatMessageItem, StreamTranscriptItem } from "@/pages/Chat.messages";
import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type GoalChatTarget = Extract<SidePanelTarget, { kind: "goal_chat" }>;

function messageBody(message: ChatMessage) {
  return message.body?.trim() || message.kind;
}

function transcriptEntries(message: ChatMessage) {
  return (message.transcript ?? []) as TranscriptEntry[];
}

function noop() {}

export function GoalChatPanel({
  target,
  onReplaceTarget,
}: {
  target: GoalChatTarget;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(target.body);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBody, setStreamBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef(target);
  const sendInFlightRef = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  targetRef.current = target;

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(target.organizationId),
    queryFn: () => agentsApi.list(target.organizationId),
  });
  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(target.organizationId, target.conversationId ?? "__goal-chat-draft__"),
    queryFn: () => chatsApi.get(target.conversationId!),
    enabled: Boolean(target.conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(target.organizationId, target.conversationId ?? "__goal-chat-draft__"),
    queryFn: () => chatsApi.listMessages(target.organizationId, target.conversationId!, { includeTranscript: true }),
    enabled: Boolean(target.conversationId),
  });

  const selectedAgent = useMemo(
    () => (agentsQuery.data ?? []).find((agent) => agent.id === target.agentId)
      ?? (agentsQuery.data ?? [])[0]
      ?? null,
    [agentsQuery.data, target.agentId],
  );
  const conversation = conversationQuery.data as ChatConversation | undefined;
  const loadError = conversationQuery.error ?? messagesQuery.error;

  useEffect(() => {
    if (messagesQuery.data && !sendInFlightRef.current) setMessages(messagesQuery.data);
  }, [messagesQuery.data]);

  useEffect(() => {
    setDraft(target.body);
  }, [target.body]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        `rudder.goal-chat:${target.organizationId}:${target.goalId}`,
        JSON.stringify(target),
      );
    } catch {
      // The live Side Panel state remains authoritative when storage is unavailable.
    }
  }, [target]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamBody]);

  const updateTarget = useCallback((patch: Partial<GoalChatTarget>) => {
    const current = targetRef.current;
    const next = { ...current, ...patch } satisfies GoalChatTarget;
    targetRef.current = next;
    onReplaceTarget(sidePanelTargetKey(current), next);
  }, [onReplaceTarget]);

  const handleSend = async () => {
    const body = draft.trim();
    const sendTarget = targetRef.current;
    if (!body || sending || !selectedAgent) return;
    sendInFlightRef.current = true;
    setSending(true);
    setError(null);
    setStreamBody("");
    let completedConversationId: string | null = null;
    try {
      const onEvent = async (event: Parameters<NonNullable<Parameters<typeof chatsApi.sendMessageStream>[2]["onEvent"]>>[0]) => {
        if (event.type === "ack") {
          setMessages((current) => [...current, event.userMessage]);
          const current = targetRef.current;
          updateTarget({
            conversationId: event.userMessage.conversationId,
            body: current.body === body ? "" : current.body,
          });
          setDraft((current) => current.trim() === body ? "" : current);
        }
        if (event.type === "assistant_delta") setStreamBody((current) => current + event.delta);
        if (event.type === "final") {
          setStreamBody("");
          setMessages((current) => [...current, ...event.messages]);
        }
        if (event.type === "error") throw new Error(event.error);
      };

      if (sendTarget.conversationId) {
        await chatsApi.sendMessageStream(sendTarget.conversationId, body, { onEvent });
      } else {
        await chatsApi.sendFirstMessageStream(target.organizationId, body, {
          preferredAgentId: selectedAgent.id,
          issueCreationMode: "manual_approval",
          planMode: false,
          modelOverride: null,
          effortOverride: null,
          contextLinks: [{ entityType: "goal", entityId: target.goalId }],
          clientMutationId: target.clientMutationId,
          onEvent,
        });
      }
      completedConversationId = targetRef.current.conversationId ?? sendTarget.conversationId;
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not send this message.");
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
    if (completedConversationId) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(target.organizationId, completedConversationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(target.organizationId, completedConversationId) }),
      ]);
    }
  };

  const canSend = Boolean(draft.trim() && selectedAgent && !sending);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="goal-chat-panel">
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="flex min-w-0 items-center gap-2 border-b border-border/70 pb-3">
            <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">Chat about Goal</div>
              <div className="truncate text-xs text-muted-foreground">{target.label}</div>
            </div>
            {target.conversationId ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Open full chat"
                title="Open full chat"
                onClick={() => navigate(`/messenger/chat/${target.conversationId}`)}
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            ) : null}
          </div>

          {target.conversationId && (conversationQuery.isPending || messagesQuery.isPending) ? (
            <p className="text-sm text-muted-foreground">Loading conversation...</p>
          ) : null}
          {loadError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive">
              <span>{loadError instanceof Error ? loadError.message : "Could not load this conversation."}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void Promise.all([conversationQuery.refetch(), messagesQuery.refetch()])}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {!target.conversationId && messages.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No messages yet.</p>
          ) : null}

          {conversation ? messages.map((message) => {
            const transcript = transcriptEntries(message);
            return (
              <div key={message.id} data-testid="goal-chat-message">
                {message.role === "assistant" && transcript.length > 0 ? (
                  <StreamTranscriptItem
                    entries={transcript}
                    state={message.status}
                    generationTerminalReason={message.generationTerminalReason}
                    streamStartedAt={new Date(message.createdAt)}
                    streamEndedAt={new Date(message.updatedAt)}
                    assistantMessageBody={message.body}
                    showDeveloperDiagnostics={false}
                  />
                ) : null}
                <ChatMessageItem
                  conversation={conversation}
                  message={message}
                  agents={agentsQuery.data}
                  decisionNote=""
                  onDecisionNoteChange={noop}
                  decisionNoteMentions={[]}
                  onDecisionNoteMentionQueryChange={noop}
                  onDecisionNoteInlineTokenClick={noop}
                  onApprovalAction={noop}
                  onIssueProposalChange={noop}
                  onResolveOperationProposal={noop}
                  onConvertToIssue={noop}
                  actionPending={false}
                  onCopyMessageText={(text) => navigator.clipboard?.writeText(text)}
                  onOpenFile={noop}
                  onSelectResponseAnnotation={(annotation) => {
                    if (annotation.surface !== "agent_run_transcript") return;
                    navigate(`/agents/${annotation.sourceAgentId}/runs/${annotation.sourceRunId}`);
                  }}
                  skillReferences={[]}
                />
              </div>
            );
          }) : messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-md border px-3 py-2 text-sm ${message.role === "user" ? "ml-6 bg-muted/30" : "mr-6"}`}
            >
              <div className="mb-1 text-xs text-muted-foreground">{message.role === "user" ? "You" : selectedAgent?.name ?? "Agent"}</div>
              <div className="whitespace-pre-wrap break-words">{messageBody(message)}</div>
            </div>
          ))}
          {streamBody ? (
            <div data-testid="goal-chat-streaming" className="mr-6 whitespace-pre-wrap break-words text-sm text-foreground">
              {streamBody}
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>

      {error ? <div role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</div> : null}
      <div className="shrink-0 px-4 pb-4">
        <ChatComposerSurface className="mx-auto max-w-3xl" testId="goal-chat-composer">
          <ChatComposerEditor
            value={draft}
            onChange={(value) => {
              if (sending) return;
              setDraft(value);
              updateTarget({ body: value });
            }}
            placeholder="Message about this Goal..."
            onSubmit={() => void handleSend()}
          />
          <ChatComposerToolbar
            actions={(
              <ChatComposerSendButton
                mode={sending ? "sending" : "send"}
                ariaLabel={sending ? "Sending message" : "Send message"}
                disabled={!canSend}
                onClick={() => void handleSend()}
              />
            )}
          >
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedAgent?.name ?? (agentsQuery.isPending ? "Loading Agent..." : "No Agent available")}
            </span>
          </ChatComposerToolbar>
        </ChatComposerSurface>
      </div>
    </div>
  );
}
