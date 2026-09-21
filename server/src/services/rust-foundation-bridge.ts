import type { Request } from "express";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export type RustFoundationMode = "off" | "shadow" | "required";

export type RustFoundationBridgeOptions = {
  databaseUrl: string;
  mode?: RustFoundationMode;
  binaryPath?: string;
  actorEnvelopeKey?: string;
  requestTimeoutMs?: number;
};

export type RustFoundationResponse = {
  status: number;
  contentType: string;
  body: Buffer;
};

export interface RustFoundationBridge {
  readonly mode: RustFoundationMode;
  start(): Promise<void>;
  memberDirectory(req: Request, orgId: string): Promise<RustFoundationResponse>;
  close(): Promise<void>;
}

export class RustFoundationBridgeError extends Error {
  constructor(
    public readonly code:
      | "invalid_mode"
      | "database_unconfigured"
      | "actor_envelope_unconfigured"
      | "binary_unavailable"
      | "startup_failed"
      | "not_ready"
      | "request_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RustFoundationBridgeError";
  }
}

type BridgeActor = Request["actor"] & {
  sessionId?: string;
  authEpoch?: number;
};

type StartupReceipt = {
  boundAddr?: unknown;
  publicListener?: unknown;
  productWriteAuthority?: unknown;
};

type RustFoundationChild = ChildProcessByStdio<null, Readable, Readable>;
type BridgeLifecycleState = "idle" | "starting" | "ready" | "closing";

const ACTOR_ENVELOPE_AUDIENCE = "rudder-server-foundation";
const ACTOR_ENVELOPE_ACTION = "organization.members.directory.read";
const ACTOR_ENVELOPE_PROTOCOL_VERSION = 2;
const ACTOR_ENVELOPE_SCHEMA = "rudder.actor-envelope.v2";
const ACTOR_ENVELOPE_LIFETIME_SECONDS = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;

function debugBridge(message: string) {
  if (process.env.RUDDER_RUST_BRIDGE_DEBUG === "true") {
    process.stderr.write(`[rudder-rust-bridge] ${message}\n`);
  }
}

function configuredMode(value: string | undefined): RustFoundationMode {
  const mode = value?.trim() || "off";
  if (mode === "off" || mode === "shadow" || mode === "required") return mode;
  throw new RustFoundationBridgeError(
    "invalid_mode",
    `RUDDER_RUST_MEMBER_DIRECTORY_MODE must be off, shadow, or required; received ${mode}`,
  );
}

function actorIdentity(actor: BridgeActor) {
  if (actor.type === "agent") {
    if (!actor.agentId) throw new RustFoundationBridgeError("request_failed", "Authenticated agent has no agent id");
    return { kind: "agent", id: actor.agentId };
  }
  if (actor.type === "board") {
    return { kind: "user", id: actor.userId ?? "local-board" };
  }
  throw new RustFoundationBridgeError("request_failed", "Rust bridge requires an authenticated actor");
}

function actorSession(actor: BridgeActor) {
  const explicit = actor.sessionId?.trim();
  if (explicit) return explicit;
  return `${actor.source}:${actor.keyId ?? actor.userId ?? actor.agentId ?? "unknown"}`;
}

function appendLengthPrefixed(output: Buffer[], value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  output.push(length, bytes);
}

function canonicalSigningBytes(input: {
  actor: { kind: string; id: string };
  organizationId: string;
  sessionId: string;
  authEpoch: number;
  audience: string;
  method: string;
  path: string;
  action: string;
  bodySha256: string;
  requestId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}) {
  const output: Buffer[] = [Buffer.from(ACTOR_ENVELOPE_SCHEMA, "utf8"), Buffer.from([0])];
  const protocol = Buffer.allocUnsafe(2);
  protocol.writeUInt16BE(ACTOR_ENVELOPE_PROTOCOL_VERSION);
  output.push(protocol);
  for (const field of [
    input.actor.kind,
    input.actor.id,
    input.organizationId,
    input.sessionId,
    input.audience,
    input.method,
    input.path,
    input.action,
    input.bodySha256,
    input.requestId,
    input.nonce,
  ]) {
    appendLengthPrefixed(output, field);
  }
  for (const value of [input.authEpoch, input.issuedAt, input.expiresAt]) {
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeBigUInt64BE(BigInt(value));
    output.push(encoded);
  }
  return Buffer.concat(output);
}

