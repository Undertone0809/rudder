import {
  deriveProductAnalyticsSubject,
  hashOpaqueSecret,
  issueOfflineGrant,
  issueProductAnalyticsAssertion,
  normalizeVerifiedEmail,
  opaqueSecretMatches,
} from "@rudderhq/identity-core";
import {
  approveDeviceAuthorization,
  assertIdentityProductAnalyticsConsent,
  beginCredentialRevocationIntent,
  beginSupabaseAuthMigration,
  bindSupabaseAuthUser,
  completeCredentialRevocationIntent,
  consumeIdentityEmailRateLimit,
  consumeIdentityOperationRateLimit,
  consumeServerExchangeCode,
  denyDeviceAuthorization,
  getSupabaseAuthUserBinding,
  issueDesktopAuthorizationCode,
  issueDeviceAuthorization,
  issueServerExchangeCode,
  listIdentityDevices,
  markCredentialProviderMutationComplete,
  markCredentialRevocationFailed,
  recordIdentityProductAnalyticsConsent,
  recordSecurityEvent,
  recordSupabaseAuthUserCreated,
  recoverCredentialRevocationIntents,
  redeemApprovedDeviceAuthorization,
  redeemDesktopAuthorizationCode,
  resolveDeviceAccessToken,
  resolveVerifiedIdentity,
  revokeAllIdentityDevices,
  revokeIdentityDevice,
  rotateDeviceRefreshToken,
  verifyDeviceAuthorization,
} from "@rudderhq/identity-db";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { identityClientScript } from "./client-script.js";
import {
  createDesktopSignInIntent,
  type DesktopSignInMethod,
  resolveDesktopSignInIntent,
} from "./desktop-sign-in-intent.js";
import {
  accountPage,
  deviceApprovalPage,
  homePage,
  passwordRecoveryPage,
  privacyPage,
  termsPage,
} from "./pages.js";
import {
  RootIdentityError,
  type RootIdentityPrincipal,
  type RootIdentityRequestContext,
} from "./root-identity-adapter.js";
import { getIdentityRuntime } from "./runtime.js";
import { syncProductAnalyticsConsent } from "./telemetry-sync.js";

const credentialRecoveryWorkerId = `identity-${randomUUID()}`;

class TelemetryConsentSyncUnavailableError extends Error {
  constructor() {
    super("telemetry_consent_sync_unavailable");
    this.name = "TelemetryConsentSyncUnavailableError";
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function sendHtml(res: ServerResponse, value: string, options?: { sensitive?: boolean }): void {
  res.statusCode = 200;
  if (options?.sensitive) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("pragma", "no-cache");
  }
  res.setHeader("content-security-policy", "default-src 'none'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(value);
}

function nodeHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (Array.isArray(rawValue)) rawValue.forEach((value) => headers.append(name, value));
    else if (rawValue !== undefined) headers.set(name, rawValue);
  }
  return headers;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    domain?: string;
    expires?: Date;
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: boolean | "lax" | "strict" | "none";
    secure?: boolean;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    const sameSite = options.sameSite === true ? "Strict" : (
      options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1)
    );
    parts.push(`SameSite=${sameSite}`);
  }
  return parts.join("; ");
}

function rootIdentityContext(
  req: IncomingMessage,
  res: ServerResponse,
): RootIdentityRequestContext {
  return {
    requestHeaders: nodeHeaders(req),
    setCookies(cookies, responseHeaders) {
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (name.toLowerCase() !== "set-cookie") res.setHeader(name, value);
      }
      const existing = res.getHeader("set-cookie");
      const values = Array.isArray(existing)
        ? existing.map(String)
        : existing === undefined
          ? []
          : [String(existing)];
      values.push(
        ...cookies.map(({ name, value, options }) =>
          serializeCookie(name, value, options)
        ),
      );
      if (values.length > 0) res.setHeader("set-cookie", values);
    },
  };
}

function nativeDesktopRootIdentityContext(req: IncomingMessage): RootIdentityRequestContext {
  return {
    requestHeaders: nodeHeaders(req),
    // Supabase may emit a web session while verifying credentials. Native
    // Desktop auth deliberately discards it and returns only a Rudder-owned,
    // single-use PKCE authorization code.
    setCookies() {},
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 32_768) throw new Error("request_too_large");
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_request");
  return parsed as Record<string, unknown>;
}

function browserMutationError(
  req: IncomingMessage,
  allowedOrigins: readonly string[],
  options: { requireJson: boolean },
): "invalid_content_type" | "invalid_origin" | "invalid_fetch_metadata" | null {
  if (options.requireJson) {
    const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return "invalid_content_type";
  }
  const origin = req.headers.origin;
  if (
    typeof origin !== "string" ||
    !allowedOrigins.includes(origin)
  ) {
    return "invalid_origin";
  }
  if (
    req.headers["sec-fetch-site"] !== "same-origin" ||
    req.headers["sec-fetch-mode"] !== "cors"
  ) {
    return "invalid_fetch_metadata";
  }
  return null;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid_request");
  return value;
}

function nonNegativeIntegerField(
  body: Record<string, unknown>,
  key: string,
): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("invalid_request");
  }
  return Number(value);
}

function securityRequestMetadata(
  req: IncomingMessage,
  secret: string,
): { ipAddress: string | null; ipHashKey: string; userAgent: string | null } {
  const forwardedFor = req.headers["x-forwarded-for"];
  return {
    ipAddress:
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(",")[0]?.trim() ??
      (Array.isArray(req.headers["x-real-ip"]) ? req.headers["x-real-ip"][0] : req.headers["x-real-ip"]) ??
      null,
    ipHashKey: secret,
    userAgent: req.headers["user-agent"] ?? null,
  };
}

type NativeAuthOperation =
  | "email_otp.send"
  | "email_otp.verify"
  | "password.sign_in"
  | "password.reset.request"
  | "password.reset.confirm";

type NativeAuthFailureReason =
  | "invalid_code"
  | "invalid_credentials"
  | "invalid_request"
  | "provider_unavailable"
  | "rate_limited";

async function recordNativeAuthSecurityEvent(
  runtime: ReturnType<typeof getIdentityRuntime>,
  req: IncomingMessage,
  operation: NativeAuthOperation,
  outcome: "succeeded" | "failed" | "limited",
  input: {
    clientId?: string;
    reason?: NativeAuthFailureReason;
    userId?: string;
  } = {},
): Promise<void> {
  const metadata: Record<string, string> = {};
  if (input.clientId) metadata.clientId = input.clientId;
  if (input.reason) metadata.reason = input.reason;
  await recordSecurityEvent(runtime.db, {
    userId: input.userId,
    eventType: `desktop.native_auth.${operation}.${outcome}`,
    ...securityRequestMetadata(req, runtime.config.secret),
    metadata,
  });
}

async function consumeNativeAuthRateLimits(
  runtime: ReturnType<typeof getIdentityRuntime>,
  req: IncomingMessage,
  input: {
    email: string;
    operation: NativeAuthOperation;
    sendAction?: "otp-send" | "password-reset";
  },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const email = normalizeVerifiedEmail(input.email);
  const requestMetadata = securityRequestMetadata(req, runtime.config.secret);
  const retryAfterSeconds: number[] = [];

  if (input.sendAction) {
    const emailLimit = await consumeIdentityEmailRateLimit(runtime.db, {
      email,
      action: input.sendAction,
      maxAttempts: 3,
      windowSeconds: 10 * 60,
      blockSeconds: 15 * 60,
    });
    if (!emailLimit.allowed) retryAfterSeconds.push(emailLimit.retryAfterSeconds);
  }

  const sendOperation = Boolean(input.sendAction);
  const accountLimit = await consumeIdentityOperationRateLimit(runtime.db, {
    key: `native-auth:${input.operation}:account:${hashOpaqueSecret(
      `${runtime.config.secret}:${email}`,
    )}`,
    limit: sendOperation ? 6 : 10,
    windowMs: 10 * 60 * 1_000,
  });
  if (!accountLimit.allowed) {
    retryAfterSeconds.push(Math.ceil(accountLimit.retryAfterMs / 1_000));
  }

  const ipLimit = await consumeIdentityOperationRateLimit(runtime.db, {
    key: `native-auth:${input.operation}:ip:${hashOpaqueSecret(
      `${requestMetadata.ipHashKey}:${requestMetadata.ipAddress ?? "unknown"}`,
    )}`,
    limit: sendOperation ? 20 : 30,
    windowMs: sendOperation ? 60 * 60 * 1_000 : 10 * 60 * 1_000,
  });
  if (!ipLimit.allowed) retryAfterSeconds.push(Math.ceil(ipLimit.retryAfterMs / 1_000));

  if (retryAfterSeconds.length === 0) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(...retryAfterSeconds, 1) };
}

