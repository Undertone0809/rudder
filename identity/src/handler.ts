import {
  hashOpaqueSecret,
  issueOfflineGrant,
  opaqueSecretMatches,
} from "@rudderhq/identity-core";
import {
  consumeServerExchangeCode,
  issueDesktopAuthorizationCode,
  issueDesktopDeviceSession,
  issueServerExchangeCode,
  listIdentityDevices,
  recordSecurityEvent,
  redeemDesktopAuthorizationCode,
  resolveDeviceAccessToken,
  revokeIdentityDevice,
  rotateDeviceRefreshToken,
} from "@rudderhq/identity-db";
import { toNodeHandler } from "better-auth/node";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { identityClientScript } from "./client-script.js";
import {
  accountPage,
  deviceApprovalPage,
  homePage,
  privacyPage,
  termsPage,
} from "./pages.js";
import { getIdentityRuntime } from "./runtime.js";

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
  res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
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

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid_request");
  return value;
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

async function resolveAccountPrincipal(
  runtime: ReturnType<typeof getIdentityRuntime>,
  req: IncomingMessage,
): Promise<{ userId: string; deviceId: string | null } | null> {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const access = await resolveDeviceAccessToken(runtime.db, authorization.slice("Bearer ".length));
    if (access) return access;
  }
  const session = await runtime.auth.api.getSession({ headers: nodeHeaders(req) });
  return session?.user?.id ? { userId: session.user.id, deviceId: null } : null;
}

function sendDeviceTokens(
  res: ServerResponse,
  result: Awaited<ReturnType<typeof redeemDesktopAuthorizationCode>>,
  runtime: ReturnType<typeof getIdentityRuntime>,
  signOutEpoch: number,
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
        signOutEpoch,
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

function nonNegativeSafeInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid_request");
  return Number(value);
}

