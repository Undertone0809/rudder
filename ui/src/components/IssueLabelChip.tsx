import type { IssueLabel } from "@rudderhq/shared";
import { cn } from "@/lib/utils";

type IssueLabelChipSize = "xs" | "sm";

const sizeClasses: Record<IssueLabelChipSize, string> = {
  xs: "gap-1 px-1.5 py-0.5 text-[10px]",
  sm: "gap-1.5 px-2 py-0.5 text-xs",
};

const dotClasses: Record<IssueLabelChipSize, string> = {
  xs: "h-1.5 w-1.5",
  sm: "h-2 w-2",
};

export function IssueLabelChip({
  label,
  size = "xs",
  className,
}: {
  label: Pick<IssueLabel, "name" | "color">;
  size?: IssueLabelChipSize;
  className?: string;
}) {
  return (
    <span
      data-slot="issue-label-chip"
      className={cn(
        "inline-flex max-w-full items-center rounded-[calc(var(--radius-sm)-2px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_78%,transparent)] font-medium text-muted-foreground",
        sizeClasses[size],
        className,
      )}
      title={label.name}
    >
      <span
        className={cn("shrink-0 rounded-full", dotClasses[size])}
        style={{ backgroundColor: label.color }}
        aria-hidden="true"
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}
