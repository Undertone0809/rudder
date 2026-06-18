import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import type { ChatMessage, HeartbeatRun } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { chatsApi } from "../api/chats";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

export interface RunChatReplySummary {
  id: string;
  runId: string;
  replyingAgentId: string | null;
  body: string;
  status: ChatMessage["status"];
  createdAt: Date;
  isCurrentRun: boolean;
  isSuperseded: boolean;
}

export interface RunChatContext {
  conversationId: string | null;
  userMessage: ChatMessage | null;
  currentReply: ChatMessage | null;
  replies: RunChatReplySummary[];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function runChatSnapshot(run: HeartbeatRun): Record<string, unknown> {
  return run.contextSnapshot && typeof run.contextSnapshot === "object" ? run.contextSnapshot : {};
}

export function resolveRunChatConversationId(run: HeartbeatRun): string | null {
  return run.chatConversationId ?? readString(runChatSnapshot(run).conversationId);
}

function byCreatedAt(a: ChatMessage, b: ChatMessage): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export function buildRunChatContext(run: HeartbeatRun, messages: ChatMessage[]): RunChatContext {
  const snapshot = runChatSnapshot(run);
  const conversationId = resolveRunChatConversationId(run);
  const userMessageId = readString(snapshot.userMessageId);
  const chatTurnId = readString(snapshot.chatTurnId);
  const userMessage =
    messages.find((message) => message.role === "user" && message.id === userMessageId)
    ?? messages.find((message) => message.role === "user" && chatTurnId !== null && message.chatTurnId === chatTurnId)
    ?? null;
  const currentReply =
    messages.find((message) => message.role === "assistant" && message.runId === run.id)
    ?? messages.find((message) => message.role === "assistant" && chatTurnId !== null && message.chatTurnId === chatTurnId)
    ?? null;
  const replies = messages
    .filter((message) => message.role === "assistant" && Boolean(message.runId))
    .sort(byCreatedAt)
    .map((message) => ({
      id: message.id,
      runId: message.runId!,
      replyingAgentId: message.replyingAgentId,
      body: message.body,
      status: message.status,
      createdAt: message.createdAt,
      isCurrentRun: message.runId === run.id,
      isSuperseded: Boolean(message.supersededAt),
    }));

  return { conversationId, userMessage, currentReply, replies };
}

function previewText(value: string, fallback: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
}

export function RunChatContextCard({
  run,
  agentRouteId,
}: {
  run: HeartbeatRun;
  agentRouteId: string;
}) {
  const conversationId = resolveRunChatConversationId(run);
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(run.orgId, conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(conversationId!),
    enabled: Boolean(conversationId),
  });
  const context = useMemo(
    () => buildRunChatContext(run, messagesQuery.data ?? []),
    [messagesQuery.data, run],
  );

  if (!conversationId) return null;

  return (
    <section
      className="rounded-lg border border-border bg-background/60 p-3"
      data-testid="run-chat-context-card"
      aria-label="Chat conversation context"
    >
      <div className="flex justify-end">
        <Button asChild variant="outline" size="sm" className="h-8 px-3 text-xs">
          <Link to={`/messenger/chat/${conversationId}`}>
            Open conversation
          </Link>
        </Button>
      </div>

      <div className="mt-3 text-xs font-medium text-muted-foreground">
        Conversation replies
      </div>
      <div className="mt-2 divide-y divide-border/70 rounded-md border border-border/70">
        {messagesQuery.isLoading ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Loading conversation replies...
          </div>
        ) : messagesQuery.isError ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Conversation replies could not be loaded.
          </div>
        ) : context.replies.length > 0 ? (
          context.replies.map((reply, index) => (
            <Link
              key={reply.id}
              to={`/agents/${reply.replyingAgentId ?? agentRouteId}/runs/${reply.runId}`}
              className={cn(
                "block px-3 py-2 text-xs text-inherit no-underline transition-colors hover:bg-accent/20",
                reply.isCurrentRun && "bg-accent/30",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">
                  Reply {index + 1}
                  {reply.isCurrentRun ? " · current run" : ""}
                  {reply.isSuperseded ? " · edited branch" : ""}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {relativeTime(reply.createdAt)}
                </span>
              </div>
              <div className="mt-1 line-clamp-2 text-muted-foreground">
                {previewText(reply.body, "Empty assistant reply")}
              </div>
            </Link>
          ))
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No run-backed replies are linked to this conversation yet.
          </div>
        )}
      </div>
    </section>
  );
}
