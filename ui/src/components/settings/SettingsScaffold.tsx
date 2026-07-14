import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";

export function SettingsPage({
  width = "default",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  width?: "default" | "wide" | "full";
}) {
  return (
    <div
      {...props}
      data-slot="settings-page"
      data-width={width}
      className={cn(
        "mx-auto flex w-full flex-col gap-7 px-4 pb-10 sm:px-7",
        width === "default" && "max-w-[52rem]",
        width === "wide" && "max-w-[64rem]",
        width === "full" && "max-w-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsPageHeader({
  eyebrow,
  icon: Icon,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header data-slot="settings-page-header" className="flex flex-col gap-2">
      {eyebrow ? (
        <div className="text-[11px] font-medium text-muted-foreground/72">
          {eyebrow}
        </div>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon ? <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" /> : null}
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="font-display text-[1.4rem] font-semibold leading-tight text-foreground sm:text-[1.55rem]">
              {title}
            </h1>
            {description ? (
              <div className="max-w-3xl text-[13px] leading-5 text-muted-foreground">
                {description}
              </div>
            ) : null}
          </div>
        </div>
        {action ? <div className="flex shrink-0 items-center sm:justify-end">{action}</div> : null}
      </div>
    </header>
  );
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
        "overflow-hidden rounded-lg border border-[color:var(--border-soft)] [&>[data-slot=settings-actions]]:border-t [&>[data-slot=settings-actions]]:border-[color:var(--border-soft)] [&>[data-slot=settings-item]+[data-slot=settings-item]]:border-t [&>[data-slot=settings-item]+[data-slot=settings-item]]:border-[color:var(--border-soft)]",
        variant === "feature"
          ? "bg-[color:var(--surface-elevated)]"
          : "bg-[color:color-mix(in_oklab,var(--surface-inset)_84%,var(--surface-elevated))]",
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
        "grid min-h-[4.25rem] grid-cols-1 items-center gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? (
          <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">
            <Icon className="size-5" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <Heading className="text-[14px] font-medium leading-5 text-foreground">{title}</Heading>
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
    <section data-slot="settings-section" className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="max-w-3xl text-[13px] leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsField({
  label,
  description,
  htmlFor,
  icon: Icon,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: LabelHTMLAttributes<HTMLLabelElement>["htmlFor"];
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const fieldHeading = (
    <>
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
      {label}
    </>
  );

  return (
    <div data-slot="settings-item" className={cn("flex flex-col gap-3 px-4 py-4", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="flex items-center gap-2 text-[14px] font-medium leading-5 text-foreground">
            {fieldHeading}
          </label>
        ) : (
          <div className="flex items-center gap-2 text-[14px] font-medium leading-5 text-foreground">
            {fieldHeading}
          </div>
        )}
        {description ? (
          <div className="max-w-[42rem] text-[13px] leading-5 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-actions"
      className={cn("flex flex-wrap items-center justify-end gap-2 px-4 py-3", className)}
    >
      {children}
    </div>
  );
}

export function SettingsChoiceGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-choice-grid"
      className={cn("flex flex-wrap gap-2.5", className)}
    >
      {children}
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
    <ToggleSwitch checked={checked} size="md" tone="accent" className={cn(className)} {...props} />
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
      data-slot="settings-choice-card"
      aria-pressed={selected}
      className={cn(
        "group flex min-w-[var(--settings-choice-min-width)] flex-col gap-[var(--settings-choice-gap)] rounded-lg border px-[var(--settings-choice-padding-x)] py-[var(--settings-choice-padding-y)] text-left text-[length:var(--settings-choice-label-size)] outline-none transition-[border-color,background-color,box-shadow,transform] hover:bg-[color:var(--surface-elevated)] active:translate-y-px focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/45",
        selected
          ? "border-[color:color-mix(in_oklab,var(--accent-base)_74%,var(--border-strong))] bg-[color:var(--surface-elevated)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent-base)_28%,transparent)]"
          : "border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-inset)_84%,var(--surface-elevated))]",
        className,
      )}
      {...props}
    >
      <div className="overflow-hidden rounded-[var(--settings-choice-preview-radius)]">
        {preview}
      </div>
      <div className="flex flex-col gap-0.5">
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
