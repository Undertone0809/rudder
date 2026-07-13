import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function SettingsPageHeader({
  eyebrow,
  icon: Icon,
  title,
  description,
}: {
  eyebrow?: string;
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
}) {
  return (
    <header className="space-y-2.5">
      {eyebrow ? (
        <div className="text-[10px] font-medium text-muted-foreground/72">
          {eyebrow}
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        {Icon ? <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-muted-foreground" /> : null}
        <div className="space-y-1.5">
          <h1 className="font-display text-[1.4rem] leading-none text-foreground sm:text-[1.55rem]">
            {title}
          </h1>
          {description ? (
            <p className="max-w-3xl text-[13px] leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function SettingsDivider() {
  return <div className="border-t border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)]" />;
}

export function SettingsGroup({
  variant = "default",
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "feature";
}) {
  return (
    <div
      {...props}
      data-slot="settings-group"
      data-variant={variant}
      className={cn(
        "overflow-hidden rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--border-soft)_92%,transparent)] [&>[data-slot=settings-item]+[data-slot=settings-item]]:border-t [&>[data-slot=settings-item]+[data-slot=settings-item]]:border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)]",
        variant === "feature"
          ? "bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)]"
          : "bg-[color:color-mix(in_oklab,var(--surface-inset)_72%,transparent)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsItem({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 3,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <div
      data-slot="settings-item"
      className={cn(
        "grid min-h-[4.5rem] grid-cols-1 items-center gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? (
          <span className="flex size-10 shrink-0 items-center justify-center text-muted-foreground">
            <Icon className="size-6" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <Heading className="text-[14px] font-medium text-foreground">{title}</Heading>
          {description ? (
            <div className="max-w-[38rem] text-[13px] leading-5 text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      {action ? (
        <div className="flex w-full shrink-0 items-center justify-start sm:w-auto sm:justify-end">
          {action}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
  className,
}: HTMLAttributes<HTMLElement> & {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-3.5", className)}>
      <div className="space-y-1">
        <h2 className="text-[1rem] font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
        {description ? (
          <p className="max-w-3xl text-[13px] leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 border-t border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] py-3.5 first:border-t-0 first:pt-0 last:pb-0",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-[14px] font-medium text-foreground">{title}</h3>
        <div className="max-w-3xl text-[13px] leading-5 text-muted-foreground">{description}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SettingsToggle({
  checked,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean;
}) {
  return (
    <ToggleSwitch checked={checked} size="lg" tone="accent" className={cn(className)} {...props} />
  );
}

export function SettingsChoiceCard({
  label,
  description,
  selected = false,
  preview,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  description?: ReactNode;
  selected?: boolean;
  preview: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "group flex min-w-[var(--settings-choice-min-width)] flex-col gap-[var(--settings-choice-gap)] rounded-[var(--settings-choice-radius)] border px-[var(--settings-choice-padding-x)] py-[var(--settings-choice-padding-y)] text-left text-[length:var(--settings-choice-label-size)] transition-[border-color,background-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)]",
        selected
          ? "border-[color:color-mix(in_oklab,var(--accent-base)_82%,white)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent-base)_42%,transparent)]"
          : "border-[color:color-mix(in_oklab,var(--border-soft)_92%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)]",
        className,
      )}
      {...props}
    >
      <div className="overflow-hidden rounded-[var(--settings-choice-preview-radius)]">
        {preview}
      </div>
      <div className="space-y-0.5">
        <div className="font-medium text-foreground">{label}</div>
        {description ? (
          <div className="text-[length:var(--settings-choice-description-size)] leading-4 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
    </button>
  );
}
