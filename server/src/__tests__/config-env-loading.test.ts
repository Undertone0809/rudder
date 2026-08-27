import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function importLoadConfig() {
  vi.resetModules();
  return (await import("../config.js")).loadConfig;
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
  vi.restoreAllMocks();
  vi.unmock("../config-file.js");
});

describe("server config env loading", () => {
  it("loads the workspace-root .env when a package script runs below the repo root", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    const packageDir = path.join(projectDir, "server");
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(packageDir, { recursive: true });
    process.chdir(packageDir);

    delete process.env.DATABASE_URL;
    delete process.env.RUDDER_CONFIG;
    process.env.RUDDER_HOME = homeDir;
    process.env.RUDDER_LOCAL_ENV = "e2e";
    process.env.RUDDER_INSTANCE_ID = "e2e";

    writeText(path.join(projectDir, "pnpm-workspace.yaml"), "packages:\n  - server\n");
    writeText(
      path.join(projectDir, ".env"),
      [
        "DATABASE_URL=postgres://root-user:root-pass@db.example.com:5432/rudder",
      ].join("\n"),
    );

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.databaseUrl).toBeUndefined();
  });

  it("ignores cwd DATABASE_URL when a local env profile is active", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);

    delete process.env.DATABASE_URL;
    delete process.env.RUDDER_CONFIG;
    process.env.RUDDER_HOME = homeDir;
    process.env.RUDDER_LOCAL_ENV = "dev";
    process.env.RUDDER_INSTANCE_ID = "dev";

    writeText(path.join(projectDir, ".env"), "DATABASE_URL=postgres://cwd-user:cwd-pass@db.example.com:5432/rudder\n");
    writeJson(path.join(homeDir, "instances", "dev", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.databaseUrl).toBeUndefined();
    expect(config.databaseMode).toBe("embedded-postgres");
  });

  it("still allows the active instance env file to provide DATABASE_URL", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);

    delete process.env.DATABASE_URL;
    delete process.env.RUDDER_CONFIG;
    process.env.RUDDER_HOME = homeDir;
    process.env.RUDDER_LOCAL_ENV = "prod_local";
    process.env.RUDDER_INSTANCE_ID = "default";

    writeText(path.join(projectDir, ".env"), "DATABASE_URL=postgres://cwd-user:cwd-pass@db.example.com:5432/rudder\n");
    writeText(
      path.join(homeDir, "instances", "default", ".env"),
      "DATABASE_URL=postgres://instance-user:instance-pass@db.example.com:6543/rudder\n",
    );

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.databaseUrl).toBe("postgres://instance-user:instance-pass@db.example.com:6543/rudder");
  });

  it("keeps loading cwd DATABASE_URL when no local env profile is active", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);

    delete process.env.DATABASE_URL;
    delete process.env.RUDDER_CONFIG;
    delete process.env.RUDDER_LOCAL_ENV;
    delete process.env.RUDDER_INSTANCE_ID;
    process.env.RUDDER_HOME = homeDir;

    writeText(path.join(projectDir, ".env"), "DATABASE_URL=postgres://cwd-user:cwd-pass@db.example.com:5432/rudder\n");

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.databaseUrl).toBe("postgres://cwd-user:cwd-pass@db.example.com:5432/rudder");
  });

  it("defaults automatic database backup guard to 256 MiB", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    writeText(path.join(projectDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");

    delete process.env.RUDDER_CONFIG;
    delete process.env.RUDDER_DB_BACKUP_MAX_ESTIMATED_BYTES;
    vi.doMock("../config-file.js", () => ({
      readConfigFile: () => ({
        $meta: {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "configure",
        },
        database: {
          mode: "embedded-postgres",
          embeddedPostgresPort: 54329,
          backup: {
            enabled: true,
            intervalMinutes: 60,
            retentionDays: 30,
            dir: "~/.rudder/instances/default/data/backups",
          },
        },
        logging: {},
        server: {},
      }),
    }));

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.databaseBackupMaxEstimatedBytes).toBe(256 * 1024 * 1024);
  });

  it("lets env vars override the database backup guard size", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    writeText(path.join(projectDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");

    delete process.env.RUDDER_CONFIG;
    process.env.RUDDER_DB_BACKUP_MAX_ESTIMATED_BYTES = "384MiB";
    vi.doMock("../config-file.js", () => ({
      readConfigFile: () => ({
        $meta: {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "configure",
        },
        database: {
          mode: "embedded-postgres",
          embeddedPostgresPort: 54329,
          backup: {
            enabled: true,
            intervalMinutes: 60,
            retentionDays: 30,
            maxEstimatedBytes: 128,
            dir: "~/.rudder/instances/default/data/backups",
          },
        },
        logging: {},
        server: {},
      }),
    }));

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.databaseBackupMaxEstimatedBytes).toBe(384 * 1024 * 1024);
  });

  it("disables the absolute Agent Run duration limit by default", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    process.chdir(tempDir);
    writeText(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    delete process.env.HEARTBEAT_RUN_TIMEOUT_MS;

    const loadConfig = await importLoadConfig();

    expect(loadConfig().heartbeatRunTimeoutMs).toBe(0);
  });

  it("allows deployments to opt into an absolute Agent Run duration limit", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    process.chdir(tempDir);
    writeText(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    process.env.HEARTBEAT_RUN_TIMEOUT_MS = "21600000";

    const loadConfig = await importLoadConfig();

    expect(loadConfig().heartbeatRunTimeoutMs).toBe(6 * 60 * 60 * 1000);
  });

  it("accepts a dedicated HTTPS workspace preview origin", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    process.chdir(tempDir);
    writeText(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    process.env.RUDDER_WORKSPACE_PREVIEW_ORIGIN = "https://preview.rudder.example";

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.workspacePreviewOrigin).toBe("https://preview.rudder.example");
  });

  it("accepts an IPv6 loopback workspace preview origin", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    process.chdir(tempDir);
    writeText(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    process.env.RUDDER_WORKSPACE_PREVIEW_ORIGIN = "http://[::1]:3100";

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.workspacePreviewOrigin).toBe("http://[::1]:3100");
  });

  it("rejects an insecure non-loopback workspace preview origin", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    process.chdir(tempDir);
    writeText(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    process.env.RUDDER_WORKSPACE_PREVIEW_ORIGIN = "http://preview.rudder.example";

    const loadConfig = await importLoadConfig();

    expect(() => loadConfig()).toThrow("must use https outside loopback development");
  });
});
