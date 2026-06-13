import { instanceSettingsApi } from "@/api/instanceSettings";
import { resolveOperatorDisplayName } from "@/lib/operator-display";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { useQuery } from "@tanstack/react-query";

export function useOperatorDisplayName(): string {
  const { data } = useQuery({
    queryKey: queryKeys.instance.profileSettings,
    queryFn: () => instanceSettingsApi.getProfile(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  return resolveOperatorDisplayName(data?.nickname);
}
