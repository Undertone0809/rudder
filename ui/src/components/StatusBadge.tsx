import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-[calc(var(--radius-sm)-1px)] border px-2.5 py-1 text-xs font-medium whitespace-nowrap shadow-[var(--shadow-sm)]",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}
