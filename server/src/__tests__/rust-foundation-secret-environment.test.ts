import { afterEach, expect, it, vi } from "vitest";
import { createFoundationChildEnvironment } from "../services/rust-foundation-bridge.js";

afterEach(() => vi.unstubAllEnvs());

it("transports the configured secret provider to Rust without ambient credentials", () => {
  vi.stubEnv("RUDDER_SECRETS_PROVIDER", "env");
  vi.stubEnv("UNRELATED_PROVIDER_SECRET", "must-not-reach-child");
  const environment = createFoundationChildEnvironment({
    databaseUrl: "postgres://fixture/db", actorEnvelopeKey: "fixture-key",
    secretsMasterKeyFile: "/fixture/master.key",
  });
  expect(environment.RUDDER_SECRETS_PROVIDER).toBe("env");
  expect(environment).not.toHaveProperty("UNRELATED_PROVIDER_SECRET");
});
