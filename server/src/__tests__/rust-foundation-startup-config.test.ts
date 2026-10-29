import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRudderAppStartupOptions } from "../app.js";
import type { Config } from "../config.js";

const startupSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

it("omits the old Node WebSocket listener when native identity owns public events", () => {
  const guard = startupSource.indexOf("if (!ingress.appOptions.rustPublicIngress?.identityAuth) {");
  const end = startupSource.indexOf("void reconcilePersistedRuntimeServicesOnStartup", guard);
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(guard);
  const legacy = startupSource.slice(guard, end);
  expect(legacy).toContain("const liveEventsRuntime = setupLiveEventsWebSocketServer(");
  expect(legacy).toContain('supervisor.own("live-events-websocket", () => liveEventsRuntime.close());');
  expect(startupSource.match(/setupLiveEventsWebSocketServer\(server,/g)).toHaveLength(1);
});

describe("Rust member directory supported startup wiring", () => {
  it("passes the required member read default without enabling D1 writers", () => {
    const config = {
      companyDeletionEnabled: true,
      rustFoundationMode: "required",
      rustOrganizationBrandingMode: "off",
      rustProjectGoalSetMode: "off",
    } as Config;

    expect(createRudderAppStartupOptions(config, "postgres://active-db", true)).toEqual({
      authReady: true,
      companyDeletionEnabled: true,
      databaseUrl: "postgres://active-db",
      rustFoundationMode: "required",
      rustOrganizationBrandingMode: "off",
      rustProjectGoalSetMode: "off",
      rustFoundationBinaryPath: undefined,
      rustFoundationActorEnvelopeKey: undefined,
    });
  });

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
