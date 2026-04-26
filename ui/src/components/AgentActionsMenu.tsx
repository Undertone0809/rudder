import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, HeartPulse, Loader2, MessageSquare, MoreHorizontal, Pause, Play, Plus } from "lucide-react";
import type { Agent } from "@rudderhq/shared";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { useDialog } from "@/context/DialogContext";
import { useToast } from "@/context/ToastContext";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { agentRouteRef, cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AgentActionsMenu({
  agent,
  orgId,
  triggerTestId,
  triggerClassName,
  visibilityClassName,
  onActionComplete,
}: {
  agent: Agent;
  orgId: string;
  triggerTestId?: string;
  triggerClassName?: string;
  visibilityClassName?: string;
  onActionComplete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openNewIssue } = useDialog();
  const { pushToast } = useToast();
  const isTerminated = agent.status === "terminated";
  const isPaused = agent.status === "paused";

  const invalidateAgentData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(orgId) }),
    ]);
  };

  const chatMutation = useMutation({
    mutationFn: () =>
      chatsApi.create(orgId, {
        title: `Chat with ${agent.name}`,
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "agent", entityId: agent.id }],
      }),
    onSuccess: async (conversation) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
      ]);
      onActionComplete?.();
      navigate(`/messenger/chat/${conversation.id}`);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to open chat",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const heartbeatMutation = useMutation({
    mutationFn: () => agentsApi.invoke(agent.id, orgId),
    onSuccess: async (run) => {
      await invalidateAgentData();
      onActionComplete?.();
      pushToast({
        title: "Heartbeat started",
        tone: "success",
        action: {
          label: "Open run",
          href: `/agents/${agentRouteRef(agent)}/runs/${run.id}`,
        },
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to run heartbeat",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const pauseResumeMutation = useMutation({
    mutationFn: () => isPaused ? agentsApi.resume(agent.id, orgId) : agentsApi.pause(agent.id, orgId),
    onSuccess: async () => {
      await invalidateAgentData();
      onActionComplete?.();
      pushToast({
        title: isPaused ? "Agent resumed" : "Agent paused",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: isPaused ? "Failed to resume agent" : "Failed to pause agent",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const handleCreateTask = () => {
    openNewIssue({ assigneeAgentId: agent.id });
    onActionComplete?.();
  };

  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(agent.name);
      onActionComplete?.();
      pushToast({ title: "Copied agent name", tone: "success" });
    } catch (error) {
      pushToast({
        title: "Failed to copy agent name",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    }
  };

  const isBusy = chatMutation.isPending || heartbeatMutation.isPending || pauseResumeMutation.isPending;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${agent.name}`}
          data-testid={triggerTestId ?? `agent-row-actions-${agent.id}`}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            open || isBusy
              ? "opacity-100"
              : visibilityClassName ?? "opacity-100 md:opacity-0 md:group-hover/agent-row:opacity-100 md:group-focus-within/agent-row:opacity-100",
            triggerClassName,
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="surface-overlay w-48 text-foreground">
        <DropdownMenuItem onSelect={handleCreateTask}>
          <Plus className="h-4 w-4" />
          Create task
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => chatMutation.mutate()} disabled={chatMutation.isPending || isTerminated}>
          <MessageSquare className="h-4 w-4" />
          Chat with agent
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => heartbeatMutation.mutate()} disabled={heartbeatMutation.isPending || isTerminated}>
          <HeartPulse className="h-4 w-4" />
          Run heartbeat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => pauseResumeMutation.mutate()}
          disabled={pauseResumeMutation.isPending || isTerminated}
        >
          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {isPaused ? "Resume agent" : "Pause agent"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleCopyName()}>
          <Copy className="h-4 w-4" />
          Copy agent name
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
