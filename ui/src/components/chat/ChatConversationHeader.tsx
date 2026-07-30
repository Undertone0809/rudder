import { AgentIcon } from "@/components/AgentAvatar";
import { cn } from "@/lib/utils";
import type { Agent } from "@rudderhq/shared";
import { ChevronRight, Sparkles } from "lucide-react";

export const CHAT_HEADER_TITLE_CHARACTER_LIMIT = 10;

export function compactChatHeaderTitle(
  title: string,
  limit = CHAT_HEADER_TITLE_CHARACTER_LIMIT,
) {
  if (limit <= 0) return "";
  const characters = typeof Intl.Segmenter === "function"
    ? Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title),
      ({ segment }) => segment,
    )
    : Array.from(title);
  if (characters.length <= limit) return title;
  if (limit === 1) return "…";
  return `${characters.slice(0, limit - 1).join("")}…`;
}

interface ChatConversationHeaderProps {
  agent: Pick<Agent, "id" | "name" | "icon" | "role"> | null;
  title: string;
  className?: string;
}

export function ChatConversationHeader({
  agent,
  title,
  className,
}: ChatConversationHeaderProps) {
  const agentLabel = agent?.name ?? "Unknown agent";
  const compactTitle = compactChatHeaderTitle(title);

  return (
    <div
      data-testid="chat-conversation-header"
      role="group"
      aria-label={`${agentLabel} chat: ${title}`}
      className={cn("pointer-events-auto flex min-w-0 items-center gap-1.5", className)}
    >
      {agent ? (
        <AgentIcon
          icon={agent.icon}
          role={agent.role}
          fallbackSeed={agent.id}
          className="h-6 w-6 shrink-0"
        />
      ) : (
        <span
          data-testid="chat-header-agent-fallback"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/90 text-muted-foreground"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
        </span>
      )}
      <span
        data-testid="chat-header-agent-name"
        className="max-w-32 truncate text-[13px] font-semibold text-foreground"
        title={agentLabel}
      >
        {agentLabel}
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span
        data-testid="chat-header-title"
        className="min-w-0 truncate text-[13px] font-medium text-muted-foreground"
        title={title}
      >
        {compactTitle}
      </span>
    </div>
  );
}
