import { AgentIcon } from "@/components/AgentAvatar";
import { cn } from "@/lib/utils";
import type { Agent } from "@rudderhq/shared";
import { ChevronRight, Sparkles } from "lucide-react";

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

  return (
    <div
      data-testid="chat-conversation-header"
      role="group"
      aria-label={`${agentLabel} chat: ${title}`}
      className={cn(
        "pointer-events-auto flex w-fit min-w-0 max-w-[33.333333%] items-center gap-1",
        className,
      )}
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
        className="max-w-32 shrink-0 truncate text-[13px] font-semibold text-foreground"
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
        {title}
      </span>
    </div>
  );
}
