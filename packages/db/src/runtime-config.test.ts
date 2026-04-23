import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDatabaseTarget } from "./runtime-config.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveDatabaseTarget", () => {
  it("uses DATABASE_URL from process env first", () => {
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.example.com:5432/rudder";

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://env-user:env-pass@db.example.com:5432/rudder",
      source: "DATABASE_URL",
    });
  });

  it("uses DATABASE_URL from repo-local .rudder/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.RUDDER_CONFIG;
    writeJson(path.join(projectDir, ".rudder", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });
    writeText(
      path.join(projectDir, ".rudder", ".env"),
      'DATABASE_URL="postgres://file-user:file-pass@db.example.com:6543/rudder"\n',
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://file-user:file-pass@db.example.com:6543/rudder",
      source: "rudder-env",
    });
  });

  it("uses config postgres connection string when configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.RUDDER_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/rudder",
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/rudder",
      source: "config.database.connectionString",
    });
  });

  it("falls back to embedded postgres settings from config", () => {
    delete process.env.RUDDER_EMBEDDED_POSTGRES_PORT;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.RUDDER_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: "~/rudder-test-db",
        embeddedPostgresPort: 55444,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "rudder-test-db"),
      port: 55444,
      source: "embedded-postgres@55444",
    });
  });

  it("lets RUDDER_EMBEDDED_POSTGRES_PORT override the embedded postgres port", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.RUDDER_CONFIG = configPath;
    process.env.RUDDER_EMBEDDED_POSTGRES_PORT = "56321";
    writeJson(configPath, {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresPort: 55444,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      port: 56321,
      source: "embedded-postgres@56321",
    });
  });
});
