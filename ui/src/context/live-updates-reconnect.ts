import type { Project } from "@rudderhq/shared";
import type { QueryClient } from "@tanstack/react-query";

/** Reconcile persisted read models when refresh hints were missed offline. */
export async function reconcileLiveUpdatesAfterReconnect(client: QueryClient, orgId: string) {
  // Idle queues do not poll; preserve their existing non-cancelling wakeup.
  void client.invalidateQueries(
    { queryKey: ["chats", orgId, "queue"] },
    { cancelRefetch: false },
  );
  const filters = {
    predicate: (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => {
      const [family, scope, , lookupOrg] = query.queryKey;
      if (family === "organizations") {
        return query.queryKey.length === 1 || (scope === orgId && query.queryKey.length === 2);
      }
      if (["activity", "dashboard", "sidebar-badges"].includes(String(family))) return scope === orgId;
      if (family !== "projects") return false;
      if (scope === orgId) return true;
      if (scope !== "detail") return false;
      // Production detail queries carry the lookup organization as segment 4.
      // Older three-segment caches can be scoped using their persisted model.
      return lookupOrg === orgId || (query.queryKey.length === 3
        && (query.state.data as Project | undefined)?.orgId === orgId);
    },
  };
  // invalidateQueries alone reuses a pending first fetch without cached data.
  // Cancel that pre-disconnect read before starting an authoritative new one.
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}
