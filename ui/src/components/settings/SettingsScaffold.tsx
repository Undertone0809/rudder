import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

export function SettingsPageHeader({
  eyebrow,
  icon: Icon,
  title,
  description,
}: {
  eyebrow?: string;
  icon?: LucideIcon;
  title: string;
  description: ReactNode;
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
          <p className="max-w-3xl text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
    </header>
  );
}

export function SettingsDivider() {
  return <div className="border-t border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)]" />;
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
      className={cn(
        "group flex min-w-[7.75rem] flex-col gap-2 rounded-[calc(var(--radius-md)-1px)] border px-2.5 py-2.5 text-left transition-[border-color,background-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)]",
        selected
          ? "border-[color:color-mix(in_oklab,var(--accent-base)_82%,white)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent-base)_42%,transparent)]"
          : "border-[color:color-mix(in_oklab,var(--border-soft)_92%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)]",
        className,
      )}
      {...props}
    >
      <div className="overflow-hidden rounded-[calc(var(--radius-md)-4px)]">
        {preview}
      </div>
      <div className="space-y-0.5">
        <div className="text-[12px] font-medium text-foreground">{label}</div>
        {description ? <div className="text-[11px] leading-4 text-muted-foreground">{description}</div> : null}
      </div>
    </button>
  );
}
