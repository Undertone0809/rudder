import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
  size?: "compact" | "default";
  className?: string;
}

export function EmptyState({ icon: Icon, message, action, onAction, size = "default", className }: EmptyStateProps) {
  const compact = size === "compact";

  return (
    <div
      className={cn(
        "surface-panel mx-auto flex rounded-[var(--radius-xl)]",
        compact
          ? "max-w-none flex-row items-start justify-start gap-3 px-4 py-4 text-left"
          : "max-w-xl flex-col items-center justify-center px-8 py-14 text-center",
        className,
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-[calc(var(--radius-md)+4px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-proposal)_72%,transparent)]",
          compact ? "h-10 w-10" : "mb-5 h-16 w-16",
        )}
      >
        <Icon className={cn("text-[color:var(--accent-base)]", compact ? "h-5 w-5" : "h-8 w-8")} />
      </div>
      <div className={cn("min-w-0", compact ? "pt-0.5" : "")}>
        <p className={cn("font-display leading-tight text-foreground", compact ? "text-base" : "text-[1.5rem]")}>
          Nothing here yet
        </p>
        <p className={cn("max-w-md text-sm leading-6 text-muted-foreground", compact ? "mt-1" : "mt-3")}>
          {message}
        </p>
        {action && onAction && (
          <Button onClick={onAction} className={compact ? "mt-3" : "mt-6"} size={compact ? "sm" : "default"}>
            <Plus className="mr-1.5 h-4 w-4" />
            {action}
          </Button>
        )}
      </div>
    </div>
  );
}
