import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface InlineEntityOption {
  id: string;
  label: string;
  searchText?: string;
}

interface InlineEntitySelectorProps {
  value: string;
  options: InlineEntityOption[];
  placeholder: string;
  noneLabel: string;
  searchPlaceholder: string;
  emptyMessage: string;
  onChange: (id: string) => void;
  onConfirm?: () => void;
  className?: string;
  ariaLabel?: string;
  renderTriggerValue?: (option: InlineEntityOption | null) => ReactNode;
  renderOption?: (option: InlineEntityOption, isSelected: boolean) => ReactNode;
  renderOptionAccessory?: (option: InlineEntityOption, isSelected: boolean) => ReactNode;
  keepOpenOnOptionChange?: boolean;
  /** Skip the Portal so the popover stays in the DOM tree (fixes scroll inside Dialogs). */
  disablePortal?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  contentClassName?: string;
  variant?: "inline" | "field";
}

export const InlineEntitySelector = forwardRef<HTMLButtonElement, InlineEntitySelectorProps>(
  function InlineEntitySelector(
    {
      value,
      options,
      placeholder,
      noneLabel,
      searchPlaceholder,
      emptyMessage,
      onChange,
      onConfirm,
      className,
      ariaLabel,
      renderTriggerValue,
      renderOption,
      renderOptionAccessory,
      keepOpenOnOptionChange = false,
      disablePortal,
      side = "bottom",
      sideOffset,
      contentClassName,
      variant = "inline",
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [shouldFocusSelectedOption, setShouldFocusSelectedOption] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const selectedOptionButtonRef = useRef<HTMLButtonElement | null>(null);
    const shouldPreventCloseAutoFocusRef = useRef(false);
    const isPointerDownRef = useRef(false);
    const suppressNextFocusOpenRef = useRef(false);
    const restoreTriggerFocusRef = useRef(false);

    useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement);

    const allOptions = useMemo<InlineEntityOption[]>(
      () => [{ id: "", label: noneLabel, searchText: noneLabel }, ...options],
      [noneLabel, options],
    );

    const filteredOptions = useMemo(() => {
      const term = query.trim().toLowerCase();
      if (!term) return allOptions;
      return allOptions.filter((option) => {
        const haystack = `${option.label} ${option.searchText ?? ""}`.toLowerCase();
        return haystack.includes(term);
      });
    }, [allOptions, query]);

    const currentOption = options.find((option) => option.id === value) ?? null;
    const collisionPadding = typeof window !== "undefined" && window.innerWidth < 640
      ? { top: 16, right: 16, bottom: 88, left: 16 }
      : 16;

    useEffect(() => {
      if (!open) return;
      const selectedIndex = filteredOptions.findIndex((option) => option.id === value);
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }, [filteredOptions, open, value]);

    useEffect(() => {
      if (!open || !shouldFocusSelectedOption) return;
      const frame = requestAnimationFrame(() => {
        selectedOptionButtonRef.current?.focus();
        setShouldFocusSelectedOption(false);
      });
      return () => cancelAnimationFrame(frame);
    }, [open, shouldFocusSelectedOption]);

    const commitSelection = (index: number, moveNext: boolean, keepOpen = false) => {
      const option = filteredOptions[index] ?? filteredOptions[0];
      if (option) onChange(option.id);
      if (keepOpen) {
        setShouldFocusSelectedOption(true);
        setQuery("");
        setOpen(true);
        return;
      }
      shouldPreventCloseAutoFocusRef.current = moveNext;
      setOpen(false);
      setQuery("");
      if (moveNext && onConfirm) {
        requestAnimationFrame(() => {
          onConfirm();
        });
      }
    };

    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={ariaLabel}
            className={cn(
              "inline-flex min-w-0 items-center gap-1 border border-border text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              variant === "field"
                ? "h-10 w-full justify-between rounded-md bg-background px-3 hover:bg-accent/30"
                : "rounded-md bg-muted/40 px-2 py-1 hover:bg-accent/50",
              className,
            )}
            onPointerDown={() => { isPointerDownRef.current = true; }}
            onFocus={() => {
              if (suppressNextFocusOpenRef.current) {
                suppressNextFocusOpenRef.current = false;
              } else if (!isPointerDownRef.current) {
                setOpen(true);
              }
              isPointerDownRef.current = false;
            }}
          >
            <span className={cn(
              "flex min-w-0 items-center gap-2",
              variant === "field" && "flex-1 overflow-hidden",
            )}>
              {renderTriggerValue
                ? renderTriggerValue(currentOption)
                : (currentOption?.label ?? <span className="text-muted-foreground">{placeholder}</span>)}
            </span>
            {variant === "field" ? <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" /> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side={side}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(
            "motion-inline-selector-pop z-[70] flex max-h-[min(18rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden p-1",
            variant === "field"
              ? "w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)]"
              : "w-[min(20rem,calc(100vw-2rem))]",
            contentClassName,
          )}
          disablePortal={disablePortal}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            // On touch devices, don't auto-focus the search input to avoid
            // opening the virtual keyboard which reshapes the viewport and
            // pushes the popover off-screen.
            const isTouch = window.matchMedia("(pointer: coarse)").matches;
            if (!isTouch) {
              inputRef.current?.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (restoreTriggerFocusRef.current) {
              event.preventDefault();
              restoreTriggerFocusRef.current = false;
              requestAnimationFrame(() => triggerRef.current?.focus());
              return;
            }
            if (!shouldPreventCloseAutoFocusRef.current) return;
            event.preventDefault();
            shouldPreventCloseAutoFocusRef.current = false;
          }}
          onInteractOutside={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-issue-runtime-portal]")) {
              // Keep the Agent menu open while its selected-row runtime panel is active.
              event.preventDefault();
            }
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            suppressNextFocusOpenRef.current = true;
            restoreTriggerFocusRef.current = true;
          }}
        >
          <input
            ref={inputRef}
            className="w-full border-b border-border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlightedIndex((current) =>
                  filteredOptions.length === 0 ? 0 : (current + 1) % filteredOptions.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlightedIndex((current) => {
                  if (filteredOptions.length === 0) return 0;
                  return current <= 0 ? filteredOptions.length - 1 : current - 1;
                });
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                commitSelection(highlightedIndex, false, keepOpenOnOptionChange);
                return;
              }
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                commitSelection(highlightedIndex, true);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                suppressNextFocusOpenRef.current = true;
                restoreTriggerFocusRef.current = true;
              }
            }}
          />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 touch-pan-y">
            {filteredOptions.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
            ) : (
              filteredOptions.map((option, index) => {
                const isSelected = option.id === value;
                const isHighlighted = index === highlightedIndex;
                const optionContent = renderOption
                  ? renderOption(option, isSelected)
                  : <span className="truncate">{option.label}</span>;
                const accessory = renderOptionAccessory?.(option, isSelected);
                if (accessory) {
                  return (
                    <div
                      key={option.id || "__none__"}
                      data-inline-entity-option
                      className={cn(
                        "flex w-full items-center gap-1 rounded text-left text-sm transition-colors",
                        isHighlighted && "bg-accent",
                      )}
                      onMouseEnter={() => setHighlightedIndex(index)}
                    >
                      <button
                        type="button"
                        ref={isSelected ? selectedOptionButtonRef : undefined}
                        aria-pressed={isSelected}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors touch-manipulation hover:bg-accent/80"
                        onClick={() => commitSelection(index, false, keepOpenOnOptionChange)}
                      >
                        {optionContent}
                        <Check className={cn("ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground", isSelected ? "opacity-100" : "opacity-0")} />
                      </button>
                      <div className="min-w-0 shrink-0">{accessory}</div>
                    </div>
                  );
                }
                return (
                  <button
                    key={option.id || "__none__"}
                    type="button"
                    data-inline-entity-option
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors touch-manipulation hover:bg-accent/80",
                      isHighlighted && "bg-accent",
                    )}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => commitSelection(
                      index,
                      keepOpenOnOptionChange ? false : true,
                      keepOpenOnOptionChange,
                    )}
                  >
                    {optionContent}
                    <Check className={cn("ml-auto h-3.5 w-3.5 text-muted-foreground", isSelected ? "opacity-100" : "opacity-0")} />
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
