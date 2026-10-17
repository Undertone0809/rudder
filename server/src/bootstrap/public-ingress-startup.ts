import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { localAgentJwtAuthSettings } from "../agent-auth-jwt.js";
import type { RudderAppHandle } from "../app.js";
import { betterAuthSessionCookieSettings } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import type { LocalRuntimeOwnerKind } from "../local-runtime.js";
import type { RustLocalAccountLifecycleOptions } from "../services/rust-public-ingress-config.js";
import { selectAvailablePort } from "./port-selection.js";
import type { RudderAppOptions } from "./types.js";

export function assertPublicIngressExposure(
  config: Config,
  localAccountAuth: boolean,
  runtimeOwnerKind?: LocalRuntimeOwnerKind | null,
): void {
  if (config.rustPublicIngressMode !== "required") return;
  if (config.deploymentMode === "local_trusted" && runtimeOwnerKind === "desktop" && !localAccountAuth) {
    throw new Error("Desktop local-trusted runtime requires Desktop account authentication");
  }
  if (!isIP(config.host)) throw new Error("Rust public ingress requires a numeric listener address");
  if (config.deploymentMode === "local_trusted" && !localAccountAuth
    && config.host !== "127.0.0.1" && config.host !== "::1") {
    throw new Error("Rust public ingress cannot expose an implicit local Board on a non-loopback listener");
  }
}

export async function preparePublicIngressStartup(
  config: Config,
  publicPort: number,
  localAccountAuth?: { sessionSecret: string; secureCookie?: boolean },
  runtimeOwnerKind?: LocalRuntimeOwnerKind | null,
  localAccountLifecycle?: RustLocalAccountLifecycleOptions,
) {
  assertPublicIngressExposure(config, Boolean(localAccountAuth), runtimeOwnerKind);
  const enabled = config.rustPublicIngressMode === "required";
  const nodeListenHost = enabled ? "127.0.0.1" : config.host;
  const nodeListenPort = enabled
    ? await selectAvailablePort(publicPort === 65_535 ? 3_101 : publicPort + 1, nodeListenHost)
    : publicPort;
  if (enabled && nodeListenPort === publicPort) throw new Error("Public ingress and private Node listener must use distinct ports");
  const apiHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  const publicApiUrl = `http://${apiHost.includes(":") ? `[${apiHost}]` : apiHost}:${publicPort}`;
  const appOptions: Pick<RudderAppOptions, "rustFoundationActorEnvelopeKey" | "rustPublicIngressAuthKey" | "rustPublicIngress"> = {};
  if (enabled) {
    const authorizationKey = randomBytes(32).toString("hex");
    const identityAssertionKey = randomBytes(32).toString("hex");
    const agentJwt = localAgentJwtAuthSettings();
    const sessionAuth = localAccountAuth
      ? {
          kind: "local_account" as const,
          // index.ts passes required auth to the private WebSocket resolver whenever
          // localAccountAuth is configured, including local_trusted deployments.
          websocketCookieFallback: "session" as const,
          secret: localAccountAuth.sessionSecret,
          secureCookie: localAccountAuth.secureCookie ?? false,
          assertionKey: identityAssertionKey,
        }
      : config.deploymentMode === "authenticated"
        ? (() => {
            const settings = betterAuthSessionCookieSettings(config);
            if (!settings.secret?.trim()) {
              throw new Error("Rust public ingress requires the configured Better Auth session secret");
            }
            return {
              kind: "better_auth" as const,
              secret: settings.secret,
              secureCookie: settings.secureCookie,
              assertionKey: identityAssertionKey,
            };
          })()
        : undefined;
    if (localAccountAuth && !localAccountAuth.sessionSecret.trim()) {
      throw new Error("Rust public ingress requires the Desktop account session secret");
    }
    appOptions.rustFoundationActorEnvelopeKey = config.rustFoundationActorEnvelopeKey ?? randomBytes(32).toString("hex");
    appOptions.rustPublicIngressAuthKey = authorizationKey;
    appOptions.rustPublicIngress = {
      listenAddr: `${config.host.includes(":") ? `[${config.host}]` : config.host}:${publicPort}`,
      nodeUpstream: `http://127.0.0.1:${nodeListenPort}`,
      authorizationKey,
      trustedProxies: config.rustPublicIngressTrustedProxies,
      identityAuth: {
        assertionKey: identityAssertionKey,
        agentJwtSecret: agentJwt.secret,
        agentJwtIssuer: agentJwt.issuer,
        agentJwtAudience: agentJwt.audience,
        localImplicitEnabled: config.deploymentMode === "local_trusted"
          && !localAccountAuth
          && runtimeOwnerKind !== "desktop",
      },
      ...(sessionAuth ? { sessionAuth } : {}),
      ...(localAccountLifecycle ? { localAccountLifecycle } : {}),
    };
  }
  return {
    nodeListenHost, nodeListenPort, publicApiUrl, appOptions,
    onListening(app: RudderAppHandle, reject: (error: unknown) => void, ready: () => void) {
      return async () => {
        try {
          if (enabled) {
            if (!app.waitForPublicIngressReady || !app.publicIngressBaseUrl) {
              throw new Error("Explicit Rust public ingress did not provide its listener identity");
            }
            await app.waitForPublicIngressReady();
          }
          ready();
        } catch (error) { reject(error); }
      };
    },
  };
}