export function createRustActorEnvelope(input: {
  actor: BridgeActor;
  organizationId: string;
  method: string;
  path: string;
  action: string;
  body: Buffer;
  secret: string;
  nowSeconds?: number;
  requestId?: string;
  nonce?: string;
}) {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const requestId = input.requestId ?? randomUUID();
  const nonce = input.nonce ?? randomUUID();
  const actor = actorIdentity(input.actor);
  const sessionId = actorSession(input.actor);
  const authEpoch = Number.isSafeInteger(input.actor.authEpoch) && (input.actor.authEpoch ?? 0) > 0
    ? input.actor.authEpoch!
    : 1;
  const unsigned = {
    protocolVersion: ACTOR_ENVELOPE_PROTOCOL_VERSION,
    actor,
    organizationId: input.organizationId,
    sessionId,
    authEpoch,
    audience: ACTOR_ENVELOPE_AUDIENCE,
    method: input.method,
    path: input.path,
    action: input.action,
    bodySha256: createHash("sha256").update(input.body).digest("hex"),
    requestId,
    nonce,
    issuedAt: Math.max(1, now - 1),
    expiresAt: now + ACTOR_ENVELOPE_LIFETIME_SECONDS,
  };
  const signature = createHmac(
    "sha256",
    Buffer.from(input.secret, "utf8"),
  ).update(canonicalSigningBytes(unsigned)).digest("hex");
  return { ...unsigned, signature };
}

function isLoopbackBoundAddress(value: string) {
  const [host] = value.startsWith("[")
    ? [value.slice(1, value.indexOf("]"))]
    : value.split(":");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function candidateBinaryPaths(configured: string | undefined) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return [
    configured?.trim(),
    join(repositoryRoot, "native", "target", "debug", "rudder-server-foundation"),
    join(repositoryRoot, "native", "target", "release", "rudder-server-foundation"),
  ].filter((value): value is string => Boolean(value));
}

function createFoundationChildEnvironment(input: {
  databaseUrl: string;
  actorEnvelopeKey: string;
}): Record<string, string> {
  return {
    RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
    RUDDER_NATIVE_DATABASE_URL: input.databaseUrl,
    RUDDER_NATIVE_DATABASE_REQUIRED: "true",
    RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: input.actorEnvelopeKey,
  };
}

function resolveBinaryPath(configured: string | undefined) {
  const candidate = candidateBinaryPaths(configured).find((value) => {
    try {
      return existsSync(value) && statSync(value).isFile();
    } catch {
      return false;
    }
  });
  return candidate ?? null;
}

function childHasExited(child: RustFoundationChild) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: RustFoundationChild, timeoutMs?: number) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolveExit) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    child.once("exit", onExit);
    child.once("error", onError);
    if (childHasExited(child)) {
      finish(true);
    } else if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(false), timeoutMs);
    }
  });
}

