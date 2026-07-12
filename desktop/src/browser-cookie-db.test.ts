import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { deriveMacChromiumCookieKey } from "./browser-cookie-crypto-macos.js";
import { readChromiumCookieDatabase } from "./browser-cookie-db.js";

const WINDOWS_TO_UNIX_EPOCH_MICROSECONDS = 11_644_473_600_000_000n;
const tempRoots: string[] = [];

async function makeDatabase(version = 24): Promise<{ databasePath: string; database: DatabaseSync }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cookie-db-"));
  tempRoots.push(root);
  const databasePath = path.join(root, "Cookies");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta(key, value) VALUES ('version', '${version}'), ('last_compatible_version', '${version}');
    CREATE TABLE cookies(
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT X'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL DEFAULT 0,
      source_port INTEGER NOT NULL DEFAULT -1,
      last_update_utc INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { databasePath, database };
}

function encryptV10(key: Buffer, hostKey: string, value: string, version = 24): Buffer {
  const plaintext = version >= 24
    ? Buffer.concat([createHash("sha256").update(hostKey).digest(), Buffer.from(value)])
    : Buffer.from(value);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
}

function insertCookie(database: DatabaseSync, input: {
  hostKey: string;
  name: string;
  value?: string;
  encryptedValue?: Uint8Array;
  path?: string;
  expiresUtc: bigint;
  secure?: number;
  httpOnly?: number;
  hasExpires?: number;
  persistent?: number;
  sameSite?: number;
  topFrameSiteKey?: string;
  sourceScheme?: number;
  sourcePort?: number;
  lastUpdateUtc?: bigint;
}) {
  database.prepare(`
    INSERT INTO cookies(
      host_key, top_frame_site_key, name, value, encrypted_value, path,
      expires_utc, is_secure, is_httponly, has_expires, is_persistent,
      samesite, source_scheme, source_port, last_update_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.hostKey,
    input.topFrameSiteKey ?? "",
    input.name,
    input.value ?? "",
    input.encryptedValue ?? Buffer.alloc(0),
    input.path ?? "/",
    input.expiresUtc,
    input.secure ?? 1,
    input.httpOnly ?? 1,
    input.hasExpires ?? 1,
    input.persistent ?? 1,
    input.sameSite ?? 1,
    input.sourceScheme ?? 2,
    input.sourcePort ?? -1,
    input.lastUpdateUtc ?? input.expiresUtc,
  );
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Chromium Cookie database reader", () => {
  it("reads valid v24 cookies with BigInt timestamps and classifies unsafe rows", async () => {
    const now = 1_800_000_000;
    const futureUtc = WINDOWS_TO_UNIX_EPOCH_MICROSECONDS + BigInt(now + 3_601) * 1_000_000n + 999_999n;
    const expiredUtc = WINDOWS_TO_UNIX_EPOCH_MICROSECONDS + BigInt(now - 1) * 1_000_000n;
    const { databasePath, database } = await makeDatabase();
    const key = deriveMacChromiumCookieKey(Buffer.from("fixture-password"));
    const validHost = "auth.example.com";
    insertCookie(database, {
      hostKey: validHost,
      name: "session",
      encryptedValue: encryptV10(key, validHost, "signed-in"),
      expiresUtc: futureUtc,
      sameSite: 1,
    });
    insertCookie(database, {
      hostKey: ".partitioned.test",
      name: "partitioned",
      value: "value",
      expiresUtc: futureUtc,
      topFrameSiteKey: "https://top.test",
    });
    insertCookie(database, { hostKey: "expired.test", name: "expired", value: "value", expiresUtc: expiredUtc });
    insertCookie(database, { hostKey: "invalid.test", name: "same-site", value: "value", expiresUtc: futureUtc, sameSite: 99 });
    insertCookie(database, { hostKey: "invalid-bool.test", name: "secure", value: "value", expiresUtc: futureUtc, secure: 2 });
    insertCookie(database, { hostKey: "oversized.test", name: "oversized", value: "x".repeat(65_537), expiresUtc: futureUtc });
    insertCookie(database, {
      hostKey: "linux.test",
      name: "v11",
      encryptedValue: Buffer.from("v11linux-only"),
      expiresUtc: futureUtc,
    });
    insertCookie(database, {
      hostKey: "ambiguous.test",
      name: "both-values",
      value: "plain",
      encryptedValue: encryptV10(key, "ambiguous.test", "encrypted"),
      expiresUtc: futureUtc,
    });
    database.close();

    const result = readChromiumCookieDatabase({ databasePath, key, nowUnixSeconds: now });

    expect(result.cookies).toEqual([{
      hostKey: validHost,
      name: "session",
      value: "signed-in",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: now + 3_601,
      sameSite: "lax",
      sourceScheme: 2,
      sourcePort: -1,
      lastUpdateUtc: futureUtc,
    }]);
    expect(result.skippedCount).toBe(7);
    expect(result.failedCount).toBe(0);
    expect(result.errors.map((error) => error.errorCode).sort()).toEqual([
      "COOKIE_ENCRYPTION_UNSUPPORTED",
      "COOKIE_EXPIRED",
      "COOKIE_PARTITION_UNSUPPORTED",
      "COOKIE_ROW_INVALID",
      "COOKIE_ROW_INVALID",
      "COOKIE_SAMESITE_INVALID",
      "COOKIE_VALUE_AMBIGUOUS",
    ].sort());
    key.fill(0);
  });

  it("counts decrypt and v24 host-hash failures without exposing row identity", async () => {
    const now = 1_800_000_000;
    const futureUtc = WINDOWS_TO_UNIX_EPOCH_MICROSECONDS + BigInt(now + 60) * 1_000_000n;
    const { databasePath, database } = await makeDatabase();
    const key = deriveMacChromiumCookieKey(Buffer.from("fixture-password"));
    insertCookie(database, {
      hostKey: "wrong-host.test",
      name: "secret-cookie-name",
      encryptedValue: encryptV10(key, "original-host.test", "secret-value"),
      expiresUtc: futureUtc,
    });
    database.close();

    const result = readChromiumCookieDatabase({ databasePath, key, nowUnixSeconds: now });
    expect(result.cookies).toEqual([]);
    expect(result.failedCount).toBe(1);
    expect(result.errors).toEqual([{
      errorCode: "COOKIE_HOST_HASH_MISMATCH",
      message: "A cookie could not be verified and was not imported.",
    }]);
    expect(JSON.stringify(result)).not.toContain("wrong-host.test");
    expect(JSON.stringify(result)).not.toContain("secret-cookie-name");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    key.fill(0);
  });

  it("fails closed for future database versions", async () => {
    const { databasePath, database } = await makeDatabase(25);
    database.close();
    expect(() => readChromiumCookieDatabase({ databasePath, key: null, nowUnixSeconds: 0 }))
      .toThrow("Unsupported Chromium Cookie database version");
  });

  it("classifies Linux v11 as unsupported before requesting a macOS key", async () => {
    const now = 1_800_000_000;
    const futureUtc = WINDOWS_TO_UNIX_EPOCH_MICROSECONDS + BigInt(now + 60) * 1_000_000n;
    const { databasePath, database } = await makeDatabase(23);
    insertCookie(database, {
      hostKey: "linux.test",
      name: "v11",
      encryptedValue: Buffer.from("v11linux-only"),
      expiresUtc: futureUtc,
    });
    database.close();

    const result = readChromiumCookieDatabase({ databasePath, key: null, nowUnixSeconds: now });
    expect(result.failedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.errors[0]?.errorCode).toBe("COOKIE_ENCRYPTION_UNSUPPORTED");
  });
});
