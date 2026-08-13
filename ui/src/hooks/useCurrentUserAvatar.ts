import { useSyncExternalStore } from "react";
import { readDesktopIdentity } from "../lib/desktop-identity";

let avatarUrl: string | null = null;
let stopIdentitySubscription: (() => void) | null = null;
let storeGeneration = 0;
const listeners = new Set<() => void>();

function publishAvatar(nextAvatarUrl: string | null) {
  if (avatarUrl === nextAvatarUrl) return;
  avatarUrl = nextAvatarUrl;
  listeners.forEach((listener) => listener());
}

function startIdentitySubscription() {
  if (stopIdentitySubscription) return;
  const identity = readDesktopIdentity();
  if (!identity) return;

  const generation = ++storeGeneration;
  let stateVersion = 0;
  const applyState = (state: Awaited<ReturnType<typeof identity.getState>>) => {
    stateVersion += 1;
    publishAvatar(state.status === "signed-in" ? state.account.image : null);
  };

  const unsubscribe = identity.onStateChanged(applyState);
  stopIdentitySubscription = () => {
    storeGeneration += 1;
    stopIdentitySubscription = null;
    unsubscribe();
  };
  const initialStateVersion = stateVersion;
  void identity.getState().then(async (state) => {
    if (generation !== storeGeneration || stateVersion !== initialStateVersion) return;
    applyState(state);
    if (state.status !== "signed-in") return;

    const profileVersion = stateVersion;
    try {
      const profile = await identity.getProfile();
      if (generation === storeGeneration && stateVersion === profileVersion) publishAvatar(profile.image);
    } catch {
      // The state image remains the best available value when profile refresh fails.
    }
  }).catch(() => {
    if (generation === storeGeneration) publishAvatar(null);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  startIdentitySubscription();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopIdentitySubscription?.();
    publishAvatar(null);
  };
}

export function useCurrentUserAvatar(): string | null {
  return useSyncExternalStore(subscribe, () => avatarUrl, () => null);
}
