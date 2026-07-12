import { DatabaseSync, type StatementSync } from "node:sqlite";
import { decryptMacChromiumCookie } from "./browser-cookie-crypto-macos.js";

const WINDOWS_TO_UNIX_EPOCH_MICROSECONDS = 11_644_473_600_000_000n;
const MICROSECONDS_PER_SECOND = 1_000_000n;
const MIN_SUPPORTED_COOKIE_DB_VERSION = 10;
const MAX_SUPPORTED_COOKIE_DB_VERSION = 24;
const MAX_COOKIE_ROWS = 100_000;
const MAX_REPORTED_ERRORS = 20;
const MAX_COOKIE_VALUE_BYTES = 64 * 1024;

export type ImportedChromiumCookie = {
  hostKey: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  sourceScheme: number;
  sourcePort: number;
  lastUpdateUtc: bigint;
};

export type BrowserImportError = {
  errorCode: string;
  message: string;
};

export type ChromiumCookieDatabaseResult = {
  cookies: ImportedChromiumCookie[];
  skippedCount: number;
  failedCount: number;
  errors: BrowserImportError[];
};

type CookieRow = Record<string, unknown>;

const ERROR_MESSAGES: Record<string, string> = {
  COOKIE_PARTITION_UNSUPPORTED: "A partitioned cookie is not supported by this version of Rudder.",
  COOKIE_EXPIRED: "An expired cookie was skipped.",
  COOKIE_SAMESITE_INVALID: "A cookie had an invalid SameSite policy and was skipped.",
  COOKIE_ENCRYPTION_UNSUPPORTED: "A cookie used an unsupported encryption format and was skipped.",
  COOKIE_VALUE_AMBIGUOUS: "A cookie contained conflicting values and was skipped.",
  COOKIE_DECRYPT_FAILED: "A cookie could not be decrypted and was not imported.",
  COOKIE_HOST_HASH_MISMATCH: "A cookie could not be verified and was not imported.",
  COOKIE_VALUE_INVALID: "A cookie value was invalid and was not imported.",
  COOKIE_KEY_UNAVAILABLE: "Encrypted cookies could not be read because browser key access was unavailable.",
  COOKIE_ROW_INVALID: "An invalid cookie row was skipped.",
};

function readInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function readDatabaseVersion(database: DatabaseSync): number {
  const statement = database.prepare("SELECT key, value FROM meta WHERE key IN ('version', 'last_compatible_version', 'compatible_version')");
  const values = new Map<string, number>();
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    const parsed = readInteger(row.value);
    if (typeof row.key === "string" && parsed !== null && parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) {
      values.set(row.key, Number(parsed));
    }
  }
  const version = values.get("version");
  const compatibleVersion = values.get("last_compatible_version") ?? values.get("compatible_version") ?? version;
  if (version === undefined || compatibleVersion === undefined
    || version < MIN_SUPPORTED_COOKIE_DB_VERSION
    || version > MAX_SUPPORTED_COOKIE_DB_VERSION
    || compatibleVersion > MAX_SUPPORTED_COOKIE_DB_VERSION) {
    throw new Error("Unsupported Chromium Cookie database version.");
  }
  return version;
}

function cookieSelectStatement(database: DatabaseSync): StatementSync {
  const tableInfo = database.prepare("PRAGMA table_info(cookies)").all() as Array<Record<string, unknown>>;
  const columns = new Set(tableInfo.map((row) => row.name).filter((name): name is string => typeof name === "string"));
  const required = [
    "host_key",
    "name",
    "value",
    "encrypted_value",
    "path",
    "expires_utc",
    "is_secure",
    "is_httponly",
    "samesite",
  ];
  if (required.some((column) => !columns.has(column))) {
    throw new Error("Unsupported Chromium Cookie database schema.");
  }
  const optional = (column: string, fallback: string) => columns.has(column) ? column : `${fallback} AS ${column}`;
  const statement = database.prepare(`
    SELECT
      host_key, ${optional("top_frame_site_key", "''")}, name, value, encrypted_value, path,
      expires_utc, is_secure, is_httponly, ${optional("has_expires", "1")},
      ${optional("is_persistent", "1")}, samesite, ${optional("source_scheme", "0")},
      ${optional("source_port", "-1")}, ${optional("last_update_utc", "0")}
    FROM cookies
    ${columns.has("last_update_utc") ? "ORDER BY last_update_utc DESC" : ""}
  `);
  statement.setReadBigInts(true);
  return statement;
}

function readSameSite(value: bigint): ImportedChromiumCookie["sameSite"] | null {
  switch (value) {
    case -1n:
    case 3n:
      return "unspecified";
    case 0n:
      return "no_restriction";
    case 1n:
      return "lax";
    case 2n:
      return "strict";
    default:
      return null;
  }
}

function isNonEmptyBlob(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && value.byteLength > 0;
}

