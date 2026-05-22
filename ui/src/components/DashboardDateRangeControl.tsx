import { CalendarDays } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";
import { useSlidingIndicator } from "../hooks/useSlidingIndicator";

export type DashboardDatePreset = "7d" | "15d" | "30d" | "custom";

const DASHBOARD_DATE_PRESETS: Array<{ key: DashboardDatePreset; label: string }> = [
  { key: "7d", label: "7D" },
  { key: "15d", label: "15D" },
  { key: "30d", label: "1M" },
  { key: "custom", label: "Custom" },
];

interface DashboardDateRangeControlProps {
  preset: DashboardDatePreset;
  customFrom: string;
  customTo: string;
  customOpen: boolean;
  onCustomOpenChange: (open: boolean) => void;
  onPresetSelect: (preset: DashboardDatePreset) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  description?: string;
}

export function DashboardDateRangeControl({
  preset,
  customFrom,
  customTo,
  customOpen,
  onCustomOpenChange,
  onPresetSelect,
  onCustomFromChange,
  onCustomToChange,
  description = "Filter charts, skills analytics, and recent lists by a specific date window.",
}: DashboardDateRangeControlProps) {
  const {
    containerRef,
    indicatorReady,
    indicatorStyle,
    setItemRef,
  } = useSlidingIndicator<HTMLButtonElement>(
    preset,
    DASHBOARD_DATE_PRESETS.map((option) => option.key),
  );

  const buttonClassName = (active: boolean) => cn(
    "relative z-10 h-8 rounded-full px-3 text-xs font-medium transition-[color,transform] duration-200 active:scale-[0.97]",
    active
      ? "text-foreground"
      : "text-muted-foreground hover:text-foreground",
  );

  return (
    <div className="flex justify-end">
      <div
        ref={containerRef}
        className="relative inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-background/80 p-1 shadow-sm"
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute bottom-1 left-0 top-1 rounded-full bg-background shadow-sm ring-1 ring-[color:var(--border-soft)] transition-[transform,width,opacity] duration-300 ease-out motion-reduce:transition-none",
            indicatorReady ? "opacity-100" : "opacity-0",
          )}
          style={indicatorStyle}
        />
        {DASHBOARD_DATE_PRESETS.filter((option) => option.key !== "custom").map((option) => (
          <button
            key={option.key}
            ref={setItemRef(option.key)}
            type="button"
            onClick={() => onPresetSelect(option.key)}
            className={buttonClassName(preset === option.key)}
            aria-pressed={preset === option.key}
          >
            {option.label}
          </button>
        ))}
        <Popover open={customOpen} onOpenChange={onCustomOpenChange}>
          <PopoverTrigger asChild>
            <button
              ref={setItemRef("custom")}
              type="button"
              onClick={() => onPresetSelect("custom")}
              className={cn(buttonClassName(preset === "custom"), "flex items-center gap-1.5")}
              aria-pressed={preset === "custom"}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Custom
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[24rem] p-3">
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium text-foreground">Custom range</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {description}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
                  <span>From</span>
                  <input
                    aria-label="From"
                    type="date"
                    value={customFrom}
                    onChange={(event) => onCustomFromChange(event.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  />
                </label>
                <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
                  <span>To</span>
                  <input
                    aria-label="To"
                    type="date"
                    value={customTo}
                    onChange={(event) => onCustomToChange(event.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  />
                </label>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
