import { cn } from "@/lib/utils";

export function HeartbeatEnabledButtons({
  onPressed,
  disabled,
  onEnable,
  onDisable,
  onLabel = "On",
  offLabel = "Off",
  ariaLabel = "Timer heartbeat state",
}: {
  onPressed: boolean;
  disabled: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onLabel?: string;
  offLabel?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)]"
    >
      <button
        type="button"
        aria-pressed={onPressed}
        disabled={disabled}
        className={cn(
          "h-7 min-w-10 border-r border-[color:var(--border-base)] px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          onPressed
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
        )}
        onClick={onEnable}
      >
        {onLabel}
      </button>
      <button
        type="button"
        aria-pressed={!onPressed}
        disabled={disabled}
        className={cn(
          "h-7 min-w-10 px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          !onPressed
            ? "bg-secondary text-secondary-foreground"
            : "text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
        )}
        onClick={onDisable}
      >
        {offLabel}
      </button>
    </div>
  );
}
