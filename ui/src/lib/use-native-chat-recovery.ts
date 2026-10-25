import { chatsApi } from "@/api/chats";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";

type NativeChatRecoveryStatus =
  | { kind: "legacy" }
  | { kind: "unsupported" }
  | { kind: "native"; recovery: Awaited<ReturnType<typeof chatsApi.readNativeChatRecovery>>["recovery"] }
  | { kind: "unavailable" }
  | { kind: "checking" };

export function useNativeChatRecovery(orgId: string | null | undefined, chatId: string | null | undefined) {
  const query = useQuery({
    queryKey: queryKeys.chats.nativeRecovery(orgId ?? "__none__", chatId ?? "__none__"),
    enabled: Boolean(orgId && chatId),
    retry: false,
    queryFn: async () => {
      const capabilities = await chatsApi.getNativeChatCapabilities();
      if (!capabilities) return { kind: "legacy" } as const;
      if (capabilities.recoveryRead !== true) return { kind: "unsupported" } as const;
      try {
        const read = await chatsApi.readNativeChatRecovery(chatId!, orgId!);
        return { kind: "native", recovery: read.recovery } as const;
      } catch {
        return { kind: "unavailable" } as const;
      }
    },
    refetchInterval: (current) => (
      Boolean(current.state.error)
      || current.state.data?.kind === "unavailable"
      || (current.state.data?.kind === "native" && current.state.data.recovery !== null)
        ? 3_000
        : false
    ),
  });

  const status: NativeChatRecoveryStatus = query.data
    ?? (query.isError ? { kind: "unavailable" } : { kind: "checking" });
  return {
    ...query,
    status,
    unavailable: status.kind === "unavailable",
    recovery: status.kind === "native" ? status.recovery : null,
  };
}