function nativeAuthFailureReason(
  operation: NativeAuthOperation,
  error: unknown,
): NativeAuthFailureReason {
  if (!(error instanceof RootIdentityError)) return "invalid_request";
  if (error.status === 429) return "rate_limited";
  if (error.status >= 500 || error.status <= 0) return "provider_unavailable";
  if (operation === "password.sign_in") return "invalid_credentials";
  if (operation === "email_otp.verify" || operation === "password.reset.confirm") {
    return "invalid_code";
  }
  return "invalid_request";
}

function isMissingPasswordResetAccount(error: RootIdentityError): boolean {
  return new Set([
    "email_not_found",
    "identity_not_found",
    "user_not_found",
  ]).has(error.code);
}

function isUnavailableRootIdentityError(error: RootIdentityError): boolean {
  return (
    error.status >= 500 ||
    error.status <= 0 ||
    new Set([
      "bad_json",
      "configuration_error",
      "email_provider_disabled",
      "fetch_error",
      "hook_timeout",
      "hook_timeout_after_retry",
      "identity_provider_error",
      "identity_provider_unavailable",
      "network_error",
      "provider_disabled",
      "request_timeout",
      "unexpected_failure",
    ]).has(error.code)
  );
}

async function enforceNativeAuthRateLimits(
  runtime: ReturnType<typeof getIdentityRuntime>,
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    clientId: string;
    email: string;
    operation: NativeAuthOperation;
    sendAction?: "otp-send" | "password-reset";
  },
): Promise<boolean> {
  try {
    const result = await consumeNativeAuthRateLimits(runtime, req, input);
    if (result.allowed) return true;
    res.setHeader("retry-after", result.retryAfterSeconds);
    await recordNativeAuthSecurityEvent(runtime, req, input.operation, "limited", {
      clientId: input.clientId,
      reason: "rate_limited",
    }).catch(() => undefined);
    sendJson(res, 429, { error: "rate_limited" });
    return false;
  } catch (error) {
    const invalidEmail = error instanceof Error && error.message === "Invalid verified email";
    await recordNativeAuthSecurityEvent(runtime, req, input.operation, "failed", {
      clientId: input.clientId,
      reason: invalidEmail ? "invalid_request" : "provider_unavailable",
    }).catch(() => undefined);
    if (invalidEmail) {
      sendJson(res, 400, { error: "invalid_request" });
      return false;
    }
    sendJson(res, 503, {
      error: "authentication_temporarily_unavailable",
      retryable: true,
    });
    return false;
  }
}

function sendNativeAuthProviderError(res: ServerResponse, error: RootIdentityError): void {
  if (error.status === 429) {
    res.setHeader("retry-after", 60);
    sendJson(res, 429, { error: "rate_limited" });
    return;
  }
  if (isUnavailableRootIdentityError(error)) {
    sendJson(res, 503, {
      error: "authentication_temporarily_unavailable",
      retryable: true,
    });
    return;
  }
  sendRootIdentityError(res, error);
}

function validLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function safeContinuation(value: string | null, fallback = "/"): string {
  if (!value) return fallback;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/u.test(value)
  ) return fallback;
  const parsed = new URL(value, "https://rudder.invalid");
  if (
    parsed.origin !== "https://rudder.invalid" ||
    parsed.hash ||
    !new Set(["/", "/account", "/device", "/api/desktop/authorize"]).has(parsed.pathname)
  ) return fallback;
  return `${parsed.pathname}${parsed.search}`;
}

function sendRootIdentityError(res: ServerResponse, error: unknown): void {
  if (error instanceof RootIdentityError) {
    sendJson(res, error.status, { error: error.code, message: error.message });
    return;
  }
  throw error;
}

function sendCredentialMutationError(res: ServerResponse, error: unknown): void {
  if (error instanceof RootIdentityError) {
    sendRootIdentityError(res, error);
    return;
  }
  if (
    error instanceof Error &&
    (error.message === "credential_revocation_pending" ||
      error.message === "credential_revocation_manual_repair_required")
  ) {
    sendJson(res, 503, {
      error: error.message,
      retryable: error.message === "credential_revocation_pending",
    });
    return;
  }
  sendJson(res, 400, { error: "invalid_request" });
}

async function bindRootPrincipal(
  runtime: ReturnType<typeof getIdentityRuntime>,
  principal: RootIdentityPrincipal,
): Promise<{ userId: string; deviceId: null }> {
  const existing = await getSupabaseAuthUserBinding(runtime.db, principal.id);
  if (existing) {
    if (existing.normalizedEmail !== principal.email) {
      throw new RootIdentityError({
        code: "identity_binding_conflict",
        message: "The authenticated identity does not match its Rudder Account binding",
        status: 409,
      });
    }
    return { userId: existing.rudderUserId, deviceId: null };
  }

  // New Supabase users and a pre-cutover legacy user both resolve through the
  // same verified-email lock. This preserves the stable Rudder subject while
  // refusing duplicate accounts for the same verified address.
  const resolved = await resolveVerifiedIdentity(runtime.db, {
    provider: "email",
    providerSubject: principal.id,
    email: principal.email,
    emailVerified: true,
    name: principal.displayName,
    image: principal.avatarUrl,
  });
  const migrationIdentity = {
    migrationBatch: "live-supabase-root",
    rudderUserId: resolved.userId,
    email: principal.email,
    authUserId: principal.id,
  };
  await beginSupabaseAuthMigration(runtime.db, migrationIdentity);
  await recordSupabaseAuthUserCreated(runtime.db, migrationIdentity);
  await bindSupabaseAuthUser(runtime.db, migrationIdentity);
  return { userId: resolved.userId, deviceId: null };
}

async function resolveWebPrincipal(
  runtime: ReturnType<typeof getIdentityRuntime>,
  req: IncomingMessage,
  res: ServerResponse,
  options?: { requireActiveSession?: boolean },
): Promise<({ userId: string; deviceId: null } & { root: RootIdentityPrincipal }) | null> {
  const context = rootIdentityContext(req, res);
  const principal = options?.requireActiveSession
    ? await runtime.rootIdentity.requireActivePrincipal(context)
    : await runtime.rootIdentity.getPrincipal(context);
  if (!principal) return null;
  return { ...(await bindRootPrincipal(runtime, principal)), root: principal };
}

async function resolveAccountPrincipal(
  runtime: ReturnType<typeof getIdentityRuntime>,
  req: IncomingMessage,
  res: ServerResponse,
  options?: { requireActiveWebSession?: boolean },
): Promise<{ userId: string; deviceId: string | null } | null> {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const access = await resolveDeviceAccessToken(runtime.db, authorization.slice("Bearer ".length));
    if (access) return access;
  }
  return resolveWebPrincipal(runtime, req, res, {
    requireActiveSession: options?.requireActiveWebSession,
  });
}

async function finishPasswordSecurityMutation(
  runtime: ReturnType<typeof getIdentityRuntime>,
  req: IncomingMessage,
  intentId: string,
  userId: string,
  eventType: "password.reset" | "password.changed" | "session.global_signout",
  deviceScope: "none" | "all",
): Promise<
  | {
      intentCompleted: true;
      desktopSessionsRevoked: boolean;
      localServerSessionStatus: "expires-or-syncs";
    }
  | {
      intentCompleted: false;
      desktopSessionsRevoked: false;
      localServerSessionStatus: "expires-or-syncs";
    }
