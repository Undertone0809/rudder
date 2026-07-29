import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { McpAgentAccessMode, McpProviderAvailability } from "@rudderhq/shared";
import { cn } from "../lib/utils";

export function AgentProviderAccessDialog({
  provider,
  access,
  conflictMessage,
  pending,
  onAccessChange,
  onClose,
  onSave,
  onAddConnection,
  onOpenOrganizationSettings,
}: {
  provider: McpProviderAvailability | null;
  access: McpAgentAccessMode;
  conflictMessage: string;
  pending: boolean;
  onAccessChange: (access: McpAgentAccessMode) => void;
  onClose: () => void;
  onSave: () => void;
  onAddConnection: () => void;
  onOpenOrganizationSettings: () => void;
}) {
  const providerName = provider
    ? provider.provider[0]!.toUpperCase() + provider.provider.slice(1)
    : "";
  const originalAccess = provider?.agent?.access ?? "none";
  const hasEffectiveConnection = Boolean(provider?.agent?.effectiveConnectionId);
  const modes: McpAgentAccessMode[] = provider?.provider === "notion"
    ? ["none", "provider_granted"]
    : ["none", "read_only", "read_write"];
  const label = (mode: McpAgentAccessMode) => {
    if (mode === "read_only") return "Read only";
    if (mode === "read_write") return "Read & write";
    if (mode === "provider_granted") return "Provider-granted access";
    return "No access";
  };

  return (
    <Dialog open={Boolean(provider)} onOpenChange={(open) => {
      if (!open && !pending) onClose();
    }}>
      <DialogContent className="sm:max-w-md">
        {provider ? (
          <>
            <DialogHeader>
              <DialogTitle>Manage {providerName} access</DialogTitle>
              <DialogDescription>
                Review the connection used by this agent and choose its access.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-sm font-medium text-foreground">
                {provider.agent?.explicitlyDisabled
                  ? "Disabled for this agent"
                  : provider.agent?.effectiveSource === "agent"
                    ? "Using this agent’s connection"
                    : provider.agent?.effectiveSource === "organization"
                      ? "Using the organization connection"
                      : "No connection available"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Agent credentials take priority over organization credentials for the same provider.
              </p>
            </div>
            {hasEffectiveConnection ? (
              <fieldset className="space-y-2">
                <legend className="sr-only">Access</legend>
                {modes.map((mode) => {
                  const maximumAccess = provider.agent?.connection?.maxAccess
                    ?? provider.organization.maxAccess;
                  const blockedByMaximum = mode === "read_write" && maximumAccess === "read_only";
                  return (
                    <label
                      key={mode}
                      className={cn(
                        "flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm",
                        blockedByMaximum && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <input
                        className="mt-0.5"
                        type="radio"
                        name={`agent-provider-access-${provider.provider}`}
                        checked={access === mode}
                        disabled={blockedByMaximum}
                        onChange={() => onAccessChange(mode)}
                      />
                      <span>
                        <span className="block">{label(mode)}</span>
                        {blockedByMaximum ? (
                          <span className="block text-xs text-muted-foreground">
                            The active connection is read only.
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ) : null}
            {provider.agent?.activeRunUsesOlderPolicy ? (
              <p className="text-xs text-muted-foreground">
                Access reductions apply immediately; increases start with the next run.
              </p>
            ) : null}
            <p className="min-h-5 text-sm text-destructive" aria-live="polite">
              {conflictMessage}
            </p>
            <DialogFooter>
              <Button variant="ghost" disabled={pending} onClick={onOpenOrganizationSettings}>
                Organization settings
              </Button>
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={pending} onClick={onAddConnection}>
                  Add connection
                </Button>
                {hasEffectiveConnection ? (
                  <Button disabled={pending || access === originalAccess} onClick={onSave}>Save</Button>
                ) : null}
              </div>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
