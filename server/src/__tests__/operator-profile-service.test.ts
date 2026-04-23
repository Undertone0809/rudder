import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  operatorProfiles,
} from "@rudder/db";
import { eq } from "drizzle-orm";
import { operatorProfileService } from "../services/operator-profile.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-operator-profile-service-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("operatorProfileService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof operatorProfileService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = operatorProfileService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(operatorProfiles);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("creates, reads, and updates the local-board operator profile", async () => {
    await expect(svc.get("local-board")).resolves.toEqual({
      nickname: "",
      moreAboutYou: "",
    });

    await expect(
      svc.update("local-board", {
        nickname: "  Zee  ",
        moreAboutYou: "  Builds agent workflows  ",
      }),
    ).resolves.toEqual({
      nickname: "Zee",
      moreAboutYou: "Builds agent workflows",
    });

    await expect(svc.get("local-board")).resolves.toEqual({
      nickname: "Zee",
      moreAboutYou: "Builds agent workflows",
    });

    await expect(
      svc.update("local-board", {
        nickname: "Operator",
      }),
    ).resolves.toEqual({
      nickname: "Operator",
      moreAboutYou: "Builds agent workflows",
    });
  });

  it("keeps multiple authenticated users isolated from each other", async () => {
    await svc.update("user-1", {
      nickname: "Alpha",
      moreAboutYou: "First operator",
    });
    await svc.update("user-2", {
      nickname: "Beta",
      moreAboutYou: "Second operator",
    });

    await expect(svc.get("user-1")).resolves.toEqual({
      nickname: "Alpha",
      moreAboutYou: "First operator",
    });
    await expect(svc.get("user-2")).resolves.toEqual({
      nickname: "Beta",
      moreAboutYou: "Second operator",
    });
  });

  it("normalizes blank input to null at rest and empty strings in responses", async () => {
    await expect(
      svc.update("user-blank", {
        nickname: "   ",
        moreAboutYou: "\n\t",
      }),
    ).resolves.toEqual({
      nickname: "",
      moreAboutYou: "",
    });

    const row = await db
      .select()
      .from(operatorProfiles)
      .where(eq(operatorProfiles.userId, "user-blank"))
      .then((rows) => rows[0] ?? null);

    expect(row?.nickname).toBeNull();
    expect(row?.moreAboutYou).toBeNull();
    await expect(svc.get("user-blank")).resolves.toEqual({
      nickname: "",
      moreAboutYou: "",
    });
  });
});
