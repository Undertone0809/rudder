import { randomBytes } from "node:crypto";
import { nativeSessionAssertionMiddleware } from "../../auth/native-session-assertion.js";
import type { RustNativeIdentityAuthOptions } from "../../services/rust-public-ingress-config.js";

/** Use production proof validation with real fixture credentials, never a test auth bypass. */
export function nativeIdentityIngressFixture(localImplicitEnabled = false) {
  const identityAuth: RustNativeIdentityAuthOptions = {
    assertionKey: randomBytes(32).toString("hex"),
    agentJwtSecret: randomBytes(32).toString("hex"),
    agentJwtIssuer: "rudder",
    agentJwtAudience: "rudder-api",
    localImplicitEnabled,
  };
  return {
    identityAuth,
    middleware: () => nativeSessionAssertionMiddleware({ key: identityAuth.assertionKey }),
  };
}
