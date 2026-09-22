import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  readDesktopShell,
  type DesktopDeferredUpdatePrompt,
  type DesktopDeferredUpdatePromptDecision,
} from "@/lib/desktop-shell";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function splitPromptDetail(detail: string) {
  const [body = "", ...rest] = detail.split(/\n{2,}/);
  return {
    body: body.trim(),
    runDetail: rest.join("\n\n").trim(),
  };
}

export function DesktopUpdatePromptBridge() {
  const [prompt, setPrompt] = useState<DesktopDeferredUpdatePrompt | null>(null);
  const [responding, setResponding] = useState(false);
  const [respondingDecision, setRespondingDecision] = useState<DesktopDeferredUpdatePromptDecision | null>(null);
  const promptRef = useRef<DesktopDeferredUpdatePrompt | null>(null);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onDeferredUpdatePrompt) return undefined;

    void desktopShell.setDeferredUpdatePromptReady?.(true);
    return desktopShell.onDeferredUpdatePrompt((nextPrompt) => {
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setResponding(false);
    });
  }, []);

  useEffect(() => {
    return () => {
      void readDesktopShell()?.setDeferredUpdatePromptReady?.(false);
    };
  }, []);

  async function settle(decision: DesktopDeferredUpdatePromptDecision) {
    const current = promptRef.current;
    if (!current) return;
    const desktopShell = readDesktopShell();
    promptRef.current = null;
    setResponding(true);
    setRespondingDecision(decision);
    try {
      await desktopShell?.respondDeferredUpdatePrompt?.(current.promptId, decision).catch(() => undefined);
    } finally {
      setPrompt(null);
      setResponding(false);
      setRespondingDecision(null);
    }
  }

  const { body, runDetail } = splitPromptDetail(prompt?.detail ?? "");
  const renderAction = (decision: DesktopDeferredUpdatePromptDecision, label: string) => (
    <>
      {respondingDecision === decision ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      <span>{label}</span>
    </>
  );

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) void settle("cancel");
      }}
    >
      <DialogContent aria-busy={responding} className="gap-0 p-0 sm:max-w-[34rem]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-5 pb-4 pt-5">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/12 text-amber-600 dark:text-amber-300">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <DialogHeader className="min-w-0 gap-2 text-left">
            <DialogTitle className="text-base leading-6">
              {prompt?.message}
            </DialogTitle>
            {body ? (
              <DialogDescription className="text-sm leading-5">
                {body}
              </DialogDescription>
            ) : null}
          </DialogHeader>
        </div>
        {runDetail ? (
          <div className="mx-5 rounded-[var(--radius-md)] border border-border/70 bg-muted/35 px-3 py-2.5">
            <p className="whitespace-pre-wrap break-words text-xs font-medium leading-5 text-foreground">
              {runDetail}
            </p>
          </div>
        ) : null}
        <DialogFooter className="grid grid-cols-1 gap-2 px-5 pb-5 pt-4 sm:grid-cols-2 sm:justify-stretch">
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-10 min-w-0 whitespace-normal leading-5"
            disabled={responding}
            aria-busy={respondingDecision === "cancel"}
            onClick={() => void settle("cancel")}
          >
            {renderAction("cancel", prompt?.cancelLabel ?? "Cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-10 min-w-0 whitespace-normal leading-5"
            disabled={responding}
            aria-busy={respondingDecision === "force"}
            onClick={() => void settle("force")}
          >
            {renderAction("force", prompt?.forceLabel ?? "Stop Runs and Update Now")}
          </Button>
          <Button
            type="button"
            className="h-auto min-h-10 min-w-0 whitespace-normal leading-5 sm:col-span-2"
            disabled={responding}
            aria-busy={respondingDecision === "wait"}
            onClick={() => void settle("wait")}
          >
            {renderAction("wait", prompt?.confirmLabel ?? "Download and Update When Idle")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
