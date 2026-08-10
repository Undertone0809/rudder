import type { ComputerUseBrokerCommand } from "@rudderhq/shared";

type ComputerBrokerRegistration = {
  endpoint: string;
  token: string;
  ownerId?: string;
  generation?: number;
  refresh?: boolean;
};

type ActiveComputerBrokerRegistration = ComputerBrokerRegistration & { lastSeenAt: number };

type ComputerBrokerEnvelope = { ok?: unknown; result?: unknown; error?: unknown };
const DEFAULT_MAX_RESPONSE_BYTES = 18 * 1024 * 1024;
const DEFAULT_LEASE_TTL_MS = 20_000;

export class ComputerBrokerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normalizeEndpoint(raw: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new ComputerBrokerError("computer_broker_invalid_registration", "Computer Broker endpoint is invalid.");
  }
  const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ComputerBrokerError(
      "computer_broker_invalid_registration",
      "Computer Broker endpoint must be an explicit loopback HTTP URL.",
    );
  }
  return endpoint.toString();
}

function normalizeToken(raw: string): string {
  const token = raw.trim();
  if (token.length < 32 || token.length > 512 || /\s/u.test(token)) {
    throw new ComputerBrokerError("computer_broker_invalid_registration", "Computer Broker credential is invalid.");
  }
  return token;
}

function registrationKey(value: ComputerBrokerRegistration): string | null {
  if (value.ownerId === undefined || value.generation === undefined) return null;
  return `${value.ownerId.trim()}:${value.generation}:${value.token}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ComputerBrokerError("computer_result_too_large", "Computer Broker response exceeded the size limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ComputerBrokerError("computer_result_too_large", "Computer Broker response exceeded the size limit.");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

export type ComputerBrokerRegistry = ReturnType<typeof createComputerBrokerRegistry>;

export function createComputerBrokerRegistry(options: {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  leaseTtlMs?: number;
  now?: () => number;
} = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 40_000;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? Date.now;
  let active: ActiveComputerBrokerRegistration | null = null;
  const retired = new Map<string, "revoked" | "superseded">();
  const requests = new Set<AbortController>();
  const retire = (reason: "revoked" | "superseded") => {
    const key = active ? registrationKey(active) : null;
    if (key) retired.set(key, reason);
    active = null;
    for (const request of requests) request.abort();
    requests.clear();
  };
  const expireLease = () => {
    if (!active || now() - active.lastSeenAt <= leaseTtlMs) return;
    active = null;
    for (const request of requests) request.abort();
    requests.clear();
  };

  return {
    register(input: ComputerBrokerRegistration) {
      expireLease();
      const endpoint = normalizeEndpoint(input.endpoint);
      const token = normalizeToken(input.token);
      const hasVersion = input.ownerId !== undefined || input.generation !== undefined;
      if (hasVersion && (typeof input.ownerId !== "string" || !input.ownerId.trim()
        || !Number.isSafeInteger(input.generation) || Number(input.generation) < 1)) {
        throw new ComputerBrokerError("computer_broker_invalid_registration", "Computer Broker generation is invalid.");
      }
      const next = { ...input, endpoint, token };
      const key = registrationKey(next);
      const retiredReason = key ? retired.get(key) : undefined;
      if (input.refresh && (!key || retiredReason)) {
        throw new ComputerBrokerError(
          retiredReason === "revoked" ? "computer_broker_revoked_registration" : "computer_broker_stale_registration",
          "Computer Broker registration no longer owns the Desktop lifecycle.",
        );
      }
      if (input.refresh && active && registrationKey(active) !== key) {
        throw new ComputerBrokerError("computer_broker_stale_registration", "Computer Broker registration is stale.");
      }
      if (!hasVersion && active?.ownerId) {
        throw new ComputerBrokerError("computer_broker_stale_registration", "Legacy registration cannot replace Desktop ownership.");
      }
      const currentActive = active;
      if (currentActive !== null && currentActive.ownerId === input.ownerId
        && currentActive.generation !== undefined && input.generation !== undefined) {
        if (input.generation < currentActive.generation || (input.generation === currentActive.generation && token !== currentActive.token)) {
          throw new ComputerBrokerError("computer_broker_stale_registration", "Computer Broker registration was superseded.");
        }
        if (input.generation === currentActive.generation && token === currentActive.token) {
          currentActive.lastSeenAt = now();
          return;
        }
      }
      retire("superseded");
      active = {
        endpoint,
        token,
        lastSeenAt: now(),
        ...(hasVersion ? { ownerId: input.ownerId!.trim(), generation: input.generation! } : {}),
      };
    },
    unregister(token: string) {
      if (!active || active.token !== token) return false;
      retire("revoked");
      return true;
    },
    revoke: () => retire("revoked"),
    isAvailable: () => {
      expireLease();
      return active !== null;
    },
    async forward(command: ComputerUseBrokerCommand): Promise<unknown> {
      expireLease();
      const current = active;
      if (!current) throw new ComputerBrokerError("computer_unavailable", "Rudder Desktop Computer Use is not connected.");
      const controller = new AbortController();
      requests.add(controller);
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ComputerBrokerError("computer_timeout", "Computer Use action timed out."));
        }, timeoutMs);
      });
      const request = async () => {
        let response: Response;
        try {
          response = await fetchImpl(current.endpoint, {
            method: "POST",
            redirect: "error",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${current.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(command),
            signal: controller.signal,
          });
        } catch {
          throw new ComputerBrokerError("computer_unavailable", "Rudder Desktop Computer Broker could not be reached.");
        }
        let payload: ComputerBrokerEnvelope;
        try {
          payload = JSON.parse(await readBounded(response, maxResponseBytes)) as ComputerBrokerEnvelope;
        } catch (error) {
          if (error instanceof ComputerBrokerError) throw error;
          throw new ComputerBrokerError("computer_broker_protocol_error", "Computer Broker returned an invalid response.");
        }
        if (!response.ok || payload.ok !== true) {
          const detail = isRecord(payload.error) ? payload.error : {};
          const code = typeof detail.code === "string" && /^computer_[a-z0-9_]+$/u.test(detail.code)
            ? detail.code : "computer_broker_error";
          const message = typeof detail.message === "string" && detail.message.trim()
            ? detail.message.trim().slice(0, 300) : "Computer Use action failed.";
          throw new ComputerBrokerError(code, message);
        }
        return payload.result ?? {};
      };
      try {
        return await Promise.race([request(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        requests.delete(controller);
      }
    },
  };
}

export const computerBrokerRegistry = createComputerBrokerRegistry();
