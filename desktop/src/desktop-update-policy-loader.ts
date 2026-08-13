import fs from "node:fs";
import path from "node:path";
import {
  acceptAutomaticUpdatePolicySequenceAtPath,
  readDesktopAutoUpdateState,
  resolveDesktopAutoUpdateStatePath,
} from "./desktop-auto-update-state.js";
import {
  findAuthorizedDesktopRelease,
  verifyDesktopUpdatePolicy,
  type DesktopUpdatePolicyPayload,
  type SignedDesktopUpdatePolicy,
} from "./desktop-update-policy.js";
import { DESKTOP_UPDATE_POLICY_URL, DESKTOP_UPDATE_TRUST_KEYS } from "./desktop-update-trust.js";

export type DesktopUpdatePolicyLoaderOptions = {
  userDataPath: string;
  channel: "stable" | "canary" | (() => "stable" | "canary");
  arch: string;
  policyUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  keys?: Readonly<Record<string, string | Buffer>>;
};

export type DesktopUpdatePolicyAuthorization = {
  policy: DesktopUpdatePolicyPayload;
  release: ReturnType<typeof findAuthorizedDesktopRelease>;
};

export type DesktopUpdatePolicyLoadResult =
  | { ok: true; policy: DesktopUpdatePolicyPayload; source: "cache" | "network" }
  | { ok: false; reason: string };

function policyCachePath(userDataPath: string): string {
  return path.join(userDataPath, "desktop-update-policy.json");
}

function parseEnvelope(value: unknown): SignedDesktopUpdatePolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) return null;
  if (typeof envelope.signature !== "string") return null;
  return { payload: envelope.payload as DesktopUpdatePolicyPayload, signature: envelope.signature };
}

function writePolicyCache(cachePath: string, envelope: SignedDesktopUpdatePolicy): void {
  const directory = path.dirname(cachePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, cachePath);
}

function readPolicyCache(cachePath: string): SignedDesktopUpdatePolicy | null {
  try {
    return parseEnvelope(JSON.parse(fs.readFileSync(cachePath, "utf8")));
  } catch {
    return null;
  }
}

function readPolicyState(statePath: string): ReturnType<typeof readDesktopAutoUpdateState> | null {
  try {
    return readDesktopAutoUpdateState(statePath);
  } catch {
    return null;
  }
}

function policyMatchesRuntime(policy: DesktopUpdatePolicyPayload, options: DesktopUpdatePolicyLoaderOptions): boolean {
  const channel = typeof options.channel === "function" ? options.channel() : options.channel;
  return policy.channel === channel
    && policy.platform === "darwin"
    && policy.arch === options.arch;
}

/**
 * Loads an authenticated update policy. A verified policy is cached only after
 * its monotonic sequence is durably accepted in the update state file. A
 * network policy can never replace a newer accepted policy.
 */
export function createDesktopUpdatePolicyLoader(options: DesktopUpdatePolicyLoaderOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const keys = options.keys ?? DESKTOP_UPDATE_TRUST_KEYS;
  const cachePath = policyCachePath(options.userDataPath);
  const statePath = resolveDesktopAutoUpdateStatePath(options.userDataPath);
  let current: DesktopUpdatePolicyPayload | null = null;

  function verifyEnvelope(envelope: SignedDesktopUpdatePolicy, highestAcceptedSequence: number): DesktopUpdatePolicyLoadResult {
    const result = verifyDesktopUpdatePolicy(envelope, {
      keys,
      highestAcceptedSequence,
      now: options.now?.() ?? new Date(),
    });
    if (!result.ok) return result;
    if (!policyMatchesRuntime(result.policy, options)) return { ok: false, reason: "policy_runtime_mismatch" };
    return { ok: true, policy: result.policy, source: "cache" };
  }

  function loadCached(): DesktopUpdatePolicyLoadResult {
    const envelope = readPolicyCache(cachePath);
    if (!envelope) return { ok: false, reason: "policy_cache_missing_or_malformed" };
    const state = readPolicyState(statePath);
    if (!state) return { ok: false, reason: "policy_state_unreadable" };
    // A cached policy at the accepted sequence is valid only as the exact
    // authenticated artifact already committed by this install. Verification
    // still enforces expiry, signature, runtime, and release shape.
    const result = verifyEnvelope(envelope, -1);
    if (!result.ok) return result;
    if (result.policy.sequence !== state.acceptedPolicySequence) {
      return { ok: false, reason: "policy_cache_sequence_not_accepted" };
    }
    current = result.policy;
    return result;
  }

  async function refresh(): Promise<DesktopUpdatePolicyLoadResult> {
    const state = readPolicyState(statePath);
    if (!state) return { ok: false, reason: "policy_state_unreadable" };
    let response: Response;
    try {
      response = await fetchImpl(options.policyUrl ?? DESKTOP_UPDATE_POLICY_URL, {
        headers: { Accept: "application/json", "User-Agent": "Rudder-Desktop" },
      });
    } catch {
      return loadCached();
    }
    if (!response.ok) return loadCached();
    let envelope: SignedDesktopUpdatePolicy | null;
    try {
      envelope = parseEnvelope(await response.json());
    } catch {
      envelope = null;
    }
    if (!envelope) return loadCached();
    const result = verifyEnvelope(envelope, state.acceptedPolicySequence);
    if (!result.ok) {
      // A replayed network policy is not allowed to replace the cache. If it is
      // the already accepted policy, the authenticated cache remains usable.
      if (result.reason === "policy_sequence_replay") return loadCached();
      return result;
    }
    try {
      acceptAutomaticUpdatePolicySequenceAtPath(statePath, result.policy.sequence);
      writePolicyCache(cachePath, envelope);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "policy_sequence_accept_failed" };
    }
    current = result.policy;
    return { ...result, source: "network" };
  }

  function getPolicy(): DesktopUpdatePolicyPayload | null {
    if (current && policyMatchesRuntime(current, options)) {
      const now = options.now?.() ?? new Date();
      if (Date.parse(current.issuedAt) <= now.getTime() && Date.parse(current.expiresAt) > now.getTime()) return current;
      current = null;
    }
    const cached = loadCached();
    return cached.ok ? cached.policy : null;
  }

  function authorizeRelease(input: {
    version: string;
    assetName: string;
    assetSha256: string;
    releaseDigest: string;
    channel?: "stable" | "canary";
  }): DesktopUpdatePolicyAuthorization | null {
    const policy = getPolicy();
    if (!policy || (input.channel && policy.channel !== input.channel)) return null;
    const release = findAuthorizedDesktopRelease(policy, input);
    return release ? { policy, release } : null;
  }

  return {
    cachePath,
    statePath,
    loadCached,
    refresh,
    getPolicy,
    authorizeRelease,
    hasUsablePolicy: () => getPolicy() !== null,
  };
}

export { policyCachePath };
