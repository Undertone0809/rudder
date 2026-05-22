import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { getPriorityConfig, priorityConfig, priorityValues, type PriorityValue } from "../lib/priorities";
const barHeights = ["h-1", "h-1.5", "h-2.5", "h-3.5"];

export const priorityPickerContentClassName =
  "w-48 rounded-lg border-[color:var(--border-base)] bg-[color:var(--surface-overlay)] p-1.5 shadow-[var(--shadow-md)]";

export function PriorityBarsIcon({
  priority,
  className,
}: {
  priority: string;
  className?: string;
}) {
  const config = getPriorityConfig(priority);

  return (
    <span
      data-slot="priority-bars-icon"
      className={cn("inline-flex h-3.5 w-4 items-end gap-[2px]", config.color, className)}
      aria-hidden="true"
    >
      {barHeights.map((height, index) => (
        <span
          key={height}
          className={cn(
            "w-[3px] rounded-[1px] bg-current",
            height,
            index >= config.level && "opacity-25",
          )}
        />
      ))}
    </span>
  );
}

export function PriorityPickerOption({
  priority,
  selected,
  onSelect,
}: {
  priority: PriorityValue;
  selected: boolean;
  onSelect: (priority: PriorityValue) => void;
}) {
  const config = priorityConfig[priority];

  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={cn(
        "group flex h-8 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-active)] focus-visible:bg-[color:var(--surface-active)] focus-visible:outline-none",
        selected && "bg-[color:color-mix(in_oklab,var(--surface-active)_72%,transparent)] text-foreground",
      )}
      onClick={() => onSelect(priority)}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <PriorityBarsIcon priority={priority} className="shrink-0" />
        <span className={cn("truncate", config.menuLabelClassName)}>{config.label}</span>
      </span>
      {selected ? (
        <Check data-slot="priority-menu-check" className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

interface PriorityIconProps {
  priority: string;
  onChange?: (priority: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function PriorityIcon({ priority, onChange, className, showLabel }: PriorityIconProps) {
  const [open, setOpen] = useState(false);
  const config = getPriorityConfig(priority);

  const icon = (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        onChange && !showLabel && "cursor-pointer",
        className
      )}
    >
      <PriorityBarsIcon priority={priority} />
    </span>
  );

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{icon}<span className="text-sm">{config.label}</span></span> : icon;

  const trigger = showLabel ? (
    <button type="button" className="-mx-1 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-[color:var(--surface-active)]">
      {icon}
      <span className="text-sm">{config.label}</span>
    </button>
  ) : icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={priorityPickerContentClassName} align="start" role="menu" aria-label="Issue priority">
        {priorityValues.map((p) => {
          const selected = p === priority;
          return (
            <PriorityPickerOption
              key={p}
              priority={p}
              selected={selected}
              onSelect={(nextPriority) => {
                onChange(nextPriority);
                setOpen(false);
              }}
            />
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
