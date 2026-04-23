import { NavLink, useNavigate } from "@/lib/router";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { sidebarItemVariants } from "./sidebarItemStyles";
import type { LucideIcon } from "lucide-react";

interface SidebarNavItemProps {
  to: string;
  state?: unknown;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  variant?: "default" | "compact";
  badge?: number;
  badgeTone?: "default" | "danger";
  textBadge?: string;
  textBadgeTone?: "default" | "amber";
  alert?: boolean;
  liveCount?: number;
}

export function SidebarNavItem({
  to,
  state,
  label,
  icon: Icon,
  end,
  className,
  variant = "default",
  badge,
  badgeTone = "default",
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const navigate = useNavigate();

  return (
    <NavLink
      to={to}
      state={state}
      end={end}
      onClick={(event) => {
        if (state !== undefined) {
          event.preventDefault();
          navigate(to, { state });
        }
        if (isMobile) setSidebarOpen(false);
      }}
      className={({ isActive }) =>
        cn(
          sidebarItemVariants({ variant, active: isActive }),
          className,
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
        )}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {textBadge && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
            textBadgeTone === "amber"
              ? "border border-amber-200/80 bg-amber-100/85 text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/30 dark:text-amber-200"
              : "border border-[color:var(--border-soft)] bg-muted text-muted-foreground",
          )}
        >
          {textBadge}
        </span>
      )}
      {liveCount != null && liveCount > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-[color:var(--accent-base)] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--accent-strong)]" />
          </span>
          <span className="text-[11px] font-medium text-[color:var(--accent-strong)]">{liveCount} live</span>
        </span>
      )}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "ml-auto rounded-full border px-1.5 py-0.5 text-xs leading-none shadow-[var(--shadow-sm)]",
            badgeTone === "danger"
              ? "border-red-700/20 bg-red-600/90 text-red-50"
              : "border-transparent bg-primary text-primary-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}
