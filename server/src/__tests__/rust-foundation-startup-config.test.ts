import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const startupSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const appCallStart = startupSource.indexOf("const appHandle = await createRudderApp");
const appCallEnd = startupSource.indexOf("\n  });", appCallStart);
const appCallSource = startupSource.slice(appCallStart, appCallEnd);

describe("Rust member directory supported startup wiring", () => {
  it("passes the active database and explicit bridge config into createRudderApp", () => {
    expect(appCallStart).toBeGreaterThanOrEqual(0);
    expect(appCallEnd).toBeGreaterThan(appCallStart);
    expect(appCallSource).toContain("databaseUrl: activeDatabaseConnectionString");
    expect(appCallSource).toContain("rustFoundationMode: config.rustFoundationMode");
    expect(appCallSource).toContain("rustFoundationBinaryPath: config.rustFoundationBinaryPath");
    expect(appCallSource).toContain("rustFoundationActorEnvelopeKey: config.rustFoundationActorEnvelopeKey");
  });
});
