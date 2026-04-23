import { Minus, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "./AgentIconPicker";
import { cn } from "@/lib/utils";

type AssigneeLabelKind = "agent" | "user" | "unassigned";

interface AssigneeLabelProps {
  kind: AssigneeLabelKind;
  label: string;
  agentIcon?: string | null;
  className?: string;
  muted?: boolean;
}

export function AssigneeLabel({ kind, label, agentIcon, className, muted = false }: AssigneeLabelProps) {
  return (
    <span
      data-slot="assignee-label"
      data-kind={kind}
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
    >
      {kind === "agent" ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
          <AgentIcon icon={agentIcon} className="h-3.5 w-3.5" />
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
      <span className={cn("truncate text-xs", muted && "text-muted-foreground")}>{label}</span>
    </span>
  );
}
