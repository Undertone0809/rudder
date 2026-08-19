import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export function PropertiesManifest({
  ariaLabel,
  children,
  className,
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn("issue-detail-properties-panel min-w-0 rounded-lg border border-border bg-background/80 p-3", className)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Properties
        </h2>
      </div>
      {children}
    </section>
  );
}

export function PropertiesManifestTrigger({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={className}
      onClick={onClick}
      aria-label="Properties"
      title="Properties"
    >
      <SlidersHorizontal className="h-4 w-4" />
    </Button>
  );
}

export function PropertiesManifestSheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle className="text-sm">Properties</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 overflow-y-auto">
          <div className="w-[100vw] max-w-[100vw] space-y-3 overflow-x-hidden px-4 pb-4">
            {children}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
