import type { AgentRole } from "@rudderhq/shared";
import { Minus, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "./AgentIconPicker";
import { cn } from "@/lib/utils";

type AssigneeLabelKind = "agent" | "user" | "unassigned";

interface AssigneeLabelProps {
  kind: AssigneeLabelKind;
  label: string;
  badgeLabel?: string | null;
  agentIcon?: string | null;
  agentRole?: AgentRole | null;
  className?: string;
  layout?: "inline" | "stacked";
  muted?: boolean;
}

export function AgentTitleBadge({
  label,
  className,
  constrain = true,
}: {
  label: string;
  className?: string;
  constrain?: boolean;
}) {
  return (
    <span
      data-slot="agent-title-badge"
      className={cn(
        "inline-flex min-w-0 shrink items-center rounded-sm border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium leading-3 text-muted-foreground",
        constrain ? "max-w-[9rem]" : "max-w-full",
        className,
      )}
      title={label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

export function AssigneeLabel({
  kind,
  label,
  badgeLabel,
  agentIcon,
  agentRole,
  className,
  layout = "inline",
  muted = false,
}: AssigneeLabelProps) {
  const stacked = layout === "stacked";

  return (
    <span
      data-slot="assignee-label"
      data-kind={kind}
      data-layout={layout}
      className={cn("inline-flex min-w-0 items-center gap-1.5", stacked && "w-full items-start", className)}
    >
      {kind === "agent" ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
          <AgentIcon icon={agentIcon} role={agentRole} className="h-3.5 w-3.5" />
        </span>
      ) : (
        <Avatar size="sm">
          <AvatarFallback
            className={cn(
              kind === "unassigned" && "border border-dashed border-muted-foreground/35 bg-muted/30",
            )}
          >
            {kind === "user" ? <User className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
          </AvatarFallback>
        </Avatar>
      )}
      <span className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5",
        stacked && "flex-1 flex-col items-start gap-1",
      )}>
        <span className={cn("truncate text-xs", muted && "text-muted-foreground")}>{label}</span>
        {badgeLabel ? <AgentTitleBadge label={badgeLabel} constrain={!stacked} /> : null}
      </span>
    </span>
  );
}
