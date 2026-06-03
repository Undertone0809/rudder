import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function invalidateMessengerThreadSummaryQueries(queryClient: QueryClient, orgId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threadPages(orgId) }),
  ]);
}
