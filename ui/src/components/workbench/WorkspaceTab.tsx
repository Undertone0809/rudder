import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  KeyboardEvent,
  ReactNode,
  Ref,
} from "react";

type WorkspaceTabActivatorProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "disabled" | "id" | "onClick" | "onFocus" | "onKeyDown" | "role"
> & {
  [key: `data-${string}`]: string | undefined;
};

export function WorkspaceTab({
  active,
  activatorProps,
  buttonRef,
  children,
  closeLabel,
  disabled = false,
  dragging = false,
  focused,
  icon,
  id,
  label,
  movingLabel,
  onActivate,
  onClose,
  onFocus,
  onKeyDown,
  panelId,
  rootClassName,
  rootRef,
  rootStyle,
  testId,
}: {
  active: boolean;
  activatorProps?: WorkspaceTabActivatorProps;
  buttonRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
  closeLabel?: string;
  disabled?: boolean;
  dragging?: boolean;
  focused: boolean;
  icon: ReactNode;
  id: string;
  label: string;
  movingLabel?: string;
  onActivate: () => void;
  onClose?: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  panelId: string;
  rootClassName?: string;
  rootRef?: Ref<HTMLDivElement>;
  rootStyle?: CSSProperties;
  testId?: string;
}) {
  return (
    <div
      ref={rootRef}
      data-dragging={dragging ? "true" : undefined}
      data-testid={testId}
      className={cn(
        "group flex h-8 max-w-[15rem] shrink-0 items-center gap-0.5 rounded-md border pr-1",
        "transition-[color,background-color,border-color,opacity]",
        active
          ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
        dragging && "opacity-50",
        rootClassName,
      )}
      style={rootStyle}
    >
      <button
        {...activatorProps}
        ref={buttonRef}
        type="button"
        id={id}
        role="tab"
        aria-controls={panelId}
        aria-selected={active}
        tabIndex={focused ? 0 : -1}
        disabled={disabled}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          activatorProps?.className,
        )}
        onClick={onActivate}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        {icon}
        <span className="truncate">{label}</span>
        {movingLabel ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {movingLabel}
          </span>
        ) : null}
      </button>
      {children}
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel ?? `Close ${label} tab`}
          disabled={disabled}
          className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[color:var(--surface-panel)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={(event) => {
            event.stopPropagation();
            if (!disabled) onClose();
          }}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
