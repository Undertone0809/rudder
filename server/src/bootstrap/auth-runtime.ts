import type { Db } from "@rudderhq/db";
import type { Request, RequestHandler } from "express";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { initializeBoardClaimChallenge } from "../board-claim.js";
import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import {
  createIdentityServerExchangeVerifier,
  createLocalAccountSessionResolver,
  type LocalAccountExchangePolicy,
} from "../services/local-account-auth.js";
import {
  createLocalAccountSessionRevocation,
  type LocalAccountSessionRevocation,
} from "../services/local-account-session-revocation.js";

export interface LocalAccountAuthOptions {
  identityOrigin: string;
  audience: string;
  sessionSecret: string;
  secureCookie?: boolean;
  offline?: {
    identityKeyId: string;
    identityPublicKeySpki: string;
    expectedAccountId: string;
    expectedDeviceId: string;
    lastTrustedTimeMs: number;
    localSignOutEpoch: number;
  };
}

export interface AuthRuntime {
  authReady: boolean;
  betterAuthHandler?: RequestHandler;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
  resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  localAccountExchangePolicy?: LocalAccountExchangePolicy;
  localAccountSessionRevocation?: LocalAccountSessionRevocation;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export async function createAuthRuntime(options: {
  db: Db;
  config: Config;
  instanceId: string;
  localAccountAuth?: LocalAccountAuthOptions;
  ensureLocalTrustedBoardPrincipal: () => Promise<void>;
}): Promise<AuthRuntime> {
  const { config, db, instanceId, localAccountAuth } = options;
  const runtime: AuthRuntime = {
    authReady: config.deploymentMode === "local_trusted",
    localAccountSessionRevocation: localAccountAuth
      ? createLocalAccountSessionRevocation()
      : undefined,
  };

  if (config.deploymentMode === "local_trusted") {
    await options.ensureLocalTrustedBoardPrincipal();
  }

  if (localAccountAuth) {
    if (config.deploymentMode !== "local_trusted" || !isLoopbackHost(config.host)) {
      throw new Error(
        "Desktop account authentication is supported only by a loopback local_trusted runtime",
      );
    }
    runtime.localAccountExchangePolicy = {
      expectedIssuer: new URL(localAccountAuth.identityOrigin).origin,
      audience: localAccountAuth.audience,
      installationId: instanceId,
      sessionSecret: localAccountAuth.sessionSecret,
      secureCookie: localAccountAuth.secureCookie ?? false,
      offline: localAccountAuth.offline,
      verifier: createIdentityServerExchangeVerifier({
        identityOrigin: localAccountAuth.identityOrigin,
        expectedAudience: localAccountAuth.audience,
        expectedInstallationId: instanceId,
      }),
    };
    const resolveLocalSession = createLocalAccountSessionResolver(db, {
      sessionSecret: localAccountAuth.sessionSecret,
      secureCookie: localAccountAuth.secureCookie ?? false,
    });
    runtime.resolveSession = (req) => resolveLocalSession(req.headers);
    runtime.resolveSessionFromHeaders = (headers) => {
      const rawHeaders: Record<string, string> = {};
      headers.forEach((value, key) => {
        rawHeaders[key] = value;
      });
      return resolveLocalSession(rawHeaders);
    };
    runtime.authReady = true;
  }

  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("../auth/better-auth.js");
    const betterAuthSecret =
      process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.RUDDER_AGENT_JWT_SECRET?.trim();
    if (!betterAuthSecret) {
      throw new Error(
        "authenticated mode requires BETTER_AUTH_SECRET (or RUDDER_AGENT_JWT_SECRET) to be set",
      );
    }
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(
      new Set([...derivedTrustedOrigins, ...envTrustedOrigins]),
    );
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db, config, effectiveTrustedOrigins);
    runtime.betterAuthHandler = createBetterAuthHandler(auth);
    runtime.resolveSession = (req) => resolveBetterAuthSession(auth, req);
    runtime.resolveSessionFromHeaders = (headers) =>
      resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db, { deploymentMode: config.deploymentMode });
    runtime.authReady = true;
  }

  return runtime;
}
