import { cloneElement, type ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ExactTimestampTriggerProps = {
  title?: string;
  "aria-label"?: string;
};

export function formatExactTimestamp(date: Date | string): string {
  const timestamp = new Date(date);
  const includeYear = timestamp.getFullYear() !== new Date().getFullYear();
  return timestamp.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HoverTimestampLabel({
  date,
  label,
  className,
  testId,
}: {
  date: Date | string;
  label: string;
  className?: string;
  testId?: string;
}) {
  const exactLabel = formatExactTimestamp(date);

  return (
    <span
      data-testid={testId}
      title={exactLabel}
      aria-label={exactLabel}
      className={cn("inline-grid whitespace-nowrap tabular-nums", className)}
    >
      <span
        aria-hidden
        className="col-start-1 row-start-1 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
      >
        {label}
      </span>
      <span
        aria-hidden
        className="col-start-1 row-start-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {exactLabel}
      </span>
    </span>
  );
}

export function ExactTimestampTooltip({
  date,
  children,
  side = "top",
}: {
  date: Date | string;
  children: ReactElement<ExactTimestampTriggerProps>;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const exactLabel = formatExactTimestamp(date);
  const trigger = cloneElement(children, {
    title: children.props.title ?? exactLabel,
    "aria-label": children.props["aria-label"] ?? exactLabel,
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side} className="px-2.5 py-1.5 text-[11px] tabular-nums tracking-normal">
        {exactLabel}
      </TooltipContent>
    </Tooltip>
  );
}
