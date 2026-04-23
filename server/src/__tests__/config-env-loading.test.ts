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

function clearLangfuseEnv() {
  delete process.env.LANGFUSE_ENABLED;
  delete process.env.LANGFUSE_BASE_URL;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_ENVIRONMENT;
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
    clearLangfuseEnv();
    process.env.RUDDER_HOME = homeDir;
    process.env.RUDDER_LOCAL_ENV = "e2e";
    process.env.RUDDER_INSTANCE_ID = "e2e";

    writeText(path.join(projectDir, "pnpm-workspace.yaml"), "packages:\n  - server\n");
    writeText(
      path.join(projectDir, ".env"),
      [
        "DATABASE_URL=postgres://root-user:root-pass@db.example.com:5432/rudder",
        "LANGFUSE_ENABLED=true",
        "LANGFUSE_BASE_URL=http://localhost:3000",
        "LANGFUSE_PUBLIC_KEY=pk-lf-root",
        "LANGFUSE_SECRET_KEY=sk-lf-root",
        "LANGFUSE_ENVIRONMENT=local",
      ].join("\n"),
    );

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.databaseUrl).toBeUndefined();
    expect(config.langfuse).toMatchObject({
      enabled: true,
      baseUrl: "http://localhost:3000",
      publicKey: "pk-lf-root",
      secretKey: "sk-lf-root",
      environment: "prod",
    });
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

  it("loads Langfuse values from config.json when env vars are absent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    writeText(path.join(projectDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");

    delete process.env.RUDDER_CONFIG;
    delete process.env.LANGFUSE_ENABLED;
    delete process.env.LANGFUSE_BASE_URL;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_ENVIRONMENT;
    process.env.RUDDER_LOCAL_ENV = "prod_local";
    process.env.RUDDER_INSTANCE_ID = "default";
    vi.doMock("../config-file.js", () => ({
      readConfigFile: () => ({
        $meta: {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "configure",
        },
        database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
        logging: {},
        server: {},
        auth: { baseUrlMode: "auto", disableSignUp: false },
        storage: {
          provider: "local_disk",
          localDisk: { baseDir: "~/.rudder/instances/default/data/storage" },
          s3: { bucket: "rudder", region: "us-east-1", prefix: "", forcePathStyle: false },
        },
        secrets: {
          provider: "local_encrypted",
          strictMode: false,
          localEncrypted: { keyFilePath: "~/.rudder/instances/default/secrets/master.key" },
        },
        langfuse: {
          enabled: true,
          baseUrl: "https://us.cloud.langfuse.com",
          publicKey: "pk-lf-config",
          secretKey: "sk-lf-config",
          environment: "local",
        },
      }),
    }));

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.langfuse).toMatchObject({
      enabled: true,
      baseUrl: "https://us.cloud.langfuse.com",
      publicKey: "pk-lf-config",
      secretKey: "sk-lf-config",
      environment: "prod",
    });
  });

  it("lets env vars override langfuse values from config.json", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-config-env-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    writeText(path.join(projectDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");

    delete process.env.RUDDER_CONFIG;
    process.env.RUDDER_LOCAL_ENV = "prod_local";
    process.env.RUDDER_INSTANCE_ID = "default";
    process.env.LANGFUSE_ENABLED = "true";
    process.env.LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-env";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-env";
    process.env.LANGFUSE_ENVIRONMENT = "default";
    vi.doMock("../config-file.js", () => ({
      readConfigFile: () => ({
        $meta: {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "configure",
        },
        database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
        logging: {},
        server: {},
        auth: { baseUrlMode: "auto", disableSignUp: false },
        storage: {
          provider: "local_disk",
          localDisk: { baseDir: "~/.rudder/instances/default/data/storage" },
          s3: { bucket: "rudder", region: "us-east-1", prefix: "", forcePathStyle: false },
        },
        secrets: {
          provider: "local_encrypted",
          strictMode: false,
          localEncrypted: { keyFilePath: "~/.rudder/instances/default/secrets/master.key" },
        },
        langfuse: {
          enabled: false,
          baseUrl: "https://self-hosted.example.com",
          publicKey: "pk-lf-config",
          secretKey: "sk-lf-config",
          environment: "dev",
        },
      }),
    }));

    const loadConfig = await importLoadConfig();
    const config = loadConfig();

    expect(config.langfuse).toMatchObject({
      enabled: true,
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-lf-env",
      secretKey: "sk-lf-env",
      environment: "prod",
    });
  });
});
