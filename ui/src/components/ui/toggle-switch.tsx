import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ToggleSwitchSize = "sm" | "md" | "lg";
type ToggleSwitchTone = "accent" | "success";

const SIZE_STYLES: Record<ToggleSwitchSize, { track: string; thumb: string; checked: string; unchecked: string }> = {
  sm: {
    track: "h-5 w-9",
    thumb: "h-3.5 w-3.5",
    checked: "translate-x-4.5",
    unchecked: "translate-x-0.5",
  },
  md: {
    track: "h-6 w-11",
    thumb: "h-5 w-5",
    checked: "translate-x-5",
    unchecked: "translate-x-0.5",
  },
  lg: {
    track: "h-7 w-12",
    thumb: "h-5 w-5",
    checked: "translate-x-[1.45rem]",
    unchecked: "translate-x-1",
  },
};

const TONE_STYLES: Record<ToggleSwitchTone, string> = {
  accent:
    "bg-[color:var(--accent-base)] border-[color:color-mix(in_oklab,var(--accent-base)_72%,white)] text-primary-foreground",
  success:
    "bg-emerald-600 border-emerald-500/80 text-white dark:bg-emerald-500 dark:border-emerald-400/45",
};

export type ToggleSwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  checked: boolean;
  size?: ToggleSwitchSize;
  tone?: ToggleSwitchTone;
  thumbClassName?: string;
};

export function ToggleSwitch({
  checked,
  className,
  thumbClassName,
  size = "md",
  tone = "accent",
  type = "button",
  ...props
}: ToggleSwitchProps) {
  const sizeStyles = SIZE_STYLES[size];

  return (
    <button
      type={type}
      role="switch"
      data-slot="toggle"
      data-state={checked ? "checked" : "unchecked"}
      aria-checked={checked}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border transition-[background-color,border-color,box-shadow,opacity] disabled:cursor-not-allowed disabled:opacity-60",
        sizeStyles.track,
        checked
          ? TONE_STYLES[tone]
          : "bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)] border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "inline-block rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_80%,transparent)] bg-[color:var(--surface-elevated)] shadow-[0_4px_12px_rgb(0_0_0/0.18)] transition-transform",
          sizeStyles.thumb,
          checked ? sizeStyles.checked : sizeStyles.unchecked,
          thumbClassName,
        )}
      />
    </button>
  );
}
