import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from "express";
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const KIB = 1024;
const DEFAULT_MAX_BODY_BYTES = 256 * KIB;
const MAX_CONFIGURABLE_BODY_BYTES = 2 * 1024 * KIB;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_BUCKETS = 4_096;
const DEFAULT_MAX_PERSISTED_HEADER_BYTES = 4 * KIB;
const DEFAULT_MAX_PERSISTED_HEADER_VALUE_BYTES = KIB;

export const MAX_PLUGIN_WEBHOOK_FAILURE_BYTES = 2 * KIB;

const PERSISTED_WEBHOOK_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-length",
  "content-type",
  "user-agent",
  "webhook-id",
  "webhook-timestamp",
  "x-github-delivery",
  "x-github-event",
  "x-gitlab-event",
  "x-gitlab-event-uuid",
  "x-linear-delivery",
  "x-linear-event",
  "x-request-id",
  "x-shopify-topic",
  "x-shopify-webhook-id",
  "x-slack-request-timestamp",
  "svix-id",
  "svix-timestamp",
]);

export type PluginWebhookIngressOptions = {
  maxBodyBytes: number;
  rateLimitMax: number;
  sourceRateLimitMax: number;
  rateLimitWindowMs: number;
  maxRateLimitBuckets: number;
};

type RateLimitBucket = {
  count: number;
  windowStartedAt: number;
};

type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

export function resolvePluginWebhookIngressOptions(
  env: NodeJS.ProcessEnv = process.env,
): PluginWebhookIngressOptions {
  const rateLimitMax = boundedInteger(
    env.RUDDER_PLUGIN_WEBHOOK_RATE_LIMIT_MAX,
    DEFAULT_RATE_LIMIT_MAX,
    1,
    10_000,
  );
  return {
    maxBodyBytes: boundedInteger(
      env.RUDDER_PLUGIN_WEBHOOK_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
      1,
      MAX_CONFIGURABLE_BODY_BYTES,
    ),
    rateLimitMax,
    sourceRateLimitMax: boundedInteger(
      env.RUDDER_PLUGIN_WEBHOOK_SOURCE_RATE_LIMIT_MAX,
      rateLimitMax * 4,
      rateLimitMax,
      40_000,
    ),
    rateLimitWindowMs: boundedInteger(
      env.RUDDER_PLUGIN_WEBHOOK_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      1_000,
      60 * 60_000,
    ),
    maxRateLimitBuckets: boundedInteger(
      env.RUDDER_PLUGIN_WEBHOOK_RATE_LIMIT_BUCKETS,
      DEFAULT_RATE_LIMIT_BUCKETS,
      64,
      65_536,
    ),
  };
}

class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private nextSweepAt = 0;

  constructor(private readonly maxBuckets: number) {}

  consume(key: string, limit: number, windowMs: number, now: number): RateLimitDecision {
    if (now >= this.nextSweepAt) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (now - bucket.windowStartedAt >= windowMs) {
          this.buckets.delete(bucketKey);
        }
      }
      this.nextSweepAt = now + Math.min(windowMs, 30_000);
    }

    let bucket = this.buckets.get(key);
    if (bucket && now - bucket.windowStartedAt >= windowMs) {
      this.buckets.delete(key);
      bucket = undefined;
    }

    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        // Fail closed instead of evicting a live bucket, which would let an
        // attacker rotate endpoint strings to reset their own quota.
        return { allowed: false, remaining: 0, retryAfterMs: windowMs };
      }
      bucket = { count: 0, windowStartedAt: now };
      this.buckets.set(key, bucket);
    }

    const retryAfterMs = Math.max(1, windowMs - (now - bucket.windowStartedAt));
    if (bucket.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterMs,
    };
  }
}

