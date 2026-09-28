import type { RecoveredRunDeveloperInstructions } from "@rudderhq/shared";
import { formatInvocationValueForDisplay } from "./AgentDetail.helpers";

export function RecoveredDeveloperInstructions({ recovery, censorUsernameInLogs }: {
  recovery: RecoveredRunDeveloperInstructions;
  censorUsernameInLogs: boolean;
}) {
  return (
    <div data-testid="recovered-developer-instructions" className="space-y-2">
      <div className="text-xs font-medium">Recovered developer instructions · Partial</div>
      <p className="text-xs text-muted-foreground">
        Recovered from this Run’s Codex native session and verified against its saved revision.
        This is not the original full instruction stack; the historical prompt is not recovered.
      </p>
      <pre className="rounded-md bg-neutral-100 p-2 text-xs whitespace-pre-wrap overflow-x-auto dark:bg-neutral-950">
        {formatInvocationValueForDisplay(recovery.developerInstructions, censorUsernameInLogs)}
      </pre>
    </div>
  );
}
