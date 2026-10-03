import type { AuthSession } from "@/api/auth";
import { useChatGenerationActions } from "@/context/ChatGenerationContext";
import { useOptionalSidePanel } from "@/context/SidePanelContext";
import { queryKeys } from "@/lib/queryKeys";
import { sideChatGenerationOwnerKey } from "@/lib/side-panel-targets";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef } from "react";

export function useSideChatGenerationOwner() {
  const sidePanel = useOptionalSidePanel();
  const principalId = sidePanel?.principalId ?? null;
  const ownerKey = sideChatGenerationOwnerKey(principalId);
  const queryClient = useQueryClient();
  const { invalidateChatGenerationsForOwner } = useChatGenerationActions();
  const previousOwnerKeyRef = useRef(ownerKey);

  useLayoutEffect(() => {
    const previousOwnerKey = previousOwnerKeyRef.current;
    if (previousOwnerKey !== ownerKey) {
      invalidateChatGenerationsForOwner(previousOwnerKey);
      previousOwnerKeyRef.current = ownerKey;
    }
  }, [invalidateChatGenerationsForOwner, ownerKey]);

  const isCurrent = useCallback((candidateOwnerKey: string, ownerSignal?: AbortSignal) => {
    const session = sidePanel
      ? queryClient.getQueryData<AuthSession | null>(queryKeys.auth.session)
      : null;
    const currentPrincipalId = session?.user?.id ?? session?.session?.userId ?? null;
    if (ownerSignal?.aborted || (sidePanel && currentPrincipalId !== principalId)) {
      invalidateChatGenerationsForOwner(candidateOwnerKey);
      return false;
    }
    return true;
  }, [invalidateChatGenerationsForOwner, principalId, queryClient, sidePanel]);

  return { principalId, ownerKey, isCurrent };
}
