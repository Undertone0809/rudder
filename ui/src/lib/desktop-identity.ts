export type DesktopIdentityState =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | {
      status: "signed-in";
      account: {
        id: string;
        email: string | null;
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
  onStateChanged(listener: (state: DesktopIdentityState) => void): () => void;
};

export function readDesktopIdentity(): DesktopIdentityApi | null {
  if (typeof window === "undefined") return null;
  return (
    window as typeof window & { desktopIdentity?: DesktopIdentityApi }
  ).desktopIdentity ?? null;
}
