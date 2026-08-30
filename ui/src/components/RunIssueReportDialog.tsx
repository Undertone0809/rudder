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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { readDesktopShell } from "@/lib/desktop-shell";
import {
  buildRunIssueDiagnostics,
  createRunIssueReportUrl,
} from "@/lib/run-issue-report";
import type { HeartbeatRun } from "@rudderhq/shared";
import { ChevronDown, ExternalLink, ListTodo, Loader2, MessageCircle, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function browserPlatform(): string {
  if (typeof navigator === "undefined") return "Other (please describe below)";
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes("mac")) return "macOS";
  if (value.includes("win")) return "Windows";
  if (value.includes("linux")) return "Linux";
  return "Other (please describe below)";
}

export function RunIssueReportDialog({
  run,
  version,
  environment,
  open,
  onOpenChange,
  onAskAgent,
  onCreateTask,
}: {
  run: HeartbeatRun;
  version: string;
  environment: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAskAgent: (diagnostics: string) => void;
  onCreateTask: (diagnostics: string) => Promise<void>;
}) {
  const [generatedDiagnostics, setGeneratedDiagnostics] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"task" | "github" | null>(null);
  const pendingActionRef = useRef<"task" | "github" | null>(null);
  const diagnosticsScrollRef = useScrollbarActivityRef();

  useEffect(() => {
    if (!open) return;
    const generated = buildRunIssueDiagnostics(run, { version, environment });
    setGeneratedDiagnostics(generated);
    setDiagnostics(generated);
    setOpenError(null);
    setPendingAction(null);
    pendingActionRef.current = null;
  }, [environment, open, run, version]);

  async function openGitHubIssue() {
    if (pendingActionRef.current) return;
    const target = createRunIssueReportUrl(run, {
      diagnostics,
      version,
      environment,
      platform: browserPlatform(),
    });
    pendingActionRef.current = "github";
    setPendingAction("github");
    setOpenError(null);
    try {
      const desktopShell = readDesktopShell();
      if (desktopShell?.openExternal) {
        await desktopShell.openExternal(target);
      } else {
        window.open(target, "_blank", "noopener,noreferrer");
      }
      onOpenChange(false);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not open GitHub.");
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }

  function askAgent() {
    if (!generatedDiagnostics.trim()) return;
    onAskAgent(generatedDiagnostics);
    onOpenChange(false);
  }

  async function createTask() {
    if (!generatedDiagnostics.trim() || pendingActionRef.current) return;
    pendingActionRef.current = "task";
    setPendingAction("task");
    setOpenError(null);
    try {
      await onCreateTask(generatedDiagnostics);
      onOpenChange(false);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not create the Debug task.");
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }

  const actionPending = pendingAction !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Report this run failure</DialogTitle>
          <DialogDescription>
            Rudder prepared bounded, redacted run diagnostics. Open a public GitHub report or
            choose a private Debug path in this organization.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-2">
          <label htmlFor="run-issue-diagnostics" className="text-sm font-medium">
            Diagnostics to include
          </label>
          <Textarea
            id="run-issue-diagnostics"
            data-testid="run-issue-diagnostics"
            ref={diagnosticsScrollRef}
            value={diagnostics}
            onChange={(event) => setDiagnostics(event.target.value)}
            className="field-sizing-fixed scrollbar-auto-hide min-h-[min(18rem,45dvh)] min-w-0 max-h-[min(22rem,45dvh)] resize-y overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-5"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Known identifiers and common credential patterns are redacted automatically. Log
            excerpts can still contain private user content. Edits here apply only to the GitHub
            report; Debug uses the original safe snapshot.
          </p>
          {openError ? <p role="alert" className="text-xs text-destructive">{openError}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={actionPending}>
            Cancel
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={!generatedDiagnostics.trim() || actionPending}
                data-testid="run-debug-menu-trigger"
              >
                {pendingAction === "task" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wrench className="mr-1.5 h-3.5 w-3.5" />
                )}
                {pendingAction === "task" ? "Creating task" : "Debug"}
                {pendingAction !== "task" ? <ChevronDown className="ml-1 h-3.5 w-3.5" /> : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-48">
              <DropdownMenuItem onSelect={() => void createTask()}>
                <ListTodo />
                Create task
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={askAgent}>
                <MessageCircle />
                Start chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => void openGitHubIssue()} disabled={!diagnostics.trim() || actionPending}>
            {pendingAction === "github" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            )}
            {pendingAction === "github" ? "Opening GitHub" : "Open GitHub issue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
