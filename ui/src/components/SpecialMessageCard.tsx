import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type SpecialMessageCardVariant = "info" | "success" | "error";

const variantStyles: Record<SpecialMessageCardVariant, string> = {
  info: "border-blue-200/80 bg-blue-50 text-blue-950 dark:border-blue-800/70 dark:bg-blue-950/45 dark:text-blue-100",
  success: "border-emerald-200/80 bg-emerald-50 text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/45 dark:text-emerald-100",
  error: "border-red-200/80 bg-red-50 text-red-950 dark:border-red-800/70 dark:bg-red-950/45 dark:text-red-100",
};

export function SpecialMessageCard({
  variant,
  title,
  headerMeta,
  description,
  children,
  actions,
  className,
  testId,
  ariaLabel,
}: {
  variant: SpecialMessageCardVariant;
  title: ReactNode;
  headerMeta?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <section
      data-testid={testId}
      aria-label={ariaLabel}
      className={cn(
        "overflow-hidden rounded-[var(--radius-md)] border border-border/80 bg-background shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <header className={cn("flex min-w-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3", variantStyles[variant])}>
        <h3 className="min-w-0 break-words text-sm font-semibold leading-5">{title}</h3>
        {headerMeta ? <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs font-medium">{headerMeta}</div> : null}
      </header>
      <div className="space-y-3 px-4 py-3.5">
        {description ? <div className="break-words text-sm leading-6 text-foreground">{description}</div> : null}
        {children}
      </div>
      {actions ? <footer className="border-t border-border/70 px-4 py-3">{actions}</footer> : null}
    </section>
  );
}
