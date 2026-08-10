import { AgentIcon } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Agent } from "@rudderhq/shared";
import { ChevronRight, PanelLeft, Sparkles } from "lucide-react";

interface ChatConversationHeaderProps {
  agent: Pick<Agent, "id" | "name" | "icon" | "role"> | null;
  title: string;
  onOpenSidebar?: () => void;
  className?: string;
}

export function ChatConversationHeader({
  agent,
  title,
  onOpenSidebar,
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
      {onOpenSidebar ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="workspace-sidebar-reopen-button"
              className="desktop-window-no-drag pointer-events-auto h-7 w-7 shrink-0 text-muted-foreground"
              onClick={onOpenSidebar}
              aria-label="Open workspace sidebar"
            >
              <PanelLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open workspace sidebar</TooltipContent>
        </Tooltip>
      ) : null}
      {agent ? (
        <span data-testid="chat-header-agent-icon" className="flex h-6 w-6 shrink-0">
          <AgentIcon
            icon={agent.icon}
            role={agent.role}
            fallbackSeed={agent.id}
            className="h-6 w-6 shrink-0"
          />
        </span>
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
