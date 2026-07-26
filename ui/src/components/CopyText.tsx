import { cn } from "@/lib/utils";
import { useCallback, useRef, useState } from "react";

interface CopyTextProps {
  text: string;
  /** What to display. Defaults to `text`. */
  children?: React.ReactNode;
  className?: string;
  containerClassName?: string;
  ariaLabel?: string;
  title?: string;
  /** Tooltip message shown after copying. Default: "Copied!" */
  copiedLabel?: string;
}

export function CopyText({ text, children, className, containerClassName, ariaLabel, title, copiedLabel = "Copied!" }: CopyTextProps) {
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState(copiedLabel);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setLabel(copiedLabel);
    } catch {
      setLabel("Copy failed");
    }
    clearTimeout(timerRef.current);
    setVisible(true);
    timerRef.current = setTimeout(() => setVisible(false), 1500);
  }, [copiedLabel, text]);

  return (
    <span className={cn("relative inline-flex", containerClassName)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "cursor-copy hover:text-foreground transition-colors",
          className,
        )}
        onClick={handleClick}
        aria-label={ariaLabel}
        title={title}
      >
        {children ?? text}
      </button>
      <span
        role="status"
        aria-live="polite"
        data-visible={visible ? "true" : "false"}
        className={cn(
          "motion-tooltip pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 rounded-md bg-foreground text-background px-2 py-1 text-xs whitespace-nowrap",
        )}
      >
        {visible ? label : null}
      </span>
    </span>
  );
}