export function readChromiumCookieDatabase(input: {
  databasePath: string;
  key: Uint8Array | null;
  nowUnixSeconds?: number;
}): ChromiumCookieDatabaseResult {
  const result: ChromiumCookieDatabaseResult = { cookies: [], skippedCount: 0, failedCount: 0, errors: [] };
  const database = new DatabaseSync(input.databasePath, { readOnly: true, allowExtension: false });
  const report = (errorCode: string, failed = false) => {
    if (failed) result.failedCount += 1;
    else result.skippedCount += 1;
    if (result.errors.length < MAX_REPORTED_ERRORS) {
      result.errors.push({ errorCode, message: ERROR_MESSAGES[errorCode] ?? "A cookie could not be imported." });
    }
  };

  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const version = readDatabaseVersion(database);
    const statement = cookieSelectStatement(database);
    const nowUnixSeconds = input.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
    let rowCount = 0;
    for (const row of statement.iterate() as Iterable<CookieRow>) {
      rowCount += 1;
      if (rowCount > MAX_COOKIE_ROWS) throw new Error("Chromium Cookie database contains too many rows.");

      const hostKey = typeof row.host_key === "string" ? row.host_key : null;
      const name = typeof row.name === "string" ? row.name : null;
      const plainValue = typeof row.value === "string" ? row.value : null;
      const cookiePath = typeof row.path === "string" ? row.path : null;
      const topFrameSiteKey = typeof row.top_frame_site_key === "string" ? row.top_frame_site_key : null;
      const expiresUtc = readInteger(row.expires_utc);
      const secureValue = readInteger(row.is_secure);
      const httpOnlyValue = readInteger(row.is_httponly);
      const hasExpires = readInteger(row.has_expires);
      const persistent = readInteger(row.is_persistent);
      const sameSiteValue = readInteger(row.samesite);
      const sourceScheme = readInteger(row.source_scheme);
      const sourcePort = readInteger(row.source_port);
      const lastUpdateUtc = readInteger(row.last_update_utc);
      if (!hostKey || name === null || plainValue === null || !cookiePath?.startsWith("/")
        || topFrameSiteKey === null || expiresUtc === null || secureValue === null
        || httpOnlyValue === null || hasExpires === null || persistent === null
        || sameSiteValue === null || sourceScheme === null || sourcePort === null || lastUpdateUtc === null) {
        report("COOKIE_ROW_INVALID");
        continue;
      }
      if (![secureValue, httpOnlyValue, hasExpires, persistent]
        .every((value) => value === 0n || value === 1n)) {
        report("COOKIE_ROW_INVALID");
        continue;
      }
      if (topFrameSiteKey) {
        report("COOKIE_PARTITION_UNSUPPORTED");
        continue;
      }
      const encryptedValue = isNonEmptyBlob(row.encrypted_value) ? row.encrypted_value : null;
      if (Buffer.byteLength(name, "utf8") + Buffer.byteLength(plainValue, "utf8") > MAX_COOKIE_VALUE_BYTES
        || (encryptedValue?.byteLength ?? 0) > MAX_COOKIE_VALUE_BYTES) {
        report("COOKIE_ROW_INVALID");
        continue;
      }
      if (plainValue && encryptedValue) {
        report("COOKIE_VALUE_AMBIGUOUS");
        continue;
      }

      let value = plainValue;
      if (encryptedValue) {
        if (Buffer.from(encryptedValue).subarray(0, 3).toString("ascii") !== "v10") {
          report("COOKIE_ENCRYPTION_UNSUPPORTED");
          continue;
        }
        if (!input.key) {
          report("COOKIE_KEY_UNAVAILABLE", true);
          continue;
        }
        const decrypted = decryptMacChromiumCookie({
          encryptedValue,
          key: input.key,
          hostKey,
          databaseVersion: version,
        });
        if (!decrypted.ok) {
          report(decrypted.errorCode, decrypted.errorCode !== "COOKIE_ENCRYPTION_UNSUPPORTED");
          continue;
        }
        value = decrypted.value;
      }

      const sameSite = readSameSite(sameSiteValue);
      const secure = secureValue === 1n;
      if (!sameSite || (sameSite === "no_restriction" && !secure)) {
        report("COOKIE_SAMESITE_INVALID");
        continue;
      }

      let expirationDate: number | undefined;
      if (hasExpires === 1n && persistent === 1n) {
        const unixMicroseconds = expiresUtc - WINDOWS_TO_UNIX_EPOCH_MICROSECONDS;
        if (unixMicroseconds <= 0n) {
          report("COOKIE_EXPIRED");
          continue;
        }
        const unixSeconds = unixMicroseconds / MICROSECONDS_PER_SECOND;
        if (unixSeconds > BigInt(Number.MAX_SAFE_INTEGER)) {
          report("COOKIE_ROW_INVALID");
          continue;
        }
        expirationDate = Number(unixSeconds);
        if (expirationDate <= nowUnixSeconds) {
          report("COOKIE_EXPIRED");
          continue;
        }
      }

      if (sourceScheme < 0n || sourceScheme > 2n || sourcePort < -1n || sourcePort > 65_535n) {
        report("COOKIE_ROW_INVALID");
        continue;
      }
      result.cookies.push({
        hostKey,
        name,
        value,
        path: cookiePath,
        secure,
        httpOnly: httpOnlyValue === 1n,
        ...(expirationDate === undefined ? {} : { expirationDate }),
        sameSite,
        sourceScheme: Number(sourceScheme),
        sourcePort: Number(sourcePort),
        lastUpdateUtc,
      });
    }
    return result;
  } finally {
    database.close();
  }
}
