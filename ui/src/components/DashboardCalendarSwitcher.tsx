import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { Link, useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";
import { CalendarDays, LayoutDashboard } from "lucide-react";

function dashboardCalendarMode(pathname: string): "dashboard" | "calendar" {
  const relativePath = toOrganizationRelativePath(pathname);
  if (/^\/(?:dashboard\/calendar|calendar)(?:\/|$)/.test(relativePath)) return "calendar";
  return "dashboard";
}

export function DashboardCalendarSwitcher({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const location = useLocation();
  const mode = dashboardCalendarMode(location.pathname);

  return (
    <nav
      aria-label="Dashboard section"
      data-testid="dashboard-calendar-switcher"
      data-mode={mode}
      className={cn(
        "desktop-window-no-drag relative grid h-9 w-[232px] grid-cols-2 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] p-0.5 text-[13px] shadow-[0_8px_22px_-18px_rgba(15,23,42,0.42)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0.5 top-0.5 h-8 w-[calc(50%-2px)] rounded-[calc(var(--radius-sm)-1px)] bg-foreground shadow-[0_8px_20px_-14px_rgba(15,23,42,0.75)] transition-transform duration-200 ease-out motion-reduce:transition-none",
          mode === "calendar" && "translate-x-full",
        )}
      />
      <Link
        to="/dashboard"
        aria-current={mode === "dashboard" ? "page" : undefined}
        className={cn(
          "relative z-10 inline-flex min-w-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] font-medium transition-colors",
          compact ? "gap-1 px-1.5" : "gap-1.5 px-2",
          mode === "dashboard" ? "text-background" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {!compact ? <LayoutDashboard className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="truncate">Dashboard</span>
      </Link>
      <Link
        to="/dashboard/calendar"
        aria-current={mode === "calendar" ? "page" : undefined}
        className={cn(
          "relative z-10 inline-flex min-w-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] font-medium transition-colors",
          compact ? "gap-1 px-1.5" : "gap-1.5 px-2",
          mode === "calendar" ? "text-background" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {!compact ? <CalendarDays className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="truncate">Calendar</span>
      </Link>
    </nav>
  );
}
