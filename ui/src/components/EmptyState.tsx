import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({ icon: Icon, message, action, onAction, className }: EmptyStateProps) {
  return (
    <div className={cn("surface-panel mx-auto flex max-w-xl flex-col items-center justify-center rounded-[var(--radius-xl)] px-8 py-14 text-center", className)}>
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-[calc(var(--radius-md)+4px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-proposal)_72%,transparent)]">
        <Icon className="h-8 w-8 text-[color:var(--accent-base)]" />
      </div>
      <p className="font-display text-[1.5rem] leading-tight text-foreground">Nothing here yet</p>
      <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
      {action && onAction && (
        <Button onClick={onAction} className="mt-6">
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
