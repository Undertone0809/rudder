import { useEffect, useState } from "react";
import { readDesktopIdentity } from "../lib/desktop-identity";

export function useCurrentUserAvatar(): string | null {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    const identity = readDesktopIdentity();
    if (!identity) return;

    let cancelled = false;
    let stateVersion = 0;
    const applyState = (state: Awaited<ReturnType<typeof identity.getState>>) => {
      stateVersion += 1;
      if (state.status !== "signed-in") {
        setAvatarUrl(null);
        return;
      }
      setAvatarUrl(state.account.image);
    };

    const unsubscribe = identity.onStateChanged(applyState);
    void identity.getState().then(async (state) => {
      if (cancelled) return;
      applyState(state);
      if (state.status !== "signed-in") return;

      const profileVersion = stateVersion;
      try {
        const profile = await identity.getProfile();
        if (!cancelled && stateVersion === profileVersion) setAvatarUrl(profile.image);
      } catch {
        // The state image remains the best available value when profile refresh fails.
      }
    }).catch(() => {
      if (!cancelled) setAvatarUrl(null);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return avatarUrl;
}
