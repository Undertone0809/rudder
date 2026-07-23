import { cn } from "@/lib/utils";
import { ListChecks, X } from "lucide-react";
import { PLAN_MODE_HELP_TEXT } from "./Chat.parts";

export function ChatPlanModeMenuToggle({
  active,
  disabled = false,
  onChange,
}: {
  active: boolean;
  disabled?: boolean;
  onChange: (active: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={active} aria-label="Plan mode" aria-busy={disabled || undefined} data-testid="chat-plan-mode-toggle" title={PLAN_MODE_HELP_TEXT} disabled={disabled} className={cn(
      "flex w-full cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
      active && "bg-[color:color-mix(in_oklab,var(--accent-soft)_72%,transparent)] text-foreground focus:bg-[color:color-mix(in_oklab,var(--accent-soft)_88%,transparent)]",
      disabled && "cursor-wait opacity-60",
    )} onClick={(event) => { event.preventDefault(); onChange(!active); }} >
      <div className="flex min-w-0 items-center">
        <ListChecks className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="font-medium text-foreground">Plan mode</div> </div>
      <span aria-hidden="true" data-testid="chat-plan-mode-track" className={cn(
        "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-[background-color,border-color,box-shadow,opacity]",
        active ? "border-[color:color-mix(in_oklab,var(--accent-base)_72%,white)] bg-[color:var(--accent-base)] text-primary-foreground shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent-base)_22%,transparent),0_8px_22px_color-mix(in_oklab,var(--accent-base)_20%,transparent)]" : "border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)] text-muted-foreground",
      )} >
        <span data-testid="chat-plan-mode-thumb" className={cn(
          "inline-block h-5 w-5 rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_80%,transparent)] bg-[color:var(--surface-elevated)] shadow-[0_4px_12px_rgb(0_0_0/0.18)] transition-transform",
          active ? "translate-x-5" : "translate-x-0.5",
        )} /> </span>
    </button>
  );
}

export function ChatPlanModeChip({
  disabled = false,
  onDisable,
}: {
  disabled?: boolean;
  onDisable: () => void;
}) {
  return (
    <button type="button" className="group/plan inline-flex max-w-[10rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[color:color-mix(in_oklab,var(--accent-soft)_78%,var(--surface-elevated))] px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[color:color-mix(in_oklab,var(--accent-soft)_92%,var(--surface-elevated))] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-wait disabled:opacity-60" aria-label="Turn off plan mode" aria-busy={disabled || undefined} title={PLAN_MODE_HELP_TEXT} disabled={disabled} onClick={onDisable} >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <ListChecks data-testid="chat-plan-mode-icon" className="h-3.5 w-3.5 group-hover/plan:hidden" aria-hidden="true" />
        <span data-testid="chat-plan-mode-dismiss-icon" className="hidden h-4 w-4 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--ink-muted)_78%,transparent)] text-[color:var(--surface-elevated)] group-hover/plan:inline-flex">
          <X className="h-3 w-3" strokeWidth={2.6} aria-hidden="true" /> </span> </span>
      <span className="min-w-0 truncate">Plan</span>
    </button>
  );
}
