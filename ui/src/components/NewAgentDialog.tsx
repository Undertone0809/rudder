import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Code,
  MousePointer2,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useState, type ComponentType } from "react";
import { agentsApi } from "../api/agents";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";

type AdvancedAdapterType =
  | "claude_local"
  | "codex_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "openclaw_gateway"
  | "hermes_gateway";
const ADVANCED_ADAPTER_OPTIONS: Array<{
  value: AdvancedAdapterType;
  label: string;
  desc: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
}> = [
  {
    value: "claude_local",
    label: "Claude Code",
    icon: Sparkles,
    desc: "Local Claude agent",
    recommended: true,
  },
  {
    value: "codex_local",
    label: "Codex",
    icon: Code,
    desc: "Local Codex agent",
    recommended: true,
  },
  {
    value: "opencode_local",
    label: "OpenCode",
    icon: OpenCodeLogoIcon,
    desc: "Local multi-provider agent",
  },
  {
    value: "pi_local",
    label: "Pi",
    icon: Terminal,
    desc: "Local Pi agent",
  },
  {
    value: "cursor",
    label: "Cursor",
    icon: MousePointer2,
    desc: "Local Cursor agent",
  },
  {
    value: "openclaw_gateway",
    label: "OpenClaw Gateway",
    icon: Bot,
    desc: "Invoke OpenClaw via gateway protocol",
  },
];

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedOrganizationId } = useOrganization();
  const navigate = useNavigate();
  const [showAdvancedCards, setShowAdvancedCards] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && newAgentOpen,
  });

  const ceoAgent = (agents ?? []).find((a) => a.role === "ceo");
  const {
    data: runtimeAvailability,
    isPending: runtimeAvailabilityPending,
    isFetching: runtimeAvailabilityFetching,
    isError: runtimeAvailabilityError,
    refetch: refetchRuntimeAvailability,
  } = useQuery({
    queryKey: selectedOrganizationId
      ? queryKeys.agents.adapterAvailability(selectedOrganizationId)
      : ["agents", "none", "adapter-availability"],
    queryFn: () => agentsApi.adapterAvailability(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && newAgentOpen,
  });
  const hermesAvailability = runtimeAvailability?.find((item) => item.agentRuntimeType === "hermes_gateway");
  const hermesDetectionFailed = !runtimeAvailabilityFetching && (
    runtimeAvailabilityError || (!runtimeAvailabilityPending && !hermesAvailability)
  );

  function handleAskCeo() {
    closeNewAgent();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: "Create a new agent",
      description: "(type in what kind of agent you want here)",
    });
  }

  function handleAdvancedConfig() {
    setShowAdvancedCards(true);
  }

  function handleAdvancedAdapterPick(agentRuntimeType: AdvancedAdapterType) {
    closeNewAgent();
    setShowAdvancedCards(false);
    const params = new URLSearchParams({ agentRuntimeType });
    if (agentRuntimeType === "hermes_gateway") params.set("hermesConnectionMode", "local");
    navigate(`/agents/new?${params.toString()}`);
  }

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          setShowAdvancedCards(false);
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md p-0 gap-0 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">Add a new agent</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => {
              setShowAdvancedCards(false);
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-6">
          {!showAdvancedCards ? (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Sparkles className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  We recommend letting your agent handle setup — they can
                  choose the right role, permissions, skills, and runtime.
                </p>
              </div>

              <Button className="w-full" size="lg" onClick={handleAskCeo}>
                <Bot className="h-4 w-4 mr-2" />
                Ask Agent
              </Button>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  size="lg"
                  onClick={() => handleAdvancedAdapterPick("hermes_gateway")}
                >
                  <Bot className="h-4 w-4 mr-2" />
                  Create with Hermes
                </Button>
                {runtimeAvailabilityPending || runtimeAvailabilityFetching ? (
                  <p className="text-center text-xs text-muted-foreground" role="status">
                    Checking for Hermes on this machine…
                  </p>
                ) : hermesDetectionFailed ? (
                  <div
                    className="flex items-center justify-between gap-3 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-100"
                    role="alert"
                  >
                    <span>Couldn't check Hermes on this machine. Restart Rudder, then retry.</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => { void refetchRuntimeAvailability(); }}
                    >
                      Retry
                    </Button>
                  </div>
                ) : hermesAvailability?.status === "available" ? (
                  <p className="text-center text-xs text-muted-foreground" role="status">
                    Hermes was found on this machine. Rudder will use its existing provider setup.
                  </p>
                ) : (
                  <div
                    className="flex items-center justify-between gap-3 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-100"
                    role="alert"
                  >
                    <span>Hermes isn't ready on this machine. Install or finish setting it up, then retry.</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => { void refetchRuntimeAvailability(); }}
                    >
                      Retry
                    </Button>
                  </div>
                )}
              </div>

              {/* Advanced link */}
              <div className="text-center">
                <button
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                  onClick={handleAdvancedConfig}
                >
                  I want advanced configuration myself
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowAdvancedCards(false)}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <p className="text-sm text-muted-foreground">
                  Choose another way to configure your agent.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {ADVANCED_ADAPTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs transition-colors hover:bg-accent/50 relative"
                    )}
                    onClick={() => handleAdvancedAdapterPick(opt.value)}
                  >
                    {opt.recommended && (
                      <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                        Recommended
                      </span>
                    )}
                    <opt.icon className="h-4 w-4" />
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
