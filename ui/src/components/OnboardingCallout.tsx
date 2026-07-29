import { cn } from "@/lib/utils";
import { useId, type ReactNode } from "react";

export function OnboardingCallout({
  icon,
  title,
  description,
  actions,
  stackActions = false,
  className,
  testId,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  stackActions?: boolean;
  className?: string;
  testId?: string;
}) {
  const titleId = useId();

  return (
    <aside
      role="status"
      aria-live="polite"
      aria-labelledby={titleId}
      data-testid={testId}
      className={cn(
        "rounded-[var(--radius-md)] border border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] px-3.5 py-3 shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <div
        className={cn(
          "grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5",
          !stackActions && "sm:grid-cols-[2rem_minmax(0,1fr)_auto]",
        )}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[color:var(--surface-active)] text-foreground [&_svg]:size-4">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-sm font-semibold leading-5 text-foreground">
            {title}
          </h3>
          <div className="mt-0.5 max-w-3xl text-xs leading-5 text-muted-foreground">
            {description}
          </div>
        </div>
        {actions ? (
          <div
            data-onboarding-actions={stackActions ? "stacked" : "responsive"}
            className={cn(
              "col-start-2 flex flex-wrap items-center gap-2",
              !stackActions && "sm:col-start-3 sm:row-start-1 sm:justify-end",
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