function hashRateLimitKey(parts: string[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function requestSource(req: Request) {
  // Express derives req.ip from its configured `trust proxy` function. With
  // the safe default (trust proxy disabled), X-Forwarded-For is ignored and
  // the socket peer is used. Deployments may opt into a narrowly trusted proxy
  // without this middleware ever parsing an attacker-controlled XFF directly.
  return req.ip || req.socket.remoteAddress || "unknown";
}

function endpointIdentity(req: Request) {
  const pluginId = typeof req.params.pluginId === "string" ? req.params.pluginId : "";
  const endpointKey = typeof req.params.endpointKey === "string" ? req.params.endpointKey : "";
  return pluginId || endpointKey ? `${pluginId}/${endpointKey}` : req.baseUrl;
}

function isJsonContentType(req: Request) {
  const value = req.headers["content-type"];
  const mediaType = (Array.isArray(value) ? value[0] : value)?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function isPayloadTooLargeError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  return candidate.type === "entity.too.large" || candidate.status === 413 || candidate.statusCode === 413;
}

export function createPluginWebhookIngressMiddleware(
  overrides: Partial<PluginWebhookIngressOptions> = {},
): {
  rateLimit: RequestHandler;
  rawBody: RequestHandler;
  rawBodyError: ErrorRequestHandler;
  decodeBody: RequestHandler;
} {
  const configured = { ...resolvePluginWebhookIngressOptions(), ...overrides };
  const options: PluginWebhookIngressOptions = {
    maxBodyBytes: boundedInteger(configured.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1, MAX_CONFIGURABLE_BODY_BYTES),
    rateLimitMax: boundedInteger(configured.rateLimitMax, DEFAULT_RATE_LIMIT_MAX, 1, 10_000),
    sourceRateLimitMax: boundedInteger(
      configured.sourceRateLimitMax,
      DEFAULT_RATE_LIMIT_MAX * 4,
      1,
      40_000,
    ),
    rateLimitWindowMs: boundedInteger(
      configured.rateLimitWindowMs,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      1,
      60 * 60_000,
    ),
    maxRateLimitBuckets: boundedInteger(
      configured.maxRateLimitBuckets,
      DEFAULT_RATE_LIMIT_BUCKETS,
      1,
      65_536,
    ),
  };
  options.sourceRateLimitMax = Math.max(options.rateLimitMax, options.sourceRateLimitMax);

  const endpointLimiter = new FixedWindowRateLimiter(options.maxRateLimitBuckets);
  const sourceLimiter = new FixedWindowRateLimiter(options.maxRateLimitBuckets);

  const rateLimit: RequestHandler = (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }

    const source = requestSource(req);
    const now = Date.now();
    const sourceDecision = sourceLimiter.consume(
      hashRateLimitKey([source]),
      options.sourceRateLimitMax,
      options.rateLimitWindowMs,
      now,
    );
    const endpointDecision = sourceDecision.allowed
      ? endpointLimiter.consume(
          hashRateLimitKey([endpointIdentity(req), source]),
          options.rateLimitMax,
          options.rateLimitWindowMs,
          now,
        )
      : sourceDecision;
    const decision = sourceDecision.allowed ? endpointDecision : sourceDecision;

    res.setHeader("RateLimit-Limit", String(options.rateLimitMax));
    res.setHeader("RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
      res.status(429).json({ error: "Webhook rate limit exceeded" });
      return;
    }
    next();
  };

  const rawBody = express.raw({
    inflate: true,
    limit: options.maxBodyBytes,
    type: () => true,
  });

  const rawBodyError: ErrorRequestHandler = (err, _req, res, next) => {
    if (isPayloadTooLargeError(err)) {
      res.status(413).json({ error: "Webhook payload too large" });
      return;
    }
    next(err);
  };

  const decodeBody: RequestHandler = (req, res, next) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    (req as unknown as { rawBody: Buffer }).rawBody = body;

    if (!isJsonContentType(req) || body.length === 0) {
      req.body = {};
      next();
      return;
    }

    try {
      req.body = JSON.parse(body.toString("utf8")) as unknown;
      next();
    } catch {
      res.status(400).json({ error: "Invalid JSON webhook payload" });
    }
  };

  return { rateLimit, rawBody, rawBodyError, decodeBody };
}

export function selectPersistedPluginWebhookHeaders(
  headers: IncomingHttpHeaders,
  options?: { maxTotalBytes?: number; maxValueBytes?: number },
) {
  const maxTotalBytes = boundedInteger(
    options?.maxTotalBytes,
    DEFAULT_MAX_PERSISTED_HEADER_BYTES,
    1,
    64 * KIB,
  );
  const maxValueBytes = boundedInteger(
    options?.maxValueBytes,
    DEFAULT_MAX_PERSISTED_HEADER_VALUE_BYTES,
    1,
    16 * KIB,
  );
  const selected: Record<string, string> = {};
  let totalBytes = 0;

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!PERSISTED_WEBHOOK_HEADER_ALLOWLIST.has(name)) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (typeof value !== "string") continue;

    const valueBytes = Buffer.byteLength(value, "utf8");
    const entryBytes = Buffer.byteLength(name, "utf8") + valueBytes;
    if (valueBytes > maxValueBytes || totalBytes + entryBytes > maxTotalBytes) continue;
    selected[name] = value;
    totalBytes += entryBytes;
  }

  return selected;
}

export function boundedPluginWebhookFailureMessage(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err);
  const normalized = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  const encoded = Buffer.from(normalized, "utf8");
  if (encoded.length <= MAX_PLUGIN_WEBHOOK_FAILURE_BYTES) return normalized;

  const suffix = "...";
  const maxPrefixBytes = MAX_PLUGIN_WEBHOOK_FAILURE_BYTES - Buffer.byteLength(suffix);
  let prefix = encoded.subarray(0, maxPrefixBytes).toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") > maxPrefixBytes) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${suffix}`;
}
