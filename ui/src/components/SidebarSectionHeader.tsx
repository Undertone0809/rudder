import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

interface SidebarSectionHeaderProps {
  label: string;
  action?: ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}

const labelClassName = "truncate text-[10px] font-medium tracking-[0.08em] text-muted-foreground/60";
const chevronSlotClassName = "flex h-3 w-3 shrink-0 items-center justify-center";
const actionButtonClassName =
  "flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground";

type SidebarSectionActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function SidebarSectionActionButton({
  className,
  type = "button",
  ...props
}: SidebarSectionActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(actionButtonClassName, className)}
      {...props}
    />
  );
}

export function SidebarSectionHeader({
  label,
  action,
  collapsible = false,
  open = false,
  onToggle,
}: SidebarSectionHeaderProps) {
  return (
    <div className="group flex items-center px-3 py-1.5">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <span className={chevronSlotClassName}>
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90",
              )}
            />
          </span>
          <span className={labelClassName}>{label}</span>
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span aria-hidden className={chevronSlotClassName} />
          <span className={labelClassName}>{label}</span>
        </div>
      )}
      {action ? <div className="ml-2 shrink-0">{action}</div> : null}
    </div>
  );
}
