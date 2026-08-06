import { useQuery } from "@tanstack/react-query";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

export function useExperimentalGoalsEnabled() {
  const query = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  return {
    enabled: query.data?.features?.experimentalGoalsEnabled === true,
    isLoading: query.isLoading,
    error: query.error,
    retry: query.refetch,
  };
}