async function stopChild(child: RustFoundationChild, spawnFailed = false) {
  if (spawnFailed || childHasExited(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the state check and the signal.
  }
  if (await waitForChildExit(child, 2_000)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited while the graceful-stop timeout elapsed.
  }
  await waitForChildExit(child);
}

export function createRustFoundationBridge(options: RustFoundationBridgeOptions): RustFoundationBridge {
  const mode = configuredMode(options.mode ?? process.env.RUDDER_RUST_MEMBER_DIRECTORY_MODE);
  let child: RustFoundationChild | null = null;
  let baseUrl: string | null = null;
  let lifecycleState: BridgeLifecycleState = "idle";
  let lifecycleTail: Promise<void> = Promise.resolve();
  let lastStderr = "";
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const start = async (): Promise<void> => {
    lifecycleState = "starting";
    let spawned: RustFoundationChild | null = null;
    let spawnFailed = false;
    try {
      if (!options.databaseUrl.trim()) {
        throw new RustFoundationBridgeError("database_unconfigured", "Rust foundation bridge requires the active database URL");
      }
      const secret = options.actorEnvelopeKey?.trim() || process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY?.trim();
      if (!secret) {
        throw new RustFoundationBridgeError("actor_envelope_unconfigured", "Rust foundation actor envelope key is not configured");
      }
      const binary = resolveBinaryPath(options.binaryPath ?? process.env.RUDDER_SERVER_FOUNDATION_PATH);
      if (!binary) {
        throw new RustFoundationBridgeError("binary_unavailable", "rudder-server-foundation binary is unavailable");
      }

      lastStderr = "";
      const processHandle = spawn(binary, [], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
        env: createFoundationChildEnvironment({
          databaseUrl: options.databaseUrl,
          actorEnvelopeKey: secret,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned = processHandle as RustFoundationChild;
      child = spawned;
      debugBridge(`started pid=${spawned.pid ?? "unknown"}`);
      spawned.once("error", () => {
        spawnFailed = true;
      });
      spawned.stderr.on("data", (chunk: Buffer) => {
        lastStderr = `${lastStderr}${chunk.toString("utf8")}`.slice(-2_000);
      });
      spawned.once("exit", () => {
        if (child === spawned) {
          child = null;
          baseUrl = null;
          if (lifecycleState !== "closing") lifecycleState = "idle";
        }
      });

      const stdout = createInterface({ input: spawned.stdout });
      const startupLine = await new Promise<string>((resolveLine, rejectLine) => {
        const onLine = (line: string) => {
          cleanup();
          resolveLine(line);
        };
        const onError = (error: Error) => {
          cleanup();
          rejectLine(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          rejectLine(new Error(`Rust foundation exited before startup (${code ?? signal ?? "unknown"})`));
        };
        const cleanup = () => {
          stdout.off("line", onLine);
          spawned?.off("error", onError);
          spawned?.off("exit", onExit);
          stdout.close();
        };
        stdout.once("line", onLine);
        processHandle.once("error", onError);
        processHandle.once("exit", onExit);
      }).catch((error) => {
        throw new RustFoundationBridgeError(
          "startup_failed",
          `Rust foundation startup failed${lastStderr ? `: ${lastStderr.trim()}` : ""}`,
          { cause: error },
        );
      });

      let receipt: StartupReceipt;
      try {
        const parsed: unknown = JSON.parse(startupLine);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("startup receipt must be a JSON object");
        }
        receipt = parsed as StartupReceipt;
      } catch (error) {
        throw new RustFoundationBridgeError("startup_failed", "Rust foundation emitted an invalid startup receipt", { cause: error });
      }
      const boundAddr = typeof receipt.boundAddr === "string" ? receipt.boundAddr : null;
      if (!boundAddr || !isLoopbackBoundAddress(boundAddr) || receipt.publicListener === true || receipt.productWriteAuthority === true) {
        throw new RustFoundationBridgeError("startup_failed", "Rust foundation startup receipt violated the private bridge contract");
      }
      baseUrl = `http://${boundAddr}`;
      const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${baseUrl}/readyz`, {
            signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 1_000)),
          });
          if (response.status === 200) {
            lifecycleState = "ready";
            return;
          }
        } catch {
          // The process may need a short interval between binding and readiness.
        }
        await delay(50);
      }
      throw new RustFoundationBridgeError("not_ready", "Rust foundation did not become ready", {
        cause: new Error(lastStderr || "ready probe failed"),
      });
    } catch (error) {
      const startupError = error instanceof RustFoundationBridgeError
        ? error
        : new RustFoundationBridgeError("startup_failed", "Rust foundation startup failed", { cause: error });
      baseUrl = null;
      if (spawned) await stopChild(spawned, spawnFailed);
      if (child === spawned) child = null;
      lifecycleState = "idle";
      throw startupError;
    }
  };

  const enqueueLifecycle = <T>(operation: () => Promise<T>) => {
    const run = lifecycleTail.then(operation, operation);
    lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const ensureStarted = (): Promise<void> => enqueueLifecycle(async () => {
    if (lifecycleState === "ready" && child && baseUrl && !childHasExited(child)) return;
    await start();
  });

  const close = (): Promise<void> => enqueueLifecycle(async () => {
    lifecycleState = "closing";
    const current = child;
    baseUrl = null;
    debugBridge(`close requested pid=${current?.pid ?? "none"}`);
    try {
      if (current) await stopChild(current);
    } finally {
      if (child === current) child = null;
      baseUrl = null;
      lifecycleState = "idle";
      debugBridge(`close completed pid=${current?.pid ?? "none"} exitCode=${current?.exitCode ?? "none"} signal=${current?.signalCode ?? "none"}`);
    }
  });

  return {
    mode,
    start: ensureStarted,
    async memberDirectory(req, orgId) {
      if (mode === "off") {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation member directory bridge is disabled");
      }
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const secret = options.actorEnvelopeKey?.trim() || process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY?.trim();
      if (!secret) throw new RustFoundationBridgeError("actor_envelope_unconfigured", "Rust foundation actor envelope key is not configured");
      const body = Buffer.alloc(0);
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor: req.actor,
        organizationId: orgId,
        method: "GET",
        path: req.originalUrl,
        action: ACTOR_ENVELOPE_ACTION,
        body,
        secret,
        requestId,
      });
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${req.originalUrl}`, {
          method: "GET",
          headers: {
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: Buffer.from(await response.arrayBuffer()),
      } satisfies RustFoundationResponse;
    },
    close,
  };
}
