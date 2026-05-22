import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { resolveOperatorDisplayName } from "@/lib/operator-display";

export function useOperatorDisplayName(): string {
  const { data } = useQuery({
    queryKey: queryKeys.instance.profileSettings,
    queryFn: () => instanceSettingsApi.getProfile(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  return resolveOperatorDisplayName(data?.nickname);
}
