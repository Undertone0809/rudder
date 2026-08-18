import { Button } from "@/components/ui/button";
import { Calendar as DateCalendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDateOnly, formatLocalDateOnly, parseDateOnlyValue } from "../lib/date-only";

export function GoalTargetTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const selected = parseDateOnlyValue(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Date | null>(selected);

  useEffect(() => setDraft(selected), [value]);

  const chooseDate = (date: Date | undefined) => {
    if (!date) return;
    setDraft(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0));
  };

  return (
    <Popover open={open} onOpenChange={(nextOpen) => { if (!nextOpen) setDraft(selected); setOpen(nextOpen); }}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Target date" className="flex min-h-10 min-w-0 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={selected ? "min-w-0 flex-1 truncate text-foreground" : "min-w-0 flex-1 truncate text-muted-foreground"}>{selected ? formatDateOnly(value) : "Set a target date"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="max-h-[calc(100dvh-1rem)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
      >
        <div className="flex flex-col gap-2 p-2 sm:p-3">
          <DateCalendar mode="single" selected={draft ?? undefined} onSelect={chooseDate} defaultMonth={draft ?? new Date()} initialFocus className="max-sm:!p-2 max-sm:[--cell-size:1.75rem]" />
          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(null); onChange(""); setOpen(false); }}>Clear</Button>
            <Button type="button" size="sm" onClick={() => { if (draft) onChange(formatLocalDateOnly(draft)); setOpen(false); }} disabled={!draft}>Done</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
