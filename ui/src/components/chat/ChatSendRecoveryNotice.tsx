import { Button } from "@/components/ui/button";

export type ChatSendRecovery = {
  clientMutationId: string;
  body: string;
  modelOverride?: string | null;
  effortOverride?: string | null;
  action?: "resume" | "retry";
};

export function ChatSendRecoveryNotice({
  disabled = false,
  action = "resume",
  onResume,
}: {
  disabled?: boolean;
  action?: "resume" | "retry";
  onResume: () => void;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 text-sm text-muted-foreground">
      <span>{action === "retry"
        ? "Rudder confirmed the earlier message was not accepted. Retry that exact message; your current draft will stay unchanged."
        : "A previous message was accepted. Resume its response; your current draft will stay unchanged."}</span>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onResume}>
        {action === "retry" ? "Retry previous message" : "Resume response"}
      </Button>
    </div>
  );
}

export function ChatSendRecoveryProblem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 text-sm text-destructive">
      <span>{message} No new message was sent. Keep this browser's site data intact and retry recovery when available.</span>
      {onRetry ? (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Check again
        </Button>
      ) : null}
    </div>
  );
}