export async function identityHandler(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { backgroundTaskHandler?: (promise: Promise<unknown>) => void },
): Promise<void> {
  const publicBaseUrl = process.env.IDENTITY_BASE_URL ?? "http://127.0.0.1";
  const url = new URL(req.url ?? "/", publicBaseUrl);

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, homePage({
      google: Boolean(process.env.IDENTITY_GOOGLE_CLIENT_ID),
      github: Boolean(process.env.IDENTITY_GITHUB_CLIENT_ID),
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

  if (req.method === "GET" && url.pathname === "/account") {
    const session = await runtime.auth.api.getSession({ headers: nodeHeaders(req) });
    if (!session?.user?.id) {
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", "/?next=%2Faccount");
      res.end();
      return;
    }
    sendHtml(res, accountPage(session.user.email), { sensitive: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/device") {
    const userCode = url.searchParams.get("user_code") ?? "";
    if (!/^[A-Za-z0-9]{4,16}$/u.test(userCode)) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    const session = await runtime.auth.api.getSession({ headers: nodeHeaders(req) });
    if (!session?.user?.id) {
      const next = `${url.pathname}${url.search}`;
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", `/?next=${encodeURIComponent(next)}`);
      res.end();
      return;
    }
    try {
      await runtime.auth.api.deviceVerify({
        query: { user_code: userCode },
        headers: nodeHeaders(req),
      });
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
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

    const session = await runtime.auth.api.getSession({ headers: nodeHeaders(req) });
    if (!session?.user?.id) {
      const next = `${url.pathname}${url.search}`;
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", `/?next=${encodeURIComponent(next)}`);
      res.end();
      return;
    }

    const authorization = await issueDesktopAuthorizationCode(runtime.db, {
      userId: session.user.id,
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
      sendDeviceTokens(res, result, runtime, nonNegativeSafeInteger(body, "sign_out_epoch"));
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
      signOutEpoch: number;
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
        signOutEpoch: nonNegativeSafeInteger(body, "sign_out_epoch"),
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
      sendDeviceTokens(res, result, runtime, refreshInput.signOutEpoch);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "invalid_grant") throw error;
      sendJson(res, 400, { error: "invalid_grant" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/desktop/device-session") {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const session = await runtime.auth.api.getSession({ headers: nodeHeaders(req) });
    if (!session?.user?.id) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      const clientId = stringField(body, "client_id");
      const installationId = stringField(body, "installation_id");
      const deviceName = stringField(body, "device_name");
      if (
        !runtime.config.deviceClientIds.has(clientId) ||
        installationId.length > 256 ||
        deviceName.length > 160
      ) {
        throw new Error("invalid_request");
      }
      const result = await issueDesktopDeviceSession(runtime.db, {
        userId: session.user.id,
        clientId,
        installationId,
        deviceName,
        devicePublicKeyThumbprint:
          typeof body.device_public_key_thumbprint === "string"
            ? body.device_public_key_thumbprint
            : null,
      });
      sendDeviceTokens(res, result, runtime, nonNegativeSafeInteger(body, "sign_out_epoch"));
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
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

  if (req.method === "POST" && url.pathname === "/api/account/password/verification") {
    const session = await runtime.auth.api.getSession({ headers: nodeHeaders(req) });
    if (!session?.user?.id) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    await runtime.auth.api.sendVerificationOTP({
      body: { email: session.user.email, type: "email-verification" },
      headers: nodeHeaders(req),
    });
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/account/password") {
    const headers = nodeHeaders(req);
    const session = await runtime.auth.api.getSession({ headers });
    if (!session?.user?.id) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      const verified = await runtime.auth.api.verifyEmailOTP({
        body: {
          email: session.user.email,
          otp: stringField(body, "otp"),
        },
        headers,
      });
      if (verified.user.id !== session.user.id) throw new Error("invalid_otp");
      await runtime.auth.api.setPassword({
        body: { newPassword: stringField(body, "newPassword") },
        headers: verified.token
          ? new Headers({ authorization: `Bearer ${verified.token}` })
          : headers,
      });
      await recordSecurityEvent(runtime.db, {
        userId: session.user.id,
        eventType: "password.set",
        ...securityRequestMetadata(req, runtime.config.secret),
      });
      sendJson(res, 200, { success: true });
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
    const headers = nodeHeaders(req);
    const session = await runtime.auth.api.getSession({ headers });
    if (!session?.user?.id) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      const result = await runtime.auth.api.changePassword({
        body: {
          currentPassword: stringField(body, "currentPassword"),
          newPassword: stringField(body, "newPassword"),
          revokeOtherSessions: body.revokeOtherSessions === true,
        },
        headers,
      });
      await recordSecurityEvent(runtime.db, {
        userId: session.user.id,
        eventType: "password.changed",
        ...securityRequestMetadata(req, runtime.config.secret),
      });
      sendJson(res, 200, result);
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/account/devices") {
    const principal = await resolveAccountPrincipal(runtime, req);
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

  if (req.method === "GET" && url.pathname === "/api/account/web-sessions") {
    const headers = nodeHeaders(req);
    const current = await runtime.auth.api.getSession({ headers });
    if (!current?.user?.id) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const sessions = await runtime.auth.api.listSessions({ headers });
      sendJson(res, 200, {
        sessions: sessions.map((session) => ({
          id: session.id,
          current: session.id === current.session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress ?? null,
          userAgent: session.userAgent ?? null,
        })),
      });
    } catch {
      sendJson(res, 403, { error: "fresh_session_required" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/account/web-sessions/revoke-others") {
    const headers = nodeHeaders(req);
    const current = await runtime.auth.api.getSession({ headers });
    if (!current?.user?.id) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      await runtime.auth.api.revokeOtherSessions({ headers });
      sendJson(res, 200, { success: true, currentSessionId: current.session.id });
    } catch {
      sendJson(res, 403, { error: "fresh_session_required" });
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/account/web-sessions/")) {
    const headers = nodeHeaders(req);
    const current = await runtime.auth.api.getSession({ headers });
    if (!current?.user?.id) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = decodeURIComponent(
      url.pathname.slice("/api/account/web-sessions/".length),
    );
    if (!sessionId || sessionId === current.session.id) {
      sendJson(res, 400, { error: "current_session_must_use_sign_out" });
      return;
    }
    try {
      const sessions = await runtime.auth.api.listSessions({ headers });
      const target = sessions.find((session) => session.id === sessionId);
      if (!target) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      await runtime.auth.api.revokeSession({
        body: { token: target.token },
        headers,
      });
      sendJson(res, 200, { success: true, sessionId });
    } catch {
      sendJson(res, 403, { error: "fresh_session_required" });
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/account/devices/")) {
    const principal = await resolveAccountPrincipal(runtime, req);
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

  if (url.pathname.startsWith("/api/auth/")) {
    await toNodeHandler(runtime.auth)(req, res);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}
