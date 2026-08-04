import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useRef, useState } from "react";
import { assetsApi } from "../api/assets";
import { goalsApi } from "../api/goals";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { markdownDocumentOrUndefined } from "../lib/markdown-document-value";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";

export function NewGoalDialog() {
  const { newGoalOpen, closeNewGoal } = useDialog();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [documentSessionId, setDocumentSessionId] = useState(0);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const reset = () => {
    setTitle("");
    setDescription("");
    setExpanded(false);
    setDocumentSessionId((value) => value + 1);
  };

  const createGoal = useMutation({
    mutationFn: () => goalsApi.create(selectedOrganizationId!, {
      title: title.trim(),
      description: markdownDocumentOrUndefined(description),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedOrganizationId!) });
      reset();
      closeNewGoal();
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: (file: File) => assetsApi.uploadImage(selectedOrganizationId!, file, "goals/drafts"),
  });

  const close = () => {
    reset();
    closeNewGoal();
  };

  return (
    <Dialog open={newGoalOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        className={cn("gap-0 p-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (title.trim() && !createGoal.isPending) createGoal.mutate();
          }
        }}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
              {selectedOrganization?.name.slice(0, 3).toUpperCase()}
            </span>
            <span aria-hidden="true">/</span>
            <span>New draft Goal</span>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon-xs" aria-label={expanded ? "Use compact editor" : "Expand editor"} onClick={() => setExpanded((value) => !value)}>
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" onClick={close}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="px-4 pb-2 pt-4">
          <input
            aria-label="Goal title"
            className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/50"
            placeholder="What external outcome should change?"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        <div className="px-4 pb-3">
          <MarkdownEditor
            ref={descriptionEditorRef}
            engine="codemirror"
            documentIdentity={`new-goal:${documentSessionId}`}
            value={description}
            onChange={setDescription}
            placeholder="Add context for the alignment conversation..."
            bordered={false}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => (await uploadDescriptionImage.mutateAsync(file)).contentPath}
          />
        </div>

        {createGoal.error && <p className="px-4 pb-2 text-sm text-destructive">{createGoal.error.message}</p>}
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
          <span className="text-xs text-muted-foreground">Drafts need an Owner, Contract, Plan, and continuation before activation.</span>
          <Button type="button" size="sm" disabled={!title.trim() || createGoal.isPending} onClick={() => createGoal.mutate()}>
            {createGoal.isPending ? "Creating..." : "Create draft"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
