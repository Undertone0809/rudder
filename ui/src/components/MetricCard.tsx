import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={cn(
        "surface-panel h-full rounded-[var(--radius-lg)] px-4 py-4 sm:px-5 sm:py-5 transition-[background-color,border-color,transform]",
        isClickable && "cursor-pointer hover:surface-active",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-foreground">
            {value}
          </p>
          <p className="mt-1 text-xs font-medium tracking-[0.06em] text-muted-foreground sm:text-sm">
            {label}
          </p>
          {description && (
            <div className="mt-2 hidden text-xs leading-5 text-muted-foreground/85 sm:block">{description}</div>
          )}
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)+2px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)]">
          <Icon className="h-4 w-4 text-[color:var(--accent-strong)]" />
        </div>
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
