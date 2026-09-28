import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { createRudderAppStartupOptions } from "../app.js";

const startupSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

describe("Rust member directory supported startup wiring", () => {
  it("passes active database and explicit bridge config through startup exactly once", () => {
    const config = {
      companyDeletionEnabled: true,
      rustFoundationMode: "required",
      rustOrganizationBrandingMode: "required",
      rustProjectGoalSetMode: "shadow",
      rustFoundationBinaryPath: "/runtime/rudder-server-foundation",
      rustFoundationActorEnvelopeKey: "actor-envelope-key",
    } as Config;

    expect(createRudderAppStartupOptions(config, "postgres://active-db", true)).toEqual({
      authReady: true,
      companyDeletionEnabled: true,
      databaseUrl: "postgres://active-db",
      rustFoundationMode: "required",
      rustOrganizationBrandingMode: "required",
      rustProjectGoalSetMode: "shadow",
      rustFoundationBinaryPath: "/runtime/rudder-server-foundation",
      rustFoundationActorEnvelopeKey: "actor-envelope-key",
    });
    expect(startupSource.match(/createRudderAppStartupOptions\(/g)).toHaveLength(1);
  });
});
