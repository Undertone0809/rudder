export type DesktopIdentityState =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | {
      status: "signed-in";
      account: {
        id: string;
        email: string | null;
        name: string;
        image: string | null;
      };
      deviceId: string;
    }
  | {
      status: "error";
      message: string;
      recoverable?: boolean;
    };

export type DesktopIdentityDeviceSession = {
  id: string;
  name: string;
  platform: string | null;
  createdAt: string | null;
  lastSeenAt: string;
  current: boolean;
};

export type DesktopIdentityApi = {
  getState(): Promise<DesktopIdentityState>;
  signIn(): Promise<DesktopIdentityState>;
  signOut(): Promise<DesktopIdentityState>;
  listDeviceSessions(): Promise<DesktopIdentityDeviceSession[]>;
  revokeDeviceSession(sessionId: string): Promise<void>;
  getProfile(): Promise<{ id: string; email: string; name: string; image: string | null }>;
  updateProfile(input: { image: string | null }): Promise<{
    id: string;
    email: string;
    name: string;
    image: string | null;
  }>;
  onStateChanged(listener: (state: DesktopIdentityState) => void): () => void;
};

export function readDesktopIdentity(): DesktopIdentityApi | null {
  if (typeof window === "undefined") return null;
  return (
    window as typeof window & { desktopIdentity?: DesktopIdentityApi }
  ).desktopIdentity ?? null;
}
