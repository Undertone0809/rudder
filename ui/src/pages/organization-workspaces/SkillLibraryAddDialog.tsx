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
import { useNavigate } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { organizationSkillsApi } from "../../api/organizationSkills";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";

const SKILL_INSTALL_CHAT_PREFILL = [
  "Install or import a skill into this Rudder organization.",
  "",
  "Source or command:",
  "<paste a GitHub URL, local path, or skills.sh command here>",
  "",
  "After importing, verify it appears in Library / skills and explain whether it is editable or read-only.",
].join("\n");

export function SkillLibraryAddDialog({
  open,
  orgId,
  onOpenChange,
}: {
  open: boolean;
  orgId: string | null | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [sourceDraft, setSourceDraft] = useState("");
  const sources = sourceDraft
    .split(/\r?\n/)
    .map((source) => source.trim())
    .filter(Boolean);

  const refreshSkills = useCallback(async () => {
    if (!orgId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(orgId) }),
      queryClient.invalidateQueries({ queryKey: ["organizations", orgId, "workspace-files"] }),
    ]);
  }, [orgId, queryClient]);

  const importSkills = useMutation({
    mutationFn: async (payload: { sources: string[] }) => {
      if (!orgId) throw new Error("Select an organization before importing skills.");
      return Promise.all(payload.sources.map((source) => organizationSkillsApi.importFromSource(orgId, source)));
    },
    onSuccess: (results) => {
      void refreshSkills();
      setSourceDraft("");
      onOpenChange(false);
      const importedCount = results.reduce((count, result) => count + result.imported.length, 0);
      pushToast({
        title: importedCount === 1 ? "Skill imported" : `${importedCount} skills imported`,
        body: importedCount > 0 ? "The skills list has been refreshed." : "No new skills were imported.",
        tone: importedCount > 0 ? "success" : "info",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to import skill",
        tone: "error",
      });
    },
  });

  const scanLocalSkills = useMutation({
    mutationFn: async () => {
      if (!orgId) throw new Error("Select an organization before scanning skills.");
      return organizationSkillsApi.scanLocal(orgId);
    },
    onSuccess: (result) => {
      void refreshSkills();
      onOpenChange(false);
      const changedCount = result.imported.length + result.updated.length;
      pushToast({
        title: changedCount === 1 ? "Local skill synced" : `${changedCount} local skills synced`,
        body: result.warnings.length > 0 ? result.warnings.join(", ") : undefined,
        tone: result.warnings.length > 0 ? "warn" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to scan local skills",
        tone: "error",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !importSkills.isPending && !scanLocalSkills.isPending) onOpenChange(false);
      else if (nextOpen) onOpenChange(true);
    }}>
      <DialogContent className="!w-[min(40rem,calc(100vw-2rem))] !max-w-[calc(100vw-2rem)] gap-6 p-6 sm:!max-w-[40rem]">
        <DialogHeader>
          <DialogTitle>Add skill to Library</DialogTitle>
          <DialogDescription className="max-w-[34rem]">
            Import or move a skill into this organization. Workspace-backed skills become editable Library files;
            bundled or remote skills appear here as read-only references.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Skill source, one per line</span>
            <Textarea
              value={sourceDraft}
              onChange={(event) => setSourceDraft(event.target.value)}
              placeholder="https://github.com/org/repo/tree/main/.agents/skills/example&#10;/Users/me/.agents/skills/example&#10;skills install example"
              className="field-sizing-fixed min-h-28 min-w-0 resize-y overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs"
              disabled={importSkills.isPending || scanLocalSkills.isPending}
              autoFocus
            />
          </label>
        </div>
        <DialogFooter className="flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 sm:flex-1">
            <Button
              type="button"
              onClick={() => importSkills.mutate({ sources })}
              disabled={!orgId || sources.length === 0 || importSkills.isPending || scanLocalSkills.isPending}
            >
              {importSkills.isPending ? "Importing..." : "Import skill"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => scanLocalSkills.mutate()}
              disabled={!orgId || importSkills.isPending || scanLocalSkills.isPending}
            >
              {scanLocalSkills.isPending ? "Scanning..." : "Scan local skills"}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="org-workspaces-skill-agent-install-button"
              onClick={() => {
                onOpenChange(false);
                navigate(`/messenger/chat?prefill=${encodeURIComponent(SKILL_INSTALL_CHAT_PREFILL)}`);
              }}
            >
              Ask Agent to install
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={importSkills.isPending || scanLocalSkills.isPending}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
