import type { IdentityAccount, IdentityDevice } from "./identity-client.js";
import type { IdentityCredentialVault, IdentityDeviceCredential } from "./identity-credential-vault.js";

export const DESKTOP_IDENTITY_PRODUCTION_ORIGIN = "https://accounts.rudderhq.dev";

export const DESKTOP_IDENTITY_IPC_CHANNELS = {
  getState: "desktop:identity:get-state",
  signIn: "desktop:identity:sign-in",
  signOut: "desktop:identity:sign-out",
  listDeviceSessions: "desktop:identity:list-device-sessions",
  revokeDeviceSession: "desktop:identity:revoke-device-session",
  stateChanged: "desktop:identity:state-changed",
} as const;

export type DesktopIdentityState =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | {
    status: "device-authorization";
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresAt: string;
  }
  | {
    status: "signed-in";
    account: {
      id: string;
      email: string | null;
    };
    deviceId: string;
  }
  | { status: "error"; message: string; recoverable?: boolean };

export type DesktopIdentityDeviceSession = {
  id: string;
  name: string;
  platform: string | null;
  createdAt: string | null;
  lastSeenAt: string;
  current: boolean;
};

type IpcEvent = { sender: unknown; senderFrame: unknown };
type Renderer = {
  mainFrame: unknown;
  isDestroyed?(): boolean;
  send?(channel: string, payload: unknown): void;
};
type IpcMainLike = {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
};

type DesktopIdentityClient = {
  signIn(): Promise<{ account: IdentityAccount; device: IdentityDevice; accessToken: string }>;
  signOut(): Promise<void>;
  listDeviceSessions(): Promise<DesktopIdentityDeviceSession[]>;
  revokeDeviceSession(deviceId: string): Promise<void>;
};

export function resolveDesktopIdentityOrigin(options: {
  isPackaged: boolean;
  override?: string | null;
}): string {
  const override = options.override?.trim();
  if (options.isPackaged || !override) return DESKTOP_IDENTITY_PRODUCTION_ORIGIN;

  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error("RUDDER_IDENTITY_ORIGIN must be a valid loopback URL");
  }
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.username
    || url.password
  ) {
    throw new Error("Development Rudder Identity overrides must use explicit HTTP loopback");
  }
  return url.origin;
}

function noArguments(args: unknown[], label: string): void {
  if (args.length !== 0) throw new Error(`${label} does not accept renderer arguments`);
}

function deviceIdPayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Device revocation requires a narrow opaque id payload");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 1
    || keys[0] !== "deviceId"
    || typeof record.deviceId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(record.deviceId)
  ) {
    throw new Error("Device revocation requires a valid opaque device id");
  }
  return record.deviceId;
}

function assertCurrentMainFrame(event: IpcEvent, getMainRenderer: () => Renderer | null): Renderer {
  const renderer = getMainRenderer();
  if (
    !renderer
    || renderer.isDestroyed?.()
    || event.sender !== renderer
    || event.senderFrame !== renderer.mainFrame
  ) {
    throw new Error("Rudder Account IPC is restricted to the current renderer main frame");
  }
  return renderer;
}

function stateFromCredential(
  origin: string,
  credential: IdentityDeviceCredential | null,
): DesktopIdentityState {
  if (!credential || credential.issuer !== origin) return { status: "signed-out" };
  return {
    status: "signed-in",
    account: {
      id: credential.accountId,
      email: credential.accountEmail || null,
    },
    deviceId: credential.deviceId,
  };
}

export function createDesktopIdentityIpcController(options: {
  origin: string;
  vault: Pick<IdentityCredentialVault, "read" | "status">;
  client: DesktopIdentityClient;
  getMainRenderer(): Renderer | null;
  onSignedIn?(): Promise<void>;
  onBeforeSignedOut?(): Promise<void>;
  onSignedOut?(): Promise<void>;
}) {
  const initialVaultStatus = options.vault.status();
  let state: DesktopIdentityState = initialVaultStatus.available
    ? stateFromCredential(options.origin, options.vault.read())
    : {
      status: "error",
      message: "Secure credential storage is unavailable on this device.",
      recoverable: false,
    };
  let signInInFlight: Promise<DesktopIdentityState> | null = null;

  const publish = (next: DesktopIdentityState): DesktopIdentityState => {
    state = next;
    const renderer = options.getMainRenderer();
    if (renderer && !renderer.isDestroyed?.()) {
      renderer.send?.(DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged, next);
    }
    return next;
  };

  return {
    getState(): DesktopIdentityState {
      return state;
    },

    showDeviceAuthorizationPrompt(prompt: {
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      expiresAt: string;
    }): DesktopIdentityState {
      return publish({ status: "device-authorization", ...prompt });
    },

    signIn(): Promise<DesktopIdentityState> {
      if (signInInFlight) return signInInFlight;
      publish({ status: "signing-in" });
      const request = options.client.signIn()
        .then(async ({ account, device }) => {
          const signedIn = publish({
            status: "signed-in",
            account: {
              id: account.id,
              email: account.email,
            },
            deviceId: device.id,
          });
          await options.onSignedIn?.();
          return signedIn;
        })
        .catch((error: unknown) => publish({
          status: "error",
          message: error instanceof Error ? error.message : "Rudder Account sign-in failed.",
          recoverable: true,
        }))
        .finally(() => {
          signInInFlight = null;
        });
      signInInFlight = request;
      return request;
    },

    async signOut(): Promise<DesktopIdentityState> {
      try {
        await options.onBeforeSignedOut?.();
      } catch (error) {
        console.warn(
          "[rudder-desktop] local session revocation failed; continuing account sign-out",
          error,
        );
      }
      await options.client.signOut();
      const signedOut = publish({ status: "signed-out" });
      await options.onSignedOut?.();
      return signedOut;
    },

    listDeviceSessions(): Promise<DesktopIdentityDeviceSession[]> {
      return options.client.listDeviceSessions();
    },

    revokeDeviceSession(deviceId: string): Promise<void> {
      return options.client.revokeDeviceSession(deviceId);
    },
  };
}

export function registerDesktopIdentityIpcHandlers(
  ipcMain: IpcMainLike,
  options: {
    getMainRenderer(): Renderer | null;
    controller: ReturnType<typeof createDesktopIdentityIpcController>;
  },
): void {
  const register = (
    channel: string,
    handler: (event: IpcEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertCurrentMainFrame(event, options.getMainRenderer);
      return await handler(event, ...args);
    });
  };

  register(DESKTOP_IDENTITY_IPC_CHANNELS.getState, (_event, ...args) => {
    noArguments(args, "Rudder Account state");
    return options.controller.getState();
  });
  register(DESKTOP_IDENTITY_IPC_CHANNELS.signIn, (_event, ...args) => {
    noArguments(args, "Rudder Account sign-in");
    return options.controller.signIn();
  });
  register(DESKTOP_IDENTITY_IPC_CHANNELS.signOut, (_event, ...args) => {
    noArguments(args, "Rudder Account sign-out");
    return options.controller.signOut();
  });
  register(DESKTOP_IDENTITY_IPC_CHANNELS.listDeviceSessions, (_event, ...args) => {
    noArguments(args, "Rudder Account device session list");
    return options.controller.listDeviceSessions();
  });
  register(DESKTOP_IDENTITY_IPC_CHANNELS.revokeDeviceSession, (_event, payload) =>
    options.controller.revokeDeviceSession(deviceIdPayload(payload)));
}
