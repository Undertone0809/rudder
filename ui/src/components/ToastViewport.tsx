import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@/lib/router";
import { Download, X } from "lucide-react";
import { useToast, type ToastItem } from "../context/ToastContext";
import { cn } from "../lib/utils";
import { semanticDotToneClasses, semanticTextToneClasses } from "@/components/ui/semanticTones";

function ToastIcon({ toast }: { toast: ToastItem }) {
  if (toast.icon === "download") {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-muted text-muted-foreground">
        <Download className="h-4 w-4" />
      </span>
    );
  }

  return <span className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", semanticDotToneClasses[toast.tone])} />;
}

function ToastActionControl({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  if (!toast.action) return null;

  const className = cn(
    "mt-2 inline-flex h-8 items-center justify-center rounded-[var(--radius-sm)] px-3 text-xs font-semibold transition-colors",
    toast.icon === "download"
      ? "bg-foreground text-background hover:bg-foreground/90"
      : cn("underline-offset-4 hover:opacity-90", semanticTextToneClasses[toast.tone]),
  );

  if (toast.action.onClick) {
    return (
      <button
        type="button"
        onClick={() => {
          void toast.action?.onClick?.();
          onDismiss(toast.id);
        }}
        className={className}
      >
        {toast.action.label}
      </button>
    );
  }

  if (toast.action.href) {
    return (
      <Link
        to={toast.action.href}
        onClick={() => onDismiss(toast.id)}
        className={className}
      >
        {toast.action.label}
      </Link>
    );
  }

  return null;
}

function AnimatedToast({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <li
      className={cn(
        "pointer-events-auto overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-popover text-popover-foreground shadow-[0_16px_40px_rgba(15,23,42,0.16)] backdrop-blur-xl transition-[transform,opacity] duration-200 ease-out dark:shadow-[0_16px_44px_rgba(0,0,0,0.45)]",
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-3 opacity-0",
      )}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <ToastIcon toast={toast} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">{toast.title}</p>
          {toast.body && (
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
              {toast.body}
            </p>
          )}
          <ToastActionControl toast={toast} onDismiss={onDismiss} />
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          className="-mr-1 -mt-1 shrink-0 rounded-[var(--radius-sm)] p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  const viewport = (
    <aside
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[1000] w-[min(calc(100vw-2rem),20rem)]"
    >
      <ol className="flex w-full flex-col-reverse gap-2">
        {toasts.map((toast) => (
          <AnimatedToast
            key={toast.id}
            toast={toast}
            onDismiss={dismissToast}
          />
        ))}
      </ol>
    </aside>
  );

  if (typeof document === "undefined") return viewport;
  return createPortal(viewport, document.body);
}
