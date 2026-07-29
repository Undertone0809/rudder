import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  McpAgentAccessMode,
  McpAgentConnectionSummary,
  McpConnectionProvider,
  McpProviderAvailability,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { McpProviderIcon } from "../components/McpProviderIcon";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

export function buildManagedMcpBindingUpdate(
  row: McpAgentConnectionSummary,
  accessMode: McpAgentAccessMode,
) {
  return {
    accessMode,
    status: accessMode === "none" ? "disabled" as const : "active" as const,
    ...(row.binding ? { expectedRevision: row.binding.policyRevision } : {}),
  };
}

function accessLabel(access: McpAgentAccessMode) {
  switch (access) {
    case "read_only":
      return "Read only";
    case "read_write":
      return "Read & write";
    case "provider_granted":
      return "Provider-granted access";
    case "full":
      return "Full server access";
    default:
      return "No access";
  }
}

function availableAccessModes(
  row: McpAgentConnectionSummary,
  providerStatus?: McpProviderAvailability,
): McpAgentAccessMode[] {
  if (row.connection.provider === "custom") return ["none", "full"];
  if (row.connection.provider === "notion") return ["none", "provider_granted"];
  return providerStatus?.organization.maxAccess === "read_only"
    ? ["none", "read_only"]
    : ["none", "read_only", "read_write"];
}

export function AgentManagedMcpConnections({
  agentId,
  orgId,
  providerStatuses,
  providers,
  showOnlyEnabled = false,
}: {
  agentId: string;
  orgId?: string;
  providerStatuses?: McpProviderAvailability[];
  providers?: McpConnectionProvider[];
  showOnlyEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [selected, setSelected] = useState<McpAgentConnectionSummary | null>(null);
  const [access, setAccess] = useState<McpAgentAccessMode>("none");
  const [conflictMessage, setConflictMessage] = useState("");
  const query = useQuery({
    queryKey: queryKeys.agents.mcpConnections(agentId),
    queryFn: () => agentsApi.listMcpConnections(agentId, orgId),
  });
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.mcpConnections(agentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.mcpProviderStatus(agentId) }),
    ]);
  };
  useEffect(() => {
    if (!selected) return;
    setAccess(selected.binding?.accessMode ?? "none");
    setConflictMessage("");
  }, [selected]);
  const mutation = useMutation({
    mutationFn: (input: { row: McpAgentConnectionSummary; accessMode: McpAgentAccessMode }) =>
      agentsApi.updateMcpConnectionBinding(
        agentId,
        input.row.connection.id,
        buildManagedMcpBindingUpdate(input.row, input.accessMode),
        orgId,
      ),
    onSuccess: async () => {
      await invalidate();
      setSelected(null);
      pushToast({ title: "Agent access updated", tone: "success" });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflictMessage("Settings changed elsewhere. Review the latest access and try again.");
        await invalidate();
        await query.refetch();
        return;
      }
      pushToast({
        title: "Could not update agent access",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const rows = (query.data ?? []).filter((row) => {
    if (providers && !providers.includes(row.connection.provider)) return false;
    return !showOnlyEnabled || (
      row.binding?.status === "active"
      && (row.binding.accessMode ?? "none") !== "none"
    );
  });

  if (query.isLoading) {
    return (
      <div className="space-y-2" aria-label="Loading organization MCP connections">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/5 px-4 py-3">
        <p className="text-sm text-destructive">Could not load organization MCP connections.</p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
        <p className="text-sm font-medium text-foreground">
          {showOnlyEnabled
            ? "No managed MCP access enabled"
            : providers?.length === 1 && providers[0] === "custom"
              ? "No organization Custom MCPs"
              : "No organization MCP connections"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {showOnlyEnabled
            ? "Use Discover to choose access for this agent."
            : "Connect a provider in Organization Settings first."}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2" data-testid="agent-managed-mcp-connections">
        {rows.map((row) => {
          const currentAccess = row.binding?.accessMode ?? "none";
          return (
            <div
              key={row.connection.id}
              data-testid={`agent-mcp-connection-${row.connection.id}`}
              className="grid gap-3 rounded-md border border-border bg-background/35 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="flex min-w-0 items-center gap-3">
                <McpProviderIcon provider={row.connection.provider} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.connection.displayName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.reviewRequired ? "Review required" : accessLabel(currentAccess)}
                  </p>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => setSelected(row)}>
                {currentAccess === "none" ? "Set access" : "Manage"}
              </Button>
            </div>
          );
        })}
      </div>
      <Dialog open={Boolean(selected)} onOpenChange={(open) => {
        if (!open && !mutation.isPending) setSelected(null);
      }}>
        <DialogContent className="sm:max-w-md">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>Manage {selected.connection.displayName} access</DialogTitle>
                <DialogDescription>
                  {selected.reviewRequired
                    ? "The server tool catalog changed. Saving accepts the current catalog as one unit."
                    : "Choose the access available to this agent."}
                </DialogDescription>
              </DialogHeader>
              <fieldset className="space-y-2">
                <legend className="sr-only">Access</legend>
                {availableAccessModes(
                  selected,
                  providerStatuses?.find((status) => status.provider === selected.connection.provider),
                ).map((mode) => (
                  <label key={mode} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <input
                      type="radio"
                      name={`agent-access-${selected.connection.id}`}
                      checked={access === mode}
                      onChange={() => setAccess(mode)}
                    />
                    {accessLabel(mode)}
                  </label>
                ))}
              </fieldset>
              <p className="min-h-5 text-sm text-destructive" aria-live="polite">
                {conflictMessage}
              </p>
              <DialogFooter>
                <Button variant="outline" disabled={mutation.isPending} onClick={() => setSelected(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    mutation.isPending
                    || (
                      !selected.reviewRequired
                      && access === (selected.binding?.accessMode ?? "none")
                    )
                  }
                  onClick={() => mutation.mutate({ row: selected, accessMode: access })}
                >
                  Save
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