> {
  try {
    if (deviceScope === "all") {
      await revokeAllIdentityDevices(runtime.db, {
        userId,
        reason:
          eventType === "password.reset"
            ? "password-reset"
            : eventType === "password.changed"
              ? "password-change"
              : "account-revoked",
      });
    }
    await completeCredentialRevocationIntent(runtime.db, intentId);
  } catch (error) {
    try {
      await markCredentialRevocationFailed(runtime.db, {
        intentId,
        stage: "rudder",
        error: error instanceof Error ? error.message : "unknown_error",
      });
      await recordSecurityEvent(runtime.db, {
        userId,
        eventType: `${eventType}.rudder_revocation_pending`,
        ...securityRequestMetadata(req, runtime.config.secret),
        metadata: {
          browserSessionsRevoked: true,
          desktopSessionsRevoked: false,
          localServerSessionStatus: "expires-or-syncs",
          retryRequired: true,
        },
      });
    } catch {
      // Preserve the fail-closed response even if the audit sink is impaired.
    }
    return {
      intentCompleted: false,
      desktopSessionsRevoked: false,
      localServerSessionStatus: "expires-or-syncs",
    };
  }
  await recordSecurityEvent(runtime.db, {
    userId,
    eventType,
    ...securityRequestMetadata(req, runtime.config.secret),
    metadata: {
      browserSessionsRevoked: eventType !== "password.changed" || deviceScope === "all",
      desktopSessionsRevoked: deviceScope === "all",
      localServerSessionStatus: "expires-or-syncs",
    },
  }).catch(() => undefined);
  return {
    intentCompleted: true,
    desktopSessionsRevoked: deviceScope === "all",
    localServerSessionStatus: "expires-or-syncs",
  };
}

function sendDeviceTokens(
  res: ServerResponse,
  result: Awaited<ReturnType<typeof redeemDesktopAuthorizationCode>>,
  runtime: ReturnType<typeof getIdentityRuntime>,
  localSignOutEpoch: number,
): void {
  const nowMs = Date.now();
  const signing = runtime.offlineGrantSigning;
  const offlineGrant = signing && result.device.publicKeyThumbprint
    ? issueOfflineGrant({
        signingPrivateKey: signing.privateKey,
        keyId: signing.keyId,
        issuer: runtime.config.baseUrl,
        accountId: result.account.id,
        deviceId: result.device.id,
        installationId: result.device.installationId,
        publicKeyThumbprint: result.device.publicKeyThumbprint,
        nowMs,
        trustedTimeMs: nowMs,
        localSignOutEpoch,
        authSchemaEpoch: result.offlineGrantState.authSchemaEpoch,
        accountAuthEpoch: result.offlineGrantState.accountAuthEpoch,
        deviceAuthEpoch: result.offlineGrantState.deviceAuthEpoch,
        jti: randomUUID(),
      })
    : null;
  sendJson(res, 200, {
    access_token: result.accessToken,
    token_type: "Bearer",
    expires_in: result.expiresIn,
    refresh_token: result.refreshToken,
    account: result.account,
    device: result.device,
    ...(offlineGrant ? {
      offline_grant: offlineGrant,
      offline_grant_expires_at: new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
      offline_grant_key_id: signing!.keyId,
    } : {}),
  });
}

