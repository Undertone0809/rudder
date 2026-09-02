import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { readDesktopShell } from "@/lib/desktop-shell";
import {
  buildRunIssueDiagnostics,
  createRunIssueReportUrl,
} from "@/lib/run-issue-report";
import type { HeartbeatRun } from "@rudderhq/shared";
import { Bot, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

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
}: {
  run: HeartbeatRun;
  version: string;
  environment: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAskAgent: (diagnostics: string) => void;
}) {
  const [generatedDiagnostics, setGeneratedDiagnostics] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const diagnosticsScrollRef = useScrollbarActivityRef();

  useEffect(() => {
    if (!open) return;
    const generated = buildRunIssueDiagnostics(run, { version, environment });
    setGeneratedDiagnostics(generated);
    setDiagnostics(generated);
    setOpenError(null);
  }, [environment, open, run, version]);

  async function openGitHubIssue() {
    const target = createRunIssueReportUrl(run, {
      diagnostics,
      version,
      environment,
      platform: browserPlatform(),
    });
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
    }
  }

  function askAgent() {
    if (!generatedDiagnostics.trim()) return;
    onAskAgent(generatedDiagnostics);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Report this run failure</DialogTitle>
          <DialogDescription>
            Rudder prepared a GitHub issue with bounded, redacted run diagnostics. Review the
            text before opening GitHub; the issue is not submitted automatically.
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
            excerpts can still contain private user content, so remove anything you do not want
            to publish.
          </p>
          {openError ? <p className="text-xs text-destructive">{openError}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={askAgent} disabled={!generatedDiagnostics.trim()}>
            <Bot className="mr-1.5 h-3.5 w-3.5" />
            Ask agent
          </Button>
          <Button onClick={() => void openGitHubIssue()} disabled={!diagnostics.trim()}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Open GitHub issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
