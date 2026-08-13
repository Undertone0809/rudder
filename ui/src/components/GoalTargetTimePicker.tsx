import { Button } from "@/components/ui/button";
import { Calendar as DateCalendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, Clock3 } from "lucide-react";
import { useEffect, useState } from "react";
import { toDateTimeLocalValue } from "../lib/datetime-local";

const padTimePart = (value: number) => String(value).padStart(2, "0");

function parseTargetTime(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTargetTime(value: string) {
  const date = parseTargetTime(value);
  if (!date) return "Set a target time";
  return `${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} at ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function isNestedSelectTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('[data-slot="select-content"]'));
}

export function GoalTargetTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const selected = parseTargetTime(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Date | null>(selected);
  const draftTime = draft ?? new Date();

  useEffect(() => setDraft(selected), [value]);

  const chooseDate = (date: Date | undefined) => {
    if (!date) return;
    const next = new Date(date);
    next.setHours(draftTime.getHours(), draftTime.getMinutes(), 0, 0);
    setDraft(next);
  };

  const chooseTime = (part: "hours" | "minutes", rawValue: string) => {
    const next = new Date(draftTime);
    next.setSeconds(0, 0);
    next[part === "hours" ? "setHours" : "setMinutes"](Number(rawValue));
    setDraft(next);
  };

  return (
    <Popover open={open} onOpenChange={(nextOpen) => { if (!nextOpen) setDraft(selected); setOpen(nextOpen); }}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Target time" className="flex min-h-10 min-w-0 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring">
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={selected ? "min-w-0 flex-1 truncate text-foreground" : "min-w-0 flex-1 truncate text-muted-foreground"}>{formatTargetTime(value)}</span>
          <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="max-h-[calc(100dvh-1rem)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
        onInteractOutside={(event) => { if (isNestedSelectTarget(event.target)) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (isNestedSelectTarget(event.target)) event.preventDefault(); }}
      >
        <div className="flex flex-col gap-2 p-2 sm:flex-row sm:gap-3 sm:p-3">
          <DateCalendar mode="single" selected={draft ?? undefined} onSelect={chooseDate} defaultMonth={draft ?? new Date()} initialFocus className="max-sm:!p-2 max-sm:[--cell-size:1.75rem]" />
          <div className="flex min-w-44 flex-col gap-2 border-t border-border pt-2 sm:gap-3 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />Time</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Hour
                <Select value={padTimePart(draftTime.getHours())} onValueChange={(next) => chooseTime("hours", next)}><SelectTrigger aria-label="Target hour" className="w-full"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start" className="max-h-56"><SelectGroup>{Array.from({ length: 24 }, (_, hour) => <SelectItem key={hour} value={padTimePart(hour)}>{padTimePart(hour)}</SelectItem>)}</SelectGroup></SelectContent></Select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Minute
                <Select value={padTimePart(draftTime.getMinutes())} onValueChange={(next) => chooseTime("minutes", next)}><SelectTrigger aria-label="Target minute" className="w-full"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start" className="max-h-56"><SelectGroup>{Array.from({ length: 60 }, (_, minute) => <SelectItem key={minute} value={padTimePart(minute)}>{padTimePart(minute)}</SelectItem>)}</SelectGroup></SelectContent></Select>
              </label>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(null); onChange(""); setOpen(false); }}>Clear</Button>
              <Button type="button" size="sm" onClick={() => { if (draft) onChange(toDateTimeLocalValue(draft)); setOpen(false); }} disabled={!draft}>Done</Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
