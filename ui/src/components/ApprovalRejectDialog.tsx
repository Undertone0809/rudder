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
import { useEffect, useState } from "react";

const MAX_REJECTION_REASON_LENGTH = 500;

export function ApprovalRejectDialog({
  open,
  onOpenChange,
  onReject,
  isPending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReject: (reason?: string) => void | Promise<unknown>;
  isPending: boolean;
  error?: string | null;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const close = () => {
    if (isPending) return;
    setReason("");
    onOpenChange(false);
  };

  const submit = async () => {
    try {
      await onReject(reason.trim() || undefined);
      setReason("");
      onOpenChange(false);
    } catch {
      // The owner mutation keeps the dialog open and surfaces the request error.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={!isPending}
        onEscapeKeyDown={(event) => {
          if (isPending) event.preventDefault();
        }}
        data-testid="approval-reject-dialog"
      >
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle>Reject request</DialogTitle>
          <DialogDescription>
            Add a reason so the requesting agent can understand the decision.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-5 py-4">
          <label htmlFor="approval-rejection-reason" className="text-sm font-medium">
            Comments
          </label>
          <Textarea
            id="approval-rejection-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Enter comments"
            rows={6}
            maxLength={MAX_REJECTION_REASON_LENGTH}
            disabled={isPending}
            className="min-h-40 resize-none"
            data-testid="approval-rejection-reason"
          />
          <div className="text-right text-xs tabular-nums text-muted-foreground">
            {reason.length}/{MAX_REJECTION_REASON_LENGTH}
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              Could not reject request. {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="border-t border-border/70 px-5 py-4">
          <Button variant="outline" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={isPending}>
            {isPending ? "Rejecting..." : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
