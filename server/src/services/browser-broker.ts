export const BROWSER_ACTIONS = [
  "tabs",
  "open",
  "navigate",
  "read",
  "click",
  "type",
  "screenshot",
  "close",
] as const;

export type BrowserAction = typeof BROWSER_ACTIONS[number];

export type BrowserRuntimeIdentity = {
  orgId: string;
  agentId: string;
  runId: string;
};

export type BrowserBrokerCommand = {
  identity: BrowserRuntimeIdentity;
  action: BrowserAction;
  args: Record<string, unknown>;
};

type BrowserBrokerRegistration = {
  endpoint: string;
  token: string;
};

type BrowserBrokerEnvelope = {
  ok?: unknown;
  result?: unknown;
  error?: unknown;
};

export class BrowserBrokerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function normalizeLoopbackBrokerEndpoint(rawEndpoint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new BrowserBrokerError("browser_broker_invalid_registration", "Browser Broker endpoint must be a valid loopback HTTP URL.");
  }

  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (endpoint.protocol !== "http:" || (hostname !== "127.0.0.1" && hostname !== "::1")) {
    throw new BrowserBrokerError("browser_broker_invalid_registration", "Browser Broker endpoint must use loopback HTTP.");
  }
  if (!endpoint.port) {
    throw new BrowserBrokerError("browser_broker_invalid_registration", "Browser Broker endpoint must use an explicit loopback port.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new BrowserBrokerError("browser_broker_invalid_registration", "Browser Broker endpoint cannot contain credentials, query parameters, or a fragment.");
  }
  return endpoint.toString();
}

function normalizeBrokerCredential(rawToken: string): string {
  const token = rawToken.trim();
  if (token.length < 32 || token.length > 512 || /\s/.test(token)) {
    throw new BrowserBrokerError("browser_broker_invalid_registration", "Browser Broker credential is invalid.");
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedBrokerFailure(payload: BrowserBrokerEnvelope, fallbackCode: string, fallbackMessage: string) {
  const error = isRecord(payload.error) ? payload.error : {};
  const code = typeof error.code === "string" && /^browser_[a-z0-9_]+$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 300)
    : fallbackMessage;
  return new BrowserBrokerError(code, message);
}

export type BrowserBrokerRegistry = ReturnType<typeof createBrowserBrokerRegistry>;

export function createBrowserBrokerRegistry(options: {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
} = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  let registration: BrowserBrokerRegistration | null = null;

  return {
    register(input: BrowserBrokerRegistration): void {
      registration = {
        endpoint: normalizeLoopbackBrokerEndpoint(input.endpoint),
        token: normalizeBrokerCredential(input.token),
      };
    },

    unregister(token: string): boolean {
      if (!registration || registration.token !== token) return false;
      registration = null;
      return true;
    },

    isAvailable(): boolean {
      return registration !== null;
    },

    async forward(command: BrowserBrokerCommand): Promise<unknown> {
      const current = registration;
      if (!current) {
        throw new BrowserBrokerError("browser_unavailable", "Rudder Browser is unavailable because Desktop is not connected.");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(current.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${current.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
          signal: controller.signal,
        });
      } catch {
        throw new BrowserBrokerError("browser_unavailable", "Rudder Browser Desktop Broker could not be reached.");
      } finally {
        clearTimeout(timeout);
      }

      let payload: BrowserBrokerEnvelope;
      try {
        payload = JSON.parse(await response.text()) as BrowserBrokerEnvelope;
      } catch {
        throw new BrowserBrokerError("browser_broker_protocol_error", "Rudder Browser Desktop Broker returned an invalid response.");
      }

      if (!response.ok || payload.ok !== true) {
        throw sanitizedBrokerFailure(payload, "browser_broker_error", "Rudder Browser action failed.");
      }
      return payload.result ?? {};
    },
  };
}

export const browserBrokerRegistry = createBrowserBrokerRegistry();
