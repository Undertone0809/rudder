import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check } from "lucide-react";
import { useState } from "react";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import { cn } from "../lib/utils";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

const statusIconMenuClassName =
  "w-48 rounded-lg border-[color:var(--border-base)] bg-[color:var(--surface-overlay)] p-1.5 shadow-[var(--shadow-md)]";

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatusIconProps {
  status: string;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
}

function IssueStatusGlyph({ status, className }: { status: string; className?: string }) {
  const colorClass = issueStatusIcon[status] ?? issueStatusIconDefault;
  const normalizedStatus = allStatuses.includes(status) ? status : "default";

  return (
    <span
      data-slot="issue-status-icon"
      data-status={status}
      className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center", colorClass, className)}
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16" className="h-full w-full overflow-visible" fill="none">
        {normalizedStatus === "backlog" && (
          <circle
            data-slot="status-backlog-ring"
            cx="8"
            cy="8"
            r="5.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="1 3"
            strokeLinecap="round"
          />
        )}
        {normalizedStatus === "todo" && (
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" />
        )}
        {normalizedStatus === "in_progress" && (
          <>
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" opacity="0.22" />
            <path
              data-slot="status-progress-arc"
              d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path
              d="M13.5 8a5.5 5.5 0 0 1-5.5 5.5"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              opacity="0.72"
            />
          </>
        )}
        {normalizedStatus === "in_review" && (
          <>
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" />
            <circle data-slot="status-review-dot" cx="8" cy="8" r="2" fill="currentColor" />
          </>
        )}
        {normalizedStatus === "done" && (
          <>
            <circle cx="8" cy="8" r="6.5" fill="currentColor" />
            <path
              data-slot="status-done-check"
              d="M4.75 8.25 7 10.5l4.25-5"
              stroke="var(--background)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {normalizedStatus === "cancelled" && (
          <>
            <circle cx="8" cy="8" r="6" fill="currentColor" opacity="0.16" />
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" />
            <path
              data-slot="status-cancel-mark"
              d="m5.25 5.25 5.5 5.5m0-5.5-5.5 5.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </>
        )}
        {normalizedStatus === "blocked" && (
          <>
            <path
              d="M5.1 2.25h5.8l3.05 3.05v5.4l-3.05 3.05H5.1L2.05 10.7V5.3Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path
              data-slot="status-blocked-mark"
              d="m5.25 5.25 5.5 5.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </>
        )}
        {normalizedStatus === "default" && (
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" />
        )}
      </svg>
    </span>
  );
}

function StatusPickerOption({
  status,
  selected,
  onSelect,
}: {
  status: string;
  selected: boolean;
  onSelect: (status: string) => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={cn(
        "group flex h-8 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-[color:var(--surface-active)] focus-visible:bg-[color:var(--surface-active)] focus-visible:outline-none",
        selected && "bg-[color:color-mix(in_oklab,var(--surface-active)_72%,transparent)] text-foreground",
      )}
      onClick={() => onSelect(status)}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <IssueStatusGlyph status={status} />
        <span className="truncate">{statusLabel(status)}</span>
      </span>
      {selected ? (
        <Check data-slot="status-menu-check" className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

export function StatusIcon({ status, onChange, className, showLabel }: StatusIconProps) {
  const [open, setOpen] = useState(false);
  const icon = <IssueStatusGlyph status={status} className={className} />;

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{icon}<span className="text-sm">{statusLabel(status)}</span></span> : icon;

  const trigger = showLabel ? (
    <button type="button" className="-mx-1 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
      {icon}
      <span className="text-sm">{statusLabel(status)}</span>
    </button>
  ) : (
    <button type="button" className="inline-flex cursor-pointer items-center justify-center rounded-sm transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
      {icon}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={statusIconMenuClassName} align="start" role="menu" aria-label="Issue status">
        {allStatuses.map((s) => (
          <StatusPickerOption
            key={s}
            status={s}
            selected={s === status}
            onSelect={(nextStatus) => {
              onChange(nextStatus);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
