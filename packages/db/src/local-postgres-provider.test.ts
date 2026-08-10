import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOfficialPostgresVersion,
  buildOfficialPostgresInitdbArgs,
  buildOfficialPostgresStartArgs,
  createLocalPostgresInstance,
  resolveOfficialPostgresBinaries,
  resolveOfficialPostgresBinDir,
  RUDDER_POSTGRES_BIN_DIR_ENV,
  RUDDER_PRODUCTION_POSTGRES_VERSION,
  validateOfficialPostgresBinDir,
} from "./local-postgres-provider.js";

const originalPostgresBinDir = process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
const tempRoots: string[] = [];

function createTempDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-pg-bin-"));
  tempRoots.push(root);
  const binDir = path.join(root, "pgsql", "bin");
  mkdirSync(binDir, { recursive: true });
  return binDir;
}

function touchRequiredPostgresBinaries(binDir: string): void {
  for (const binaryPath of Object.values(resolveOfficialPostgresBinaries(binDir))) {
    writeFileSync(binaryPath, "", "utf8");
  }
}

function touchRequiredPostgresTemplate(binDir: string): void {
  const templatePath = path.join(binDir, "..", "share", "postgresql", "postgres.bki");
  mkdirSync(path.dirname(templatePath), { recursive: true });
  writeFileSync(templatePath, "postgres template", "utf8");
}

function touchCompletePostgresRuntime(binDir: string): void {
  touchRequiredPostgresBinaries(binDir);
  touchRequiredPostgresTemplate(binDir);
}

afterEach(() => {
  if (originalPostgresBinDir === undefined) {
    delete process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
  } else {
    process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = originalPostgresBinDir;
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local postgres provider", () => {
  it("pins Rudder's production embedded database provider to PostgreSQL 18.4", () => {
    expect(RUDDER_PRODUCTION_POSTGRES_VERSION).toBe("18.4");
  });

  it("resolves and validates an official PostgreSQL bin directory", () => {
    const binDir = createTempDir();
    try {
      touchCompletePostgresRuntime(binDir);

      expect(resolveOfficialPostgresBinDir(binDir)).toBe(path.resolve(binDir));
      expect(validateOfficialPostgresBinDir(binDir)).toEqual({ ok: true });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("reports missing PostgreSQL production binaries before startup", () => {
    const binDir = createTempDir();
    try {
      const validation = validateOfficialPostgresBinDir(binDir);

      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.missing).toEqual(expect.arrayContaining(Object.values(resolveOfficialPostgresBinaries(binDir))));
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("reports missing PostgreSQL initdb template files before startup", () => {
    const binDir = createTempDir();
    try {
      touchRequiredPostgresBinaries(binDir);

      const validation = validateOfficialPostgresBinDir(binDir);

      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.missing).toContain(path.join(binDir, "..", "share", "postgresql", "postgres.bki"));
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("accepts PostgreSQL 18.4 version output", async () => {
    const binDir = createTempDir();
    try {
      touchCompletePostgresRuntime(binDir);

      await expect(
        assertOfficialPostgresVersion(binDir, async () => "postgres (PostgreSQL) 18.4"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("rejects official PostgreSQL bin directories that are not 18.4", async () => {
    const binDir = createTempDir();
    try {
      touchCompletePostgresRuntime(binDir);

      await expect(
        assertOfficialPostgresVersion(binDir, async () => "postgres (PostgreSQL) 18.1"),
      ).rejects.toThrow("Expected PostgreSQL 18.4");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("checks the PostgreSQL version before selecting the official provider", async () => {
    const binDir = createTempDir();
    try {
      touchCompletePostgresRuntime(binDir);
      process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = binDir;

      await expect(
        createLocalPostgresInstance({
          databaseDir: path.join(binDir, "data"),
          user: "rudder",
          password: "rudder",
          port: 55432,
          persistent: true,
        }),
      ).rejects.toThrow("Failed to verify PostgreSQL 18.4");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("initializes official PostgreSQL clusters with password authentication", () => {
    expect(
      buildOfficialPostgresInitdbArgs(
        {
          databaseDir: "/tmp/rudder-db",
          user: "rudder",
          password: "rudder",
          port: 55432,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C"],
        },
        "/tmp/pwfile",
      ),
    ).toEqual([
      "-D",
      "/tmp/rudder-db",
      "-U",
      "rudder",
      "--auth=scram-sha-256",
      "--pwfile",
      "/tmp/pwfile",
      "--encoding=UTF8",
      "--locale=C",
    ]);
  });

  it("redirects pg_ctl startup output away from the parent process pipes", () => {
    const databaseDir = path.join("tmp", "rudder-db");

    expect(
      buildOfficialPostgresStartArgs({
        databaseDir,
        user: "rudder",
        password: "rudder",
        port: 55432,
        persistent: true,
      }),
    ).toEqual([
      "-D",
      databaseDir,
      "-l",
      path.join(databaseDir, "postgres.log"),
      "-o",
      "-h 127.0.0.1 -p 55432",
      "-w",
      "start",
    ]);
  });
});
