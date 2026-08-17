import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

export type RuntimeProfileOption = {
  id: string | null;
  label: string;
};

type RuntimeProfileControl = {
  valueLabel: string;
  dataValue?: string;
  selectedId: string | null;
  defaultOption: RuntimeProfileOption;
  options: readonly RuntimeProfileOption[];
  onSelect: (id: string | null) => void;
  loading?: boolean;
  emptyLabel?: string;
};

export type RuntimeProfileControlTestIds = {
  modelTrigger: string;
  modelOptions: string;
  modelOption: (id: string | null) => string;
  effortTrigger: string;
  effortOptions: string;
  effortOption: (id: string | null) => string;
};

export function RuntimeProfileControls(props: {
  ariaContext: string;
  model: RuntimeProfileControl;
  effort?: RuntimeProfileControl;
  disabled?: boolean;
  pending?: boolean;
  errorMessage?: string | null;
  modelSelectRef?: Ref<HTMLButtonElement>;
  testIds: RuntimeProfileControlTestIds;
}) {
  const [activeSubmenu, setActiveSubmenu] = useState<"model" | "effort" | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const effortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const firstModelOptionRef = useRef<HTMLButtonElement | null>(null);
  const firstEffortOptionRef = useRef<HTMLButtonElement | null>(null);
  const modelSubmenuScrollRef = useScrollbarActivityRef();
  const effortSubmenuScrollRef = useScrollbarActivityRef();
  const disabled = props.disabled || props.pending;

  const viewportBottomBoundary = (padding: number) => {
    const viewportBottom = window.innerHeight - padding;
    const mobileNavigation = document.querySelector<HTMLElement>("[data-mobile-bottom-navigation]");
    if (!mobileNavigation || mobileNavigation.getClientRects().length === 0) {
      return viewportBottom;
    }
    return Math.min(viewportBottom, mobileNavigation.getBoundingClientRect().top - padding);
  };

  useEffect(() => {
    if (!activeSubmenu) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSubmenu(activeSubmenu);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeSubmenu]);

  const setModelTriggerRefs = (node: HTMLButtonElement | null) => {
    modelTriggerRef.current = node;
    if (typeof props.modelSelectRef === "function") props.modelSelectRef(node);
    else if (props.modelSelectRef) props.modelSelectRef.current = node;
  };

  const openSubmenu = (
    kind: "model" | "effort",
    trigger: HTMLButtonElement | null,
    focusFirstOption = false,
  ) => {
    if (disabled || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 256;
    const viewportPadding = 12;
    const viewportBottom = viewportBottomBoundary(viewportPadding);
    const availableRight = window.innerWidth - rect.right;
    const left = availableRight >= width + viewportPadding
      ? rect.right + 8
      : Math.max(viewportPadding, rect.left - width - 8);
    const profilePanel = trigger.closest<HTMLElement>("[data-runtime-profile-panel]");
    const profileRect = profilePanel?.getBoundingClientRect();
    const overlapsProfileHorizontally = profileRect
      ? left < profileRect.right && left + width > profileRect.left
      : false;

    if (profileRect && overlapsProfileHorizontally) {
      const gap = 8;
      const availableBelowPanel = Math.max(0, viewportBottom - profileRect.bottom - gap);
      const availableAbovePanel = Math.max(0, profileRect.top - viewportPadding - gap);
      const placeBelow = availableBelowPanel >= availableAbovePanel;
      const maxHeight = Math.min(
        320,
        placeBelow ? availableBelowPanel : availableAbovePanel,
      );
      setSubmenuPosition({
        left: Math.min(
          Math.max(viewportPadding, rect.left),
          window.innerWidth - viewportPadding - width,
        ),
        top: placeBelow ? profileRect.bottom + gap : profileRect.top - gap - maxHeight,
        maxHeight: `${maxHeight}px`,
      });
      setActiveSubmenu(kind);
      if (focusFirstOption) {
        requestAnimationFrame(() => {
          (kind === "model" ? firstModelOptionRef : firstEffortOptionRef).current?.focus();
        });
      }
      return;
    }

    const availableBelow = Math.max(0, viewportBottom - rect.top);
    const availableAbove = Math.max(0, rect.bottom - viewportPadding);
    const alignBelow = availableBelow >= 120;
    const maxHeight = Math.min(
      320,
      alignBelow ? availableBelow : Math.max(availableAbove, availableBelow),
    );
    setSubmenuPosition({
      left,
      top: alignBelow
        ? Math.max(viewportPadding, rect.top)
        : Math.max(viewportPadding, Math.min(rect.bottom - maxHeight, viewportBottom - maxHeight)),
      maxHeight: `${maxHeight}px`,
    });
    setActiveSubmenu(kind);
    if (focusFirstOption) {
      requestAnimationFrame(() => {
        (kind === "model" ? firstModelOptionRef : firstEffortOptionRef).current?.focus();
      });
    }
  };

  const closeSubmenu = (kind: "model" | "effort") => {
    setActiveSubmenu(null);
    requestAnimationFrame(() => {
      (kind === "model" ? modelTriggerRef : effortTriggerRef).current?.focus();
    });
  };

  const handleSubmenuKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    kind: "model" | "effort",
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeSubmenu(kind);
  };

  const renderOptions = (
    kind: "model" | "effort",
    control: RuntimeProfileControl,
  ) => {
    const optionTestId = kind === "model" ? props.testIds.modelOption : props.testIds.effortOption;
    const firstOptionRef = kind === "model" ? firstModelOptionRef : firstEffortOptionRef;
    const allOptions = [control.defaultOption, ...control.options];

    return (
      <>
        {allOptions.map((option, index) => {
          const selected = control.selectedId === option.id;
          return (
            <button
              key={option.id ?? "default"}
              ref={index === 0 ? firstOptionRef : undefined}
              type="button"
              role="option"
              aria-selected={selected}
              data-testid={optionTestId(option.id)}
              className="chat-composer-menu-row"
              onClick={() => {
                control.onSelect(option.id);
                setActiveSubmenu(null);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
            </button>
          );
        })}
        {control.loading ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Loading models...
          </div>
        ) : control.options.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">
            {control.emptyLabel ?? "No options found."}
          </div>
        ) : null}
      </>
    );
  };

  const submenuClassName = cn(
    "pointer-events-auto surface-overlay scrollbar-auto-hide scrollbar-menu-inset fixed z-[80] w-64 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 shadow-lg",
  );
  const triggerClassName = cn(
    "chat-composer-menu-row grid min-h-10 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2",
    disabled && "cursor-not-allowed opacity-60",
  );

  const modelSubmenu = activeSubmenu === "model" && submenuPosition && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={modelSubmenuScrollRef}
          data-runtime-profile-submenu
          data-chat-runtime-submenu
          data-issue-runtime-portal
          data-testid={props.testIds.modelOptions}
          role="listbox"
          aria-label={`${props.ariaContext} model`}
          className={submenuClassName}
          style={submenuPosition}
          onKeyDown={(event) => handleSubmenuKeyDown(event, "model")}
        >
          {renderOptions("model", props.model)}
        </div>,
        document.body,
      )
    : null;

  const effortSubmenu = props.effort
    && activeSubmenu === "effort"
    && submenuPosition
    && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={effortSubmenuScrollRef}
          data-runtime-profile-submenu
          data-chat-runtime-submenu
          data-issue-runtime-portal
          data-testid={props.testIds.effortOptions}
          role="listbox"
          aria-label={`${props.ariaContext} thinking`}
          className={submenuClassName}
          style={submenuPosition}
          onKeyDown={(event) => handleSubmenuKeyDown(event, "effort")}
        >
          {renderOptions("effort", props.effort)}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="relative min-w-0">
      <button
        ref={setModelTriggerRefs}
        type="button"
        data-testid={props.testIds.modelTrigger}
        aria-label={`Model for ${props.ariaContext}`}
        aria-haspopup="listbox"
        aria-expanded={activeSubmenu === "model"}
        className={triggerClassName}
        disabled={disabled}
        title={props.errorMessage ?? undefined}
        data-value={props.model.dataValue}
        onPointerMove={(event) => {
          if (event.pointerType === "mouse") openSubmenu("model", modelTriggerRef.current);
        }}
        onClick={() => openSubmenu("model", modelTriggerRef.current, true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            openSubmenu("model", modelTriggerRef.current, true);
          }
        }}
      >
        <span className="font-medium text-foreground">Model</span>
        <span className="min-w-0 truncate text-right text-muted-foreground">
          {props.model.valueLabel}
        </span>
        {props.model.loading || props.pending ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      {props.effort ? (
        <button
          ref={effortTriggerRef}
          type="button"
          data-testid={props.testIds.effortTrigger}
          aria-label={`Thinking for ${props.ariaContext}`}
          aria-haspopup="listbox"
          aria-expanded={activeSubmenu === "effort"}
          className={triggerClassName}
          disabled={disabled}
          data-value={props.effort.dataValue}
          onPointerMove={(event) => {
            if (event.pointerType === "mouse") openSubmenu("effort", effortTriggerRef.current);
          }}
          onClick={() => openSubmenu("effort", effortTriggerRef.current, true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              openSubmenu("effort", effortTriggerRef.current, true);
            }
          }}
        >
          <span className="font-medium text-foreground">Thinking</span>
          <span className="min-w-0 truncate text-right text-muted-foreground">
            {props.effort.valueLabel}
          </span>
          {props.pending ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
        </button>
      ) : null}
      {props.errorMessage ? (
        <>
          <div className="mt-1 flex min-h-7 items-center gap-1.5 border-t border-[color:var(--border-soft)] px-2.5 pt-1.5 text-[11px] text-muted-foreground">
            <span>{props.errorMessage}</span>
          </div>
          <span className="sr-only" role="status">{props.errorMessage}</span>
        </>
      ) : null}
      {modelSubmenu}
      {effortSubmenu}
    </div>
  );
}
