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
}: {
  provider: McpProviderAvailability | null;
  access: McpAgentAccessMode;
  conflictMessage: string;
  pending: boolean;
  onAccessChange: (access: McpAgentAccessMode) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const providerName = provider
    ? provider.provider[0]!.toUpperCase() + provider.provider.slice(1)
    : "";
  const originalAccess = provider?.agent?.access ?? "none";
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
                Choose the access available to this agent.
              </DialogDescription>
            </DialogHeader>
            <fieldset className="space-y-2">
              <legend className="sr-only">Access</legend>
              {modes.map((mode) => {
                const blockedByOrganization = mode === "read_write"
                  && provider.organization.maxAccess === "read_only";
                return (
                  <label
                    key={mode}
                    className={cn(
                      "flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm",
                      blockedByOrganization && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      className="mt-0.5"
                      type="radio"
                      name={`agent-provider-access-${provider.provider}`}
                      checked={access === mode}
                      disabled={blockedByOrganization}
                      onChange={() => onAccessChange(mode)}
                    />
                    <span>
                      <span className="block">{label(mode)}</span>
                      {blockedByOrganization ? (
                        <span className="block text-xs text-muted-foreground">
                          The organization connection is read only.
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {provider.agent?.activeRunUsesOlderPolicy ? (
              <p className="text-xs text-muted-foreground">
                Access reductions apply immediately; increases start with the next run.
              </p>
            ) : null}
            <p className="min-h-5 text-sm text-destructive" aria-live="polite">
              {conflictMessage}
            </p>
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
              <Button disabled={pending || access === originalAccess} onClick={onSave}>Save</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