export async function identityHandler(
  req: IncomingMessage,
  res: ServerResponse,
  options?: {
    backgroundTaskHandler?: (promise: Promise<unknown>) => void;
    rootIdentityAdapter?: import("./root-identity-adapter.js").RootIdentityAdapter;
  },
): Promise<void> {
  const publicBaseUrl = process.env.IDENTITY_BASE_URL ?? "http://127.0.0.1";
  const url = new URL(req.url ?? "/", publicBaseUrl);

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, homePage({
      google: Boolean(
        process.env.IDENTITY_GOOGLE_CLIENT_ID?.trim()
        && process.env.IDENTITY_GOOGLE_CLIENT_SECRET?.trim(),
      ),
      github: Boolean(
        process.env.IDENTITY_GITHUB_CLIENT_ID?.trim()
        && process.env.IDENTITY_GITHUB_CLIENT_SECRET?.trim(),
      ),
    }), { sensitive: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/identity.js") {
    res.statusCode = 200;
    res.setHeader("cache-control", "public, max-age=300");
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(identityClientScript);
    return;
  }
  if (req.method === "GET" && url.pathname === "/rudder-logo.png") {
    res.statusCode = 200;
    res.setHeader("cache-control", "public, max-age=86400, immutable");
    res.setHeader("content-type", "image/png");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(await readFile(path.join(process.cwd(), "public", "rudder-logo.png")));
    return;
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.statusCode = 200;
    res.setHeader("cache-control", "public, max-age=86400, immutable");
    res.setHeader("content-type", "image/x-icon");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(await readFile(path.join(process.cwd(), "public", "favicon.ico")));
    return;
  }
  if (req.method === "GET" && url.pathname === "/privacy") {
    sendHtml(res, privacyPage(process.env.IDENTITY_SUPPORT_EMAIL ?? "support@rudderhq.dev"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/terms") {
    sendHtml(res, termsPage(process.env.IDENTITY_SUPPORT_EMAIL ?? "support@rudderhq.dev"));
    return;
  }

  // Static legal and bootstrap pages above intentionally remain deployable
  // before production OAuth and database credentials exist.
  const runtime = getIdentityRuntime(options);
  const validateNativeDesktopAuthorization = (body: Record<string, unknown>): void => {
    const clientId = stringField(body, "client_id");
    const redirectUri = stringField(body, "redirect_uri");
    const codeChallenge = stringField(body, "code_challenge");
    const codeChallengeMethod = stringField(body, "code_challenge_method");
    const audience = stringField(body, "audience");
    if (
      !runtime.config.deviceClientIds.has(clientId)
      || !validLoopbackRedirect(redirectUri)
      || codeChallengeMethod !== "S256"
      || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)
      || audience.length < 1
      || audience.length > 256
    ) throw new Error("invalid_request");
  };
  const issueNativeDesktopCode = async (
    body: Record<string, unknown>,
    principal: RootIdentityPrincipal,
  ): Promise<string> => {
    validateNativeDesktopAuthorization(body);
    const clientId = stringField(body, "client_id");
    const redirectUri = stringField(body, "redirect_uri");
    const codeChallenge = stringField(body, "code_challenge");
    const audience = stringField(body, "audience");
    const binding = await bindRootPrincipal(runtime, principal);
    const authorization = await issueDesktopAuthorizationCode(runtime.db, {
      userId: binding.userId,
      clientId,
      redirectUri,
      codeChallenge,
      audience,
    });
    return authorization.code;
  };
  const recovery = recoverCredentialRevocationIntents(runtime.db, {
    claimOwner: credentialRecoveryWorkerId,
    maxClaims: 1,
    revokeRudderCredentials: async (intent) => {
      if (intent.deviceScope === "all") {
        await revokeAllIdentityDevices(runtime.db, {
          userId: intent.userId,
          reason:
            intent.operation === "password-reset"
              ? "password-reset"
              : intent.operation === "password-change"
                ? "password-change"
                : "account-revoked",
        });
      }
    },
  }).catch(() => undefined);
  if (options?.backgroundTaskHandler) {
    options.backgroundTaskHandler(recovery);
  } else {
    // Node and local runtimes have no platform waitUntil hook. Recover one
    // durable intent inline so normal traffic always makes forward progress.
    await recovery;
  }

  const rootAuthJsonMutation =
    req.method === "POST" && url.pathname.startsWith("/api/root-auth/");
  const cookieDeviceDecision =
    req.method === "POST" &&
    (url.pathname === "/api/desktop/device-code/approve" ||
      url.pathname === "/api/desktop/device-code/deny");
  if (rootAuthJsonMutation || cookieDeviceDecision) {
    const browserError = browserMutationError(req, runtime.config.allowedOrigins, {
      requireJson: true,
    });
    if (browserError) {
      sendJson(res, 403, { error: browserError });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/sign-in-intent") {
    try {
      const body = await readJson(req);
      const clientId = stringField(body, "client_id");
      const codeChallenge = stringField(body, "code_challenge");
      const redirectUri = stringField(body, "redirect_uri");
      const state = stringField(body, "state");
      const method = stringField(body, "method") as DesktopSignInMethod;
      const email = typeof body.email === "string" ? body.email : undefined;
      if (
        !runtime.config.deviceClientIds.has(clientId)
        || !validLoopbackRedirect(redirectUri)
      ) {
        throw new Error("invalid_request");
      }
      const intent = createDesktopSignInIntent({
        clientId,
        codeChallenge,
        email,
        method,
        redirectUri,
        secret: runtime.config.secret,
        state,
      });
      sendJson(res, 200, { intent, expires_in: 300 });
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/sign-in-intent/resolve") {
    try {
      const body = await readJson(req);
      const clientId = stringField(body, "client_id");
      const redirectUri = stringField(body, "redirect_uri");
      if (
        !runtime.config.deviceClientIds.has(clientId)
        || !validLoopbackRedirect(redirectUri)
      ) {
        throw new Error("invalid_request");
      }
      sendJson(res, 200, resolveDesktopSignInIntent({
        clientId,
        codeChallenge: stringField(body, "code_challenge"),
        intent: stringField(body, "intent"),
        redirectUri,
        secret: runtime.config.secret,
        state: stringField(body, "state"),
      }));
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/native-auth/email-otp/send") {
    const operation = "email_otp.send" as const;
    let clientId: string | undefined;
    try {
      const body = await readJson(req);
      const requestedClientId = stringField(body, "client_id");
      if (!runtime.config.deviceClientIds.has(requestedClientId)) {
        throw new Error("invalid_request");
      }
      clientId = requestedClientId;
      const email = stringField(body, "email");
      if (!await enforceNativeAuthRateLimits(runtime, req, res, {
        clientId,
        email,
        operation,
        sendAction: "otp-send",
      })) return;
      await runtime.rootIdentity.sendEmailOtp(nativeDesktopRootIdentityContext(req), {
        email,
      });
      await recordNativeAuthSecurityEvent(runtime, req, operation, "succeeded", {
        clientId,
      }).catch(() => undefined);
      sendJson(res, 200, { success: true });
    } catch (error) {
      const reason = nativeAuthFailureReason(operation, error);
      await recordNativeAuthSecurityEvent(
        runtime,
        req,
        operation,
        reason === "rate_limited" ? "limited" : "failed",
        { clientId, reason },
      ).catch(() => undefined);
      if (error instanceof RootIdentityError) sendNativeAuthProviderError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/native-auth/email-otp/verify") {
    const operation = "email_otp.verify" as const;
    let clientId: string | undefined;
    try {
      const body = await readJson(req);
      validateNativeDesktopAuthorization(body);
      clientId = stringField(body, "client_id");
      const email = stringField(body, "email");
      if (!await enforceNativeAuthRateLimits(runtime, req, res, {
        clientId,
        email,
        operation,
      })) return;
      const principal = await runtime.rootIdentity.verifyEmailOtp(
        nativeDesktopRootIdentityContext(req),
        {
          email,
          token: stringField(body, "token"),
          purpose: "sign-in",
        },
      );
      const binding = await bindRootPrincipal(runtime, principal);
      const code = await issueNativeDesktopCode(body, principal);
      await recordNativeAuthSecurityEvent(
        runtime,
        req,
        operation,
        "succeeded",
        { clientId, userId: binding.userId },
      ).catch(() => undefined);
      sendJson(res, 200, { code });
    } catch (error) {
      const reason = nativeAuthFailureReason(operation, error);
      await recordNativeAuthSecurityEvent(
        runtime,
        req,
        operation,
        reason === "rate_limited" ? "limited" : "failed",
        { clientId, reason },
      ).catch(() => undefined);
      if (error instanceof RootIdentityError) sendNativeAuthProviderError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/native-auth/password/sign-in") {
    const operation = "password.sign_in" as const;
    let clientId: string | undefined;
    try {
      const body = await readJson(req);
      validateNativeDesktopAuthorization(body);
      clientId = stringField(body, "client_id");
      const email = stringField(body, "email");
      if (!await enforceNativeAuthRateLimits(runtime, req, res, {
        clientId,
        email,
        operation,
      })) return;
      const principal = await runtime.rootIdentity.signInWithPassword(
        nativeDesktopRootIdentityContext(req),
        {
          email,
          password: stringField(body, "password"),
        },
      );
      const binding = await bindRootPrincipal(runtime, principal);
      const code = await issueNativeDesktopCode(body, principal);
      await recordNativeAuthSecurityEvent(
        runtime,
        req,
        operation,
        "succeeded",
        { clientId, userId: binding.userId },
      ).catch(() => undefined);
      sendJson(res, 200, { code });
    } catch (error) {
      const reason = nativeAuthFailureReason(operation, error);
      await recordNativeAuthSecurityEvent(
        runtime,
        req,
        operation,
        reason === "rate_limited" ? "limited" : "failed",
        { clientId, reason },
      ).catch(() => undefined);
      if (error instanceof RootIdentityError) sendNativeAuthProviderError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/native-auth/password/reset/request") {
    const operation = "password.reset.request" as const;
    let clientId: string | undefined;
    let providerInvoked = false;
    try {
      const body = await readJson(req);
      const requestedClientId = stringField(body, "client_id");
      if (!runtime.config.deviceClientIds.has(requestedClientId)) {
        throw new Error("invalid_request");
      }
      clientId = requestedClientId;
      const email = stringField(body, "email");
      if (!await enforceNativeAuthRateLimits(runtime, req, res, {
        clientId,
        email,
        operation,
        sendAction: "password-reset",
      })) return;
      providerInvoked = true;
      await runtime.rootIdentity.requestPasswordReset(nativeDesktopRootIdentityContext(req), {
        email,
      });
      await recordNativeAuthSecurityEvent(runtime, req, operation, "succeeded", {
        clientId,
      }).catch(() => undefined);
    } catch (error) {
      if (error instanceof RootIdentityError && isMissingPasswordResetAccount(error)) {
        // Explicit missing-account errors stay indistinguishable from a sent
        // message, while operational provider failures remain actionable.
        await recordNativeAuthSecurityEvent(runtime, req, operation, "succeeded", {
          clientId,
        }).catch(() => undefined);
      } else if (error instanceof RootIdentityError && error.status === 429) {
        await recordNativeAuthSecurityEvent(runtime, req, operation, "limited", {
          clientId,
          reason: "rate_limited",
        }).catch(() => undefined);
        res.setHeader("retry-after", 60);
        sendJson(res, 429, { error: "rate_limited" });
        return;
      } else if (
        (error instanceof RootIdentityError && isUnavailableRootIdentityError(error)) ||
        (providerInvoked && !(error instanceof RootIdentityError))
      ) {
        await recordNativeAuthSecurityEvent(runtime, req, operation, "failed", {
          clientId,
          reason: "provider_unavailable",
        }).catch(() => undefined);
        sendJson(res, 503, {
          error: "password_reset_temporarily_unavailable",
          retryable: true,
        });
        return;
      } else if (error instanceof RootIdentityError) {
        await recordNativeAuthSecurityEvent(runtime, req, operation, "failed", {
          clientId,
          reason: "invalid_request",
        }).catch(() => undefined);
        sendJson(res, 400, { error: "password_reset_request_failed" });
        return;
      } else {
        await recordNativeAuthSecurityEvent(runtime, req, operation, "failed", {
          clientId,
          reason: "invalid_request",
        }).catch(() => undefined);
        sendJson(res, 400, { error: "invalid_request" });
        return;
      }
    }
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/native-auth/password/reset/confirm") {
    const operation = "password.reset.confirm" as const;
    let clientId: string | undefined;
    let intent:
      | Awaited<ReturnType<typeof beginCredentialRevocationIntent>>
      | undefined;
    try {
      const body = await readJson(req);
      validateNativeDesktopAuthorization(body);
      clientId = stringField(body, "client_id");
      const email = stringField(body, "email");
      if (!await enforceNativeAuthRateLimits(runtime, req, res, {
        clientId,
        email,
        operation,
      })) return;
      const principal = await runtime.rootIdentity.resetPasswordWithOtp(
        nativeDesktopRootIdentityContext(req),
        {
          email,
          token: stringField(body, "token"),
          newPassword: stringField(body, "newPassword"),
        },
        async (verifiedPrincipal) => {
          const binding = await bindRootPrincipal(runtime, verifiedPrincipal);
          intent = await beginCredentialRevocationIntent(runtime.db, {
            userId: binding.userId,
            rootIdentityUserId: verifiedPrincipal.id,
            operation: "password-reset",
            deviceScope: "all",
          });
        },
      );
      const binding = await bindRootPrincipal(runtime, principal);
      if (!intent) throw new Error("credential_revocation_intent_missing");
      await markCredentialProviderMutationComplete(runtime.db, intent.id);
      const result = await finishPasswordSecurityMutation(
        runtime,
        req,
        intent.id,
        binding.userId,
        "password.reset",
        "all",
      );
      if (!result.intentCompleted) {
        await recordNativeAuthSecurityEvent(runtime, req, operation, "failed", {
          clientId,
          reason: "provider_unavailable",
          userId: binding.userId,
        }).catch(() => undefined);
        sendJson(res, 503, {
          error: "rudder_credential_revocation_pending",
          passwordUpdated: true,
        });
        return;
      }
      intent = undefined;
      const code = await issueNativeDesktopCode(body, principal);
      await recordNativeAuthSecurityEvent(
        runtime,
        req,
        operation,
        "succeeded",
        { clientId, userId: binding.userId },
      ).catch(() => undefined);
      sendJson(res, 200, { code });
    } catch (error) {
      if (intent) {
        await markCredentialRevocationFailed(runtime.db, {
          intentId: intent.id,
          stage: "provider",
          error: error instanceof Error ? error.message : "unknown_error",
        }).catch(() => undefined);
      }
      const reason = nativeAuthFailureReason(operation, error);
      await recordNativeAuthSecurityEvent(
        runtime,
        req,
        operation,
        reason === "rate_limited" ? "limited" : "failed",
        { clientId, reason },
      ).catch(() => undefined);
      if (error instanceof RootIdentityError) sendNativeAuthProviderError(res, error);
      else sendCredentialMutationError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/oauth") {
    try {
      const body = await readJson(req);
      const provider = stringField(body, "provider");
      if (provider !== "google" && provider !== "github") throw new Error("invalid_request");
      if (!runtime.config[provider]) {
        throw new RootIdentityError({
          code: "provider_unavailable",
          message: `${provider} sign-in is not configured for this Identity service`,
          status: 404,
        });
      }
      const nextPath = typeof body.nextPath === "string" ? body.nextPath : undefined;
      const result = await runtime.rootIdentity.beginOAuth(
        rootIdentityContext(req, res),
        { provider, nextPath },
      );
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof RootIdentityError) sendRootIdentityError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    const code = url.searchParams.get("code");
    if (!code) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    try {
      const fixtureProvider = code === "fixture-google"
        ? "google"
        : code === "fixture-github"
          ? "github"
          : null;
      if (fixtureProvider && !runtime.config[fixtureProvider]) {
        throw new RootIdentityError({
          code: "provider_unavailable",
          message: `${fixtureProvider} sign-in is not configured for this Identity service`,
          status: 404,
        });
      }
      const principal = await runtime.rootIdentity.completePkceCallback(
        rootIdentityContext(req, res),
        { code, flowId: url.searchParams.get("sb_flow_id") ?? undefined },
      );
      await bindRootPrincipal(runtime, principal);
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", safeContinuation(url.searchParams.get("next")));
      res.end();
    } catch (error) {
      sendRootIdentityError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/reset-password") {
    const code = url.searchParams.get("code") ?? undefined;
    const tokenHash = url.searchParams.get("token_hash") ?? undefined;
    const type = url.searchParams.get("type");
    if (type && type !== "recovery") {
      sendJson(res, 400, { error: "invalid_recovery_link" });
      return;
    }
    try {
      const principal = await runtime.rootIdentity.completePasswordRecovery(
        rootIdentityContext(req, res),
        { code, tokenHash },
      );
      await bindRootPrincipal(runtime, principal);
      sendHtml(res, passwordRecoveryPage(principal.email), { sensitive: true });
    } catch (error) {
      sendRootIdentityError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/email-otp/send") {
    try {
      const body = await readJson(req);
      await runtime.rootIdentity.sendEmailOtp(rootIdentityContext(req, res), {
        email: stringField(body, "email"),
        nextPath: typeof body.nextPath === "string" ? body.nextPath : undefined,
      });
      sendJson(res, 200, { success: true });
    } catch (error) {
      if (error instanceof RootIdentityError) sendRootIdentityError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/email-otp/verify") {
    try {
      const body = await readJson(req);
      const purpose = stringField(body, "purpose");
      if (purpose !== "sign-in" && purpose !== "email-verification") {
        throw new Error("invalid_request");
      }
      const principal = await runtime.rootIdentity.verifyEmailOtp(
        rootIdentityContext(req, res),
        {
          email: stringField(body, "email"),
          token: stringField(body, "token"),
          purpose,
        },
      );
      await bindRootPrincipal(runtime, principal);
      sendJson(res, 200, { success: true });
    } catch (error) {
      if (error instanceof RootIdentityError) sendRootIdentityError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/password/sign-up") {
    try {
      const body = await readJson(req);
      const result = await runtime.rootIdentity.signUpWithPassword(
        rootIdentityContext(req, res),
        {
          email: stringField(body, "email"),
          password: stringField(body, "password"),
        },
      );
      if (result.principal) await bindRootPrincipal(runtime, result.principal);
      sendJson(res, 200, {
        signedIn: Boolean(result.principal),
        verificationRequired: result.verificationRequired,
      });
    } catch (error) {
      if (error instanceof RootIdentityError) sendRootIdentityError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/password/sign-in") {
    try {
      const body = await readJson(req);
      const principal = await runtime.rootIdentity.signInWithPassword(
        rootIdentityContext(req, res),
        {
          email: stringField(body, "email"),
          password: stringField(body, "password"),
        },
      );
      await bindRootPrincipal(runtime, principal);
      sendJson(res, 200, { success: true });
    } catch (error) {
      if (error instanceof RootIdentityError) sendRootIdentityError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/password/reset/request") {
    try {
      const body = await readJson(req);
      await runtime.rootIdentity.requestPasswordReset(rootIdentityContext(req, res), {
        email: stringField(body, "email"),
      });
    } catch {
      // Keep password recovery account-enumeration resistant.
    }
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/password/reset/confirm") {
    let intent:
      | Awaited<ReturnType<typeof beginCredentialRevocationIntent>>
      | undefined;
    try {
      const body = await readJson(req);
      const principal = await runtime.rootIdentity.resetPasswordWithOtp(
        rootIdentityContext(req, res),
        {
          email: stringField(body, "email"),
          token: stringField(body, "token"),
          newPassword: stringField(body, "newPassword"),
        },
        async (verifiedPrincipal) => {
          const binding = await bindRootPrincipal(runtime, verifiedPrincipal);
          intent = await beginCredentialRevocationIntent(runtime.db, {
            userId: binding.userId,
            rootIdentityUserId: verifiedPrincipal.id,
            operation: "password-reset",
            deviceScope: "all",
          });
        },
      );
      const binding = await bindRootPrincipal(runtime, principal);
      if (!intent) throw new Error("credential_revocation_intent_missing");
      await markCredentialProviderMutationComplete(runtime.db, intent.id);
      const result = await finishPasswordSecurityMutation(
        runtime,
        req,
        intent.id,
        binding.userId,
        "password.reset",
        "all",
      );
      sendJson(res, result.intentCompleted ? 200 : 503, {
        success: result.intentCompleted,
        passwordUpdated: true,
        browserSessionsRevoked: true,
        ...result,
        ...(!result.intentCompleted
          ? { error: "rudder_credential_revocation_pending" }
          : {}),
      });
    } catch (error) {
      if (intent) {
        await markCredentialRevocationFailed(runtime.db, {
          intentId: intent.id,
          stage: "provider",
          error: error instanceof Error ? error.message : "unknown_error",
        }).catch(() => undefined);
      }
      sendCredentialMutationError(res, error);
    }
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/root-auth/password/recovery/complete"
  ) {
    let intent:
      | Awaited<ReturnType<typeof beginCredentialRevocationIntent>>
      | undefined;
    try {
      const body = await readJson(req);
      const principal = await runtime.rootIdentity.updateRecoveredPassword(
        rootIdentityContext(req, res),
        { newPassword: stringField(body, "newPassword") },
        async (verifiedPrincipal) => {
          const binding = await bindRootPrincipal(runtime, verifiedPrincipal);
          intent = await beginCredentialRevocationIntent(runtime.db, {
            userId: binding.userId,
            rootIdentityUserId: verifiedPrincipal.id,
            operation: "password-reset",
            deviceScope: "all",
          });
        },
      );
      const binding = await bindRootPrincipal(runtime, principal);
      if (!intent) throw new Error("credential_revocation_intent_missing");
      await markCredentialProviderMutationComplete(runtime.db, intent.id);
      const result = await finishPasswordSecurityMutation(
        runtime,
        req,
        intent.id,
        binding.userId,
        "password.reset",
        "all",
      );
      sendJson(res, result.intentCompleted ? 200 : 503, {
        success: result.intentCompleted,
        passwordUpdated: true,
        browserSessionsRevoked: true,
        ...result,
        ...(!result.intentCompleted
          ? { error: "rudder_credential_revocation_pending" }
          : {}),
      });
    } catch (error) {
      if (intent) {
        await markCredentialRevocationFailed(runtime.db, {
          intentId: intent.id,
          stage: "provider",
          error: error instanceof Error ? error.message : "unknown_error",
        }).catch(() => undefined);
      }
      sendCredentialMutationError(res, error);
    }
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/root-auth/password/reauthenticate"
  ) {
    try {
      await runtime.rootIdentity.requestPasswordChangeVerification(
        rootIdentityContext(req, res),
      );
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendRootIdentityError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/password/update") {
    let intent:
      | Awaited<ReturnType<typeof beginCredentialRevocationIntent>>
      | undefined;
    try {
      const body = await readJson(req);
      const verificationCode = stringField(body, "verificationCode");
      const revokeOthers = body.revokeOthers === true;
      const principal = await runtime.rootIdentity.updatePassword(
        rootIdentityContext(req, res),
        {
          newPassword: stringField(body, "newPassword"),
          verificationCode,
          revokeOthers,
        },
        async (verifiedPrincipal) => {
          const binding = await bindRootPrincipal(runtime, verifiedPrincipal);
          intent = await beginCredentialRevocationIntent(runtime.db, {
            userId: binding.userId,
            rootIdentityUserId: verifiedPrincipal.id,
            operation: "password-change",
            deviceScope: revokeOthers ? "all" : "none",
          });
        },
      );
      const binding = await bindRootPrincipal(runtime, principal);
      if (!intent) throw new Error("credential_revocation_intent_missing");
      await markCredentialProviderMutationComplete(runtime.db, intent.id);
      const result = await finishPasswordSecurityMutation(
        runtime,
        req,
        intent.id,
        binding.userId,
        "password.changed",
        revokeOthers ? "all" : "none",
      );
      sendJson(res, result.intentCompleted ? 200 : 503, {
        success: result.intentCompleted,
        passwordUpdated: true,
        browserSessionsRevoked: revokeOthers,
        ...result,
        ...(!result.intentCompleted
          ? { error: "rudder_credential_revocation_pending" }
          : {}),
      });
    } catch (error) {
      if (intent) {
        await markCredentialRevocationFailed(runtime.db, {
          intentId: intent.id,
          stage: "provider",
          error: error instanceof Error ? error.message : "unknown_error",
        }).catch(() => undefined);
      }
      sendCredentialMutationError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/root-auth/sign-out") {
    let intent:
      | Awaited<ReturnType<typeof beginCredentialRevocationIntent>>
      | undefined;
    try {
      const body = await readJson(req);
      const scope = stringField(body, "scope");
      if (scope !== "current" && scope !== "others" && scope !== "global") {
        throw new Error("invalid_request");
      }
      let principal:
        | Awaited<ReturnType<typeof resolveWebPrincipal>>
        | null = null;
      if (scope === "global") {
        principal = await resolveWebPrincipal(runtime, req, res, {
          requireActiveSession: true,
        });
        if (!principal) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        intent = await beginCredentialRevocationIntent(runtime.db, {
          userId: principal.userId,
          rootIdentityUserId: principal.root.id,
          operation: "global-sign-out",
          deviceScope: "all",
        });
      }
      await runtime.rootIdentity.signOut(rootIdentityContext(req, res), scope);
      if (intent && principal) {
        await markCredentialProviderMutationComplete(runtime.db, intent.id);
        const result = await finishPasswordSecurityMutation(
          runtime,
          req,
          intent.id,
          principal.userId,
          "session.global_signout",
          "all",
        );
        if (!result.intentCompleted) {
          sendJson(res, 503, {
            success: false,
            scope,
            browserSessionsRevoked: true,
            ...result,
            error: "rudder_credential_revocation_pending",
          });
          return;
        }
        sendJson(res, 200, {
          success: true,
          scope,
          browserSessionsRevoked: true,
          ...result,
        });
        return;
      }
      sendJson(res, 200, {
        success: true,
        scope,
        browserSessionsRevoked: true,
        desktopSessionsRevoked: false,
        localServerSessionStatus: "unchanged",
      });
    } catch (error) {
      if (intent) {
        await markCredentialRevocationFailed(runtime.db, {
          intentId: intent.id,
          stage: "provider",
          error: error instanceof Error ? error.message : "unknown_error",
        }).catch(() => undefined);
      }
      sendCredentialMutationError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/account") {
    const principal = await resolveWebPrincipal(runtime, req, res);
    if (!principal) {
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", "/?next=%2Faccount");
      res.end();
      return;
    }
    sendHtml(res, accountPage(principal.root.email), { sensitive: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/device") {
    const userCode = url.searchParams.get("user_code") ?? "";
    if (!/^[A-Za-z0-9 -]{4,20}$/u.test(userCode)) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    const principal = await resolveWebPrincipal(runtime, req, res);
    if (!principal) {
      const next = `${url.pathname}${url.search}`;
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", `/?next=${encodeURIComponent(next)}`);
      res.end();
      return;
    }
    const requestMetadata = securityRequestMetadata(req, runtime.config.secret);
    const rateLimit = await consumeIdentityOperationRateLimit(runtime.db, {
      key: `device-verify:${hashOpaqueSecret(
        `${requestMetadata.ipHashKey}:${requestMetadata.ipAddress ?? "unknown"}`,
      )}`,
      limit: 30,
      windowMs: 10 * 60 * 1_000,
    });
    if (!rateLimit.allowed) {
      res.setHeader("retry-after", Math.ceil(rateLimit.retryAfterMs / 1_000));
      sendJson(res, 429, { error: "rate_limited" });
      return;
    }
    const verification = await verifyDeviceAuthorization(runtime.db, { userCode });
    if (verification.status !== "pending") {
      sendJson(res, 400, { error: verification.status });
      return;
    }
    sendHtml(res, deviceApprovalPage(userCode), { sensitive: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "rudder-identity",
      releaseChannel: runtime.config.releaseChannel,
      mailDelivery: runtime.config.mail.mode,
      providers: {
        emailOtp: true,
        password: true,
        google: Boolean(runtime.config.google),
        github: Boolean(runtime.config.github),
        deviceAuthorization: true,
        offlineGrant: Boolean(runtime.offlineGrantSigning),
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/rudder-offline-grant-key") {
    const signing = runtime.offlineGrantSigning;
    if (!signing) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, {
      issuer: runtime.config.baseUrl,
      kid: signing.keyId,
      alg: "EdDSA",
      public_key_spki: signing.publicKeySpki,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/dev/mailbox" &&
    (runtime.config.releaseChannel === "development" || runtime.config.releaseChannel === "test") &&
    runtime.capturedMail
  ) {
    const mailboxAuthorization = req.headers.authorization;
    if (
      runtime.config.mail.mode !== "capture" ||
      !mailboxAuthorization?.startsWith("Bearer ") ||
      !opaqueSecretMatches(
        mailboxAuthorization.slice("Bearer ".length),
        // Compare opaque secrets in constant time without persisting another
        // copy of the raw mailbox credential.
        hashOpaqueSecret(runtime.config.mail.mailboxSecret),
      )
    ) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, { messages: runtime.capturedMail.messages });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/device-code") {
    try {
      const body = await readJson(req);
      const clientId = stringField(body, "client_id");
      if (!runtime.config.deviceClientIds.has(clientId)) {
        throw new Error("invalid_request");
      }
      const scope = typeof body.scope === "string" ? body.scope : null;
      const requestMetadata = securityRequestMetadata(req, runtime.config.secret);
      const rateLimit = await consumeIdentityOperationRateLimit(runtime.db, {
        key: `device-issue:${hashOpaqueSecret(
          `${requestMetadata.ipHashKey}:${requestMetadata.ipAddress ?? "unknown"}`,
        )}`,
        limit: 20,
        windowMs: 60 * 60 * 1_000,
      });
      if (!rateLimit.allowed) {
        res.setHeader("retry-after", Math.ceil(rateLimit.retryAfterMs / 1_000));
        sendJson(res, 429, { error: "rate_limited" });
        return;
      }
      const issued = await issueDeviceAuthorization(runtime.db, { clientId, scope });
      await recordSecurityEvent(runtime.db, {
        eventType: "device.authorization.requested",
        ...requestMetadata,
        metadata: { clientId, scope },
      });
      sendJson(res, 200, {
        device_code: issued.deviceCode,
        user_code: issued.userCode,
        verification_uri: `${runtime.config.baseUrl}/device`,
        expires_in: issued.expiresIn,
        interval: issued.interval,
      });
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/api/desktop/device-code/approve" ||
      url.pathname === "/api/desktop/device-code/deny")
  ) {
    try {
      const principal = await resolveWebPrincipal(runtime, req, res, {
        requireActiveSession: true,
      });
      if (!principal) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJson(req);
      const userCode = stringField(body, "userCode");
      const requestMetadata = securityRequestMetadata(req, runtime.config.secret);
      const rateLimitKeys = [
        {
          key: `device-decision-actor:${hashOpaqueSecret(
            `${principal.userId}:${requestMetadata.ipHashKey}:${
              requestMetadata.ipAddress ?? "unknown"
            }`,
          )}`,
          limit: 30,
        },
        {
          key: `device-decision-code:${hashOpaqueSecret(
            userCode.replace(/[\s-]+/gu, "").toUpperCase(),
          )}`,
          limit: 6,
        },
      ];
      for (const rateLimitInput of rateLimitKeys) {
        const rateLimit = await consumeIdentityOperationRateLimit(runtime.db, {
          ...rateLimitInput,
          windowMs: 10 * 60 * 1_000,
        });
        if (!rateLimit.allowed) {
          res.setHeader("retry-after", Math.ceil(rateLimit.retryAfterMs / 1_000));
          sendJson(res, 429, { error: "rate_limited" });
          return;
        }
      }
      const input = {
        userCode,
        userId: principal.userId,
      };
      const result = url.pathname.endsWith("/approve")
        ? await approveDeviceAuthorization(runtime.db, input)
        : await denyDeviceAuthorization(runtime.db, input);
      if (result.status !== "approved" && result.status !== "denied") {
        sendJson(res, 400, { error: result.status });
        return;
      }
      await recordSecurityEvent(runtime.db, {
        userId: principal.userId,
        eventType:
          result.status === "approved"
            ? "device.authorization.approved"
            : "device.authorization.denied",
        ...requestMetadata,
      });
      sendJson(res, 200, { success: true, status: result.status });
    } catch (error) {
      if (error instanceof RootIdentityError) sendRootIdentityError(res, error);
      else sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/desktop/device-code/token"
  ) {
    try {
      const body = await readJson(req);
      if (
        stringField(body, "grant_type") !==
        "urn:ietf:params:oauth:grant-type:device_code"
      ) {
        throw new Error("invalid_request");
      }
      const clientId = stringField(body, "client_id");
      if (!runtime.config.deviceClientIds.has(clientId)) {
        throw new Error("invalid_request");
      }
      const installationId = stringField(body, "installation_id");
      const deviceName = stringField(body, "device_name");
      const localSignOutEpoch = nonNegativeIntegerField(body, "sign_out_epoch");
      if (installationId.length > 256 || deviceName.length > 160) {
        throw new Error("invalid_request");
      }
      const decision = await redeemApprovedDeviceAuthorization(runtime.db, {
        deviceCode: stringField(body, "device_code"),
        clientId,
        installationId,
        deviceName,
        devicePublicKeyThumbprint:
          typeof body.device_public_key_thumbprint === "string"
            ? body.device_public_key_thumbprint
            : null,
      });
      if (decision.status !== "approved") {
        sendJson(res, 400, {
          error: decision.status,
          ...("interval" in decision ? { interval: decision.interval } : {}),
        });
        return;
      }
      sendDeviceTokens(
        res,
        decision.session,
        runtime,
        localSignOutEpoch,
      );
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/desktop/authorize") {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const audience = url.searchParams.get("audience") ?? "";
    if (
      !runtime.config.deviceClientIds.has(clientId) ||
      !validLoopbackRedirect(redirectUri) ||
      codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge) ||
      state.length < 16 ||
      state.length > 512 ||
      audience.length < 1 ||
      audience.length > 256
    ) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }

    let principal;
    try {
      principal = await resolveWebPrincipal(runtime, req, res, {
        requireActiveSession: true,
      });
    } catch (error) {
      sendRootIdentityError(res, error);
      return;
    }
    if (!principal) {
      const next = `${url.pathname}${url.search}`;
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", `/?next=${encodeURIComponent(next)}`);
      res.end();
      return;
    }

    const authorization = await issueDesktopAuthorizationCode(runtime.db, {
      userId: principal.userId,
      clientId,
      redirectUri,
      codeChallenge,
      audience,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", authorization.code);
    callback.searchParams.set("state", state);
    res.statusCode = 302;
    res.setHeader("cache-control", "no-store");
    res.setHeader("location", callback.toString());
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/token") {
    try {
      const body = await readJson(req);
      if (stringField(body, "grant_type") !== "authorization_code") throw new Error("invalid_request");
      const clientId = stringField(body, "client_id");
      const redirectUri = stringField(body, "redirect_uri");
      const localSignOutEpoch = nonNegativeIntegerField(body, "sign_out_epoch");
      if (!runtime.config.deviceClientIds.has(clientId) || !validLoopbackRedirect(redirectUri)) {
        throw new Error("invalid_request");
      }
      const result = await redeemDesktopAuthorizationCode(runtime.db, {
        code: stringField(body, "code"),
        clientId,
        redirectUri,
        codeVerifier: stringField(body, "code_verifier"),
        installationId: stringField(body, "installation_id"),
        deviceName: stringField(body, "device_name"),
        devicePublicKeyThumbprint:
          typeof body.device_public_key_thumbprint === "string"
            ? body.device_public_key_thumbprint
            : null,
      });
      sendDeviceTokens(
        res,
        result,
        runtime,
        localSignOutEpoch,
      );
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error && error.message === "invalid_grant"
          ? "invalid_grant"
          : "invalid_request",
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/refresh") {
    let refreshInput: {
      clientId: string;
      refreshToken: string;
      localSignOutEpoch: number;
    };
    try {
      const body = await readJson(req);
      if (
        stringField(body, "grant_type") !== "refresh_token" ||
        !runtime.config.deviceClientIds.has(stringField(body, "client_id"))
      ) {
        throw new Error("invalid_request");
      }
      refreshInput = {
        clientId: stringField(body, "client_id"),
        refreshToken: stringField(body, "refresh_token"),
        localSignOutEpoch: nonNegativeIntegerField(body, "sign_out_epoch"),
      };
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    try {
      const result = await rotateDeviceRefreshToken(runtime.db, {
        refreshToken: refreshInput.refreshToken,
        clientId: refreshInput.clientId,
      });
      sendDeviceTokens(res, result, runtime, refreshInput.localSignOutEpoch);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "invalid_grant") throw error;
      sendJson(res, 400, { error: "invalid_grant" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/server/exchange") {
    const authorization = req.headers.authorization;
    const access = authorization?.startsWith("Bearer ")
      ? await resolveDeviceAccessToken(runtime.db, authorization.slice("Bearer ".length))
      : null;
    if (!access) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      const installationId = stringField(body, "installation_id");
      const audience = stringField(body, "audience");
      if (
        installationId.length > 256 ||
        audience.length > 256 ||
        installationId !== audience
      ) throw new Error("invalid_request");
      const exchange = await issueServerExchangeCode(runtime.db, {
        userId: access.userId,
        deviceId: access.deviceId,
        installationId,
        audience,
      });
      sendJson(res, 200, {
        code: exchange.code,
        expires_in: exchange.expiresIn,
      });
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/server/exchange/verify") {
    try {
      const body = await readJson(req);
      const exchange = await consumeServerExchangeCode(runtime.db, {
        code: stringField(body, "code"),
        expectedAudience: stringField(body, "expected_audience"),
        expectedInstallationId: stringField(body, "expected_installation_id"),
      });
      sendJson(res, 200, {
        issuer: runtime.config.baseUrl,
        subject: exchange.subject,
        audience: exchange.audience,
        installationId: exchange.installationId,
        jti: exchange.jti,
        expiresAt: exchange.expiresAt.toISOString(),
        email: exchange.email,
        name: exchange.name,
      });
    } catch {
      sendJson(res, 400, { error: "invalid_grant" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/telemetry/assertion") {
    const authorization = req.headers.authorization;
    const access = authorization?.startsWith("Bearer ")
      ? await resolveDeviceAccessToken(runtime.db, authorization.slice("Bearer ".length))
      : null;
    if (!access) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!runtime.telemetryAssertionSigning) {
      sendJson(res, 503, { error: "telemetry_issuer_unavailable", retryable: true });
      return;
    }
    try {
      const body = await readJson(req);
      const installationId = stringField(body, "installation_id");
      const mode = body.mode;
      const consentVersion = stringField(body, "consent_version");
      const pseudonymousInstallationId = stringField(body, "pseudonymous_installation_id");
      if (
        installationId !== access.installationId
        || mode !== "account_linked"
        || !/^[0-9a-f]{64}$/u.test(pseudonymousInstallationId)
      ) throw new Error("invalid_request");
      const consent = await assertIdentityProductAnalyticsConsent(runtime.db, {
        userId: access.userId,
        installationId,
        mode,
        consentVersion,
      });
      const analyticsSubject = mode === "account_linked"
        ? deriveProductAnalyticsSubject(runtime.telemetryAssertionSigning.subjectSecret, access.userId)
        : null;
      const collectorConsentSync = runtime.config.telemetry?.collectorConsentSync;
      if (collectorConsentSync) {
        try {
          await syncProductAnalyticsConsent({
            config: collectorConsentSync,
            consent: {
              installationId,
              analyticsSubject,
              consentVersion: consent.consentVersion,
              consentEpoch: consent.consentEpoch,
              revoked: false,
            },
          });
        } catch {
          sendJson(res, 503, { error: "telemetry_consent_sync_unavailable", retryable: true });
          return;
        }
      }
      const nowMs = Date.now();
      const assertion = issueProductAnalyticsAssertion({
        signingPrivateKey: runtime.telemetryAssertionSigning.privateKey,
        keyId: runtime.telemetryAssertionSigning.keyId,
        issuer: runtime.config.baseUrl,
        installationId,
        pseudonymousInstallationId,
        analyticsSubject,
        consentVersion,
        consentEpoch: consent.consentEpoch,
        nowMs,
        jti: randomUUID(),
      });
      sendJson(res, 200, {
        assertion,
        expires_at: new Date(nowMs + 15 * 60 * 1000).toISOString(),
        audience: "telemetry-collector",
        analytics_subject: analyticsSubject,
      });
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/telemetry/consent") {
    const authorization = req.headers.authorization;
    const access = authorization?.startsWith("Bearer ")
      ? await resolveDeviceAccessToken(runtime.db, authorization.slice("Bearer ".length))
      : null;
    if (!access) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      const installationId = stringField(body, "installation_id");
      const mode = body.mode;
      const decision = body.decision;
      const consentVersion = stringField(body, "consent_version");
      if (
        installationId !== access.installationId
        || (mode !== "anonymous" && mode !== "account_linked")
        || (decision !== "granted" && decision !== "revoked")
      ) throw new Error("invalid_request");
      if (mode === "account_linked" && !runtime.telemetryAssertionSigning) {
        sendJson(res, 503, { error: "telemetry_issuer_unavailable", retryable: true });
        return;
      }
      const collectorConsentSync = runtime.config.telemetry?.collectorConsentSync;
      const analyticsSubject = mode === "account_linked"
        ? deriveProductAnalyticsSubject(runtime.telemetryAssertionSigning!.subjectSecret, access.userId)
        : null;
      const consent = await recordIdentityProductAnalyticsConsent(runtime.db, {
        userId: access.userId,
        installationId,
        mode,
        decision,
        consentVersion,
        beforePersist: collectorConsentSync
          ? async (next) => {
              try {
                await syncProductAnalyticsConsent({
                  config: collectorConsentSync,
                  consent: {
                    installationId,
                    analyticsSubject,
                    consentVersion: next.consentVersion,
                    consentEpoch: next.consentEpoch,
                    revoked: next.revoked,
                  },
                });
              } catch {
                throw new TelemetryConsentSyncUnavailableError();
              }
            }
          : undefined,
      });
      sendJson(res, 201, {
        mode: consent.mode,
        decision: consent.decision,
        consentVersion: consent.consentVersion,
        consentEpoch: consent.consentEpoch,
        decidedAt: consent.decidedAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof TelemetryConsentSyncUnavailableError) {
        sendJson(res, 503, { error: "telemetry_consent_sync_unavailable", retryable: true });
        return;
      }
      sendJson(res, 422, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/account/devices") {
    const principal = await resolveAccountPrincipal(runtime, req, res);
    if (!principal) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const devices = await listIdentityDevices(runtime.db, principal.userId);
    sendJson(res, 200, {
      devices: devices.map((device) => ({
        ...device,
        current: device.id === principal.deviceId,
      })),
    });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/account/devices/")) {
    const cookieAuthenticated = !req.headers.authorization?.startsWith("Bearer ");
    if (cookieAuthenticated) {
      const browserError = browserMutationError(req, runtime.config.allowedOrigins, {
        requireJson: false,
      });
      if (browserError) {
        sendJson(res, 403, { error: browserError });
        return;
      }
    }
    const principal = await resolveAccountPrincipal(runtime, req, res, {
      requireActiveWebSession: cookieAuthenticated,
    });
    if (!principal) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const deviceId = decodeURIComponent(url.pathname.slice("/api/account/devices/".length));
    if (!deviceId) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    const revoked = await revokeIdentityDevice(runtime.db, {
      userId: principal.userId,
      deviceId,
    });
    if (!revoked) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, {
      success: true,
      deviceId,
      currentDeviceRevoked: principal.deviceId === deviceId,
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}
