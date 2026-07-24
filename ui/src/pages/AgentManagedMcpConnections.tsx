import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { McpAgentConnectionSummary } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PlugZap, Unplug, Wrench } from "lucide-react";
import { agentsApi } from "../api/agents";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

export function buildManagedMcpBindingUpdate(
  row: McpAgentConnectionSummary,
  enabledToolIds?: string[],
  activate = false,
) {
  if (!row.binding) return {};
  return activate ? { status: "active" as const, enabledToolIds } : { enabledToolIds };
}

export function AgentManagedMcpConnections({
  agentId,
  orgId,
}: {
  agentId: string;
  orgId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const query = useQuery({
    queryKey: queryKeys.agents.mcpConnections(agentId),
    queryFn: () => agentsApi.listMcpConnections(agentId, orgId),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.mcpConnections(agentId) });
  const mutation = useMutation({
    mutationFn: (input: {
      row: McpAgentConnectionSummary;
      enabledToolIds?: string[];
      activate?: boolean;
      disconnect?: boolean;
    }) => input.disconnect
      ? agentsApi.revokeMcpConnectionBinding(agentId, input.row.connection.id, orgId)
      : agentsApi.updateMcpConnectionBinding(
          agentId,
          input.row.connection.id,
          buildManagedMcpBindingUpdate(input.row, input.enabledToolIds, input.activate),
          orgId,
        ),
    onSuccess: async (_result, input) => {
      await invalidate();
      pushToast({
        title: input.disconnect ? "Agent MCP disconnected" : "Agent MCP tools updated",
        tone: "success",
      });
    },
    onError: (error) => pushToast({
      title: "Could not update agent MCP tools",
      body: error instanceof Error ? error.message : undefined,
      tone: "error",
    }),
  });
  const rows = query.data ?? [];
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-4 py-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading organization MCP connections
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="rounded-md border border-destructive/25 bg-destructive/5 px-4 py-5">
        <p className="text-sm font-medium text-destructive">
          Could not load organization MCP connections
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {query.error instanceof Error ? query.error.message : "Try again or ask an organization owner."}
        </p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
        <p className="text-sm font-medium text-foreground">No organization MCP connections</p>
        <p className="mt-1 text-sm text-muted-foreground">
          An organization owner can connect Supabase, Linear, Notion, or a custom MCP in Organization Settings.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="agent-managed-mcp-connections">
      {rows.map((row) => {
        const activeTools = row.tools.filter((tool) => tool.enabled && !tool.removedAt);
        const enabledIds = new Set(row.binding?.enabledToolIds ?? []);
        const bound = row.binding?.status === "active";
        return (
          <div
            key={row.connection.id}
            data-testid={`agent-mcp-connection-${row.connection.id}`}
            className="rounded-md border border-border bg-background/35 p-3"
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                  <PlugZap className="size-4.5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{row.connection.displayName}</p>
                    <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                      {row.connection.provider}
                    </span>
                    <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                      {activeTools.length} tools
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.connection.externalScope ?? "Organization connection"} · {row.connection.accessMode.replace("_", " ")}
                  </p>
                </div>
              </div>
              {bound ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ row, disconnect: true })}
                >
                  <Unplug className="size-3.5" /> Unbind
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={mutation.isPending || activeTools.length === 0}
                  onClick={() => mutation.mutate({
                    row,
                    enabledToolIds: activeTools.map((tool) => tool.id),
                    activate: true,
                  })}
                >
                  <PlugZap className="size-3.5" /> Bind all current tools
                </Button>
              )}
            </div>
            {bound ? (
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Wrench className="size-3.5" /> Tool allowlist
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {activeTools.map((tool) => {
                    const checked = enabledIds.has(tool.id);
                    return (
                      <label
                        key={tool.id}
                        className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border/70 p-2"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={mutation.isPending}
                          onCheckedChange={(next) => {
                            const ids = new Set(enabledIds);
                            if (next === true) ids.add(tool.id);
                            else ids.delete(tool.id);
                            mutation.mutate({ row, enabledToolIds: [...ids] });
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-xs text-foreground">
                            {tool.rudderToolName}
                          </span>
                          {tool.description ? (
                            <span className="line-clamp-2 block text-xs text-muted-foreground">
                              {tool.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Newly discovered tools stay off until an owner enables them here.
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
