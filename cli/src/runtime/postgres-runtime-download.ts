import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS_ENV = "RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS";
const RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256";
const RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES";
const DEFAULT_RUNTIME_POSTGRES_ARCHIVE_MAX_BYTES = 1_024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class PostgresRuntimeArchiveDownloadError extends Error {}

function resolvePositiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function resolveExpectedSha256(trustedSha256: string | null | undefined): string {
  const expectedSha256 = (trustedSha256 ?? process.env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV])
    ?.trim().toLowerCase();
  if (!expectedSha256) {
    throw new PostgresRuntimeArchiveDownloadError(
      "PostgreSQL runtime archive SHA-256 digest is required",
    );
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new PostgresRuntimeArchiveDownloadError(
      "PostgreSQL runtime archive SHA-256 digest must be a 64-character hexadecimal value",
    );
  }
  return expectedSha256;
}

function resolveMaxBytes(configuredMaxBytes?: number): number {
  const value = configuredMaxBytes ?? process.env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES_ENV];
  return resolvePositiveInteger(value, DEFAULT_RUNTIME_POSTGRES_ARCHIVE_MAX_BYTES, DEFAULT_RUNTIME_POSTGRES_ARCHIVE_MAX_BYTES);
}

function resolveTimeoutMs(configuredTimeoutMs?: number): number {
  return resolvePositiveInteger(
    configuredTimeoutMs ?? process.env[RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS_ENV],
    600_000,
  );
}

function contentLengthFromResponse(response: Response, maxBytes: number): number | null {
  const raw = response.headers?.get("content-length")?.trim() ?? "";
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) {
    throw new PostgresRuntimeArchiveDownloadError(
      "PostgreSQL runtime archive response has an invalid content-length",
    );
  }
  const contentLength = Number(raw);
  if (!Number.isSafeInteger(contentLength)) {
    throw new PostgresRuntimeArchiveDownloadError(
      "PostgreSQL runtime archive response has an invalid content-length",
    );
  }
  if (contentLength > maxBytes) {
    throw new PostgresRuntimeArchiveDownloadError(
      `PostgreSQL runtime archive exceeds ${maxBytes} bytes`,
    );
  }
  return contentLength;
}

function digestMatches(actualHex: string, expectedSha256: string): boolean {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function cancelResponseBody(response: Response | undefined): Promise<void> {
  const body = response?.body as unknown as {
    cancel?: () => Promise<unknown>;
    destroy?: () => void;
  } | null | undefined;
  if (typeof body?.cancel === "function") {
    try {
      await body.cancel();
    } catch {
      // The stream may already be closed or locked by pipeline.
    }
  } else if (typeof body?.destroy === "function") {
    try {
      body.destroy();
    } catch {
      // The stream may already be closed.
    }
  }
}

async function streamVerifiedArchive(
  readable: NodeJS.ReadableStream,
  targetPath: string,
  options: {
    expectedSha256: string;
    expectedLength?: number | null;
    maxBytes: number;
    signal: AbortSignal;
  },
): Promise<void> {
  const temporaryPath = `${targetPath}.part-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hash = createHash("sha256");
  let bytes = 0;
  const monitor = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.byteLength > options.maxBytes - bytes) {
        callback(new PostgresRuntimeArchiveDownloadError(
          `PostgreSQL runtime archive exceeds ${options.maxBytes} bytes`,
        ));
        return;
      }
      bytes += buffer.byteLength;
      hash.update(buffer);
      callback(null, buffer);
    },
  });

  try {
    await mkdir(path.dirname(temporaryPath), { recursive: true });
    await pipeline(
      readable,
      monitor,
      createWriteStream(temporaryPath, { flags: "wx" }),
      { signal: options.signal },
    );
    if (bytes === 0) {
      throw new PostgresRuntimeArchiveDownloadError("PostgreSQL runtime archive response was empty");
    }
    if (options.expectedLength !== null && options.expectedLength !== undefined && bytes !== options.expectedLength) {
      throw new PostgresRuntimeArchiveDownloadError(
        "PostgreSQL runtime archive response was truncated or had an invalid content-length",
      );
    }
    if (!digestMatches(hash.digest("hex"), options.expectedSha256)) {
      throw new PostgresRuntimeArchiveDownloadError("PostgreSQL runtime archive SHA-256 mismatch");
    }
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (error instanceof PostgresRuntimeArchiveDownloadError) throw error;
    throw new PostgresRuntimeArchiveDownloadError("failed to stream PostgreSQL runtime archive");
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function downloadRuntimePostgresArchive(
  url: string,
  targetPath: string,
  trustedSha256?: string | null,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    fetchImpl?: typeof fetch;
    /** Test-only stream injection for deterministic timeout coverage. */
    createReadStreamImpl?: typeof createReadStream;
  } = {},
): Promise<void> {
  const expectedSha256 = resolveExpectedSha256(trustedSha256);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;

  try {
    if (url.startsWith("file://")) {
      let sourcePath: string;
      try {
        sourcePath = fileURLToPath(url);
      } catch {
        throw new PostgresRuntimeArchiveDownloadError("invalid PostgreSQL runtime archive source");
      }
      const sourceStats = await stat(sourcePath);
      if (!sourceStats.isFile()) {
        throw new PostgresRuntimeArchiveDownloadError("PostgreSQL runtime archive source is not a file");
      }
      if (sourceStats.size > maxBytes) {
        throw new PostgresRuntimeArchiveDownloadError(
          `PostgreSQL runtime archive exceeds ${maxBytes} bytes`,
        );
      }
      await streamVerifiedArchive(
        (options.createReadStreamImpl ?? createReadStream)(sourcePath),
        targetPath,
        {
          expectedSha256,
          expectedLength: sourceStats.size,
          maxBytes,
          signal: controller.signal,
        },
      );
      return;
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "Rudder-PostgreSQL-Runtime/1.0" },
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new PostgresRuntimeArchiveDownloadError(
        `failed to download PostgreSQL runtime archive (HTTP ${response.status})`,
      );
    }
    const contentLength = contentLengthFromResponse(response, maxBytes);
    if (!response.body) {
      throw new PostgresRuntimeArchiveDownloadError(
        "PostgreSQL runtime archive response has no body",
      );
    }
    await streamVerifiedArchive(
      Readable.fromWeb(response.body as never),
      targetPath,
      {
        expectedSha256,
        expectedLength: contentLength,
        maxBytes,
        signal: controller.signal,
      },
    );
  } catch (error) {
    await cancelResponseBody(response);
    if (controller.signal.aborted) {
      throw new PostgresRuntimeArchiveDownloadError(
        `PostgreSQL runtime archive download timed out after ${timeoutMs}ms`,
      );
    }
    if (error instanceof PostgresRuntimeArchiveDownloadError) throw error;
    throw new PostgresRuntimeArchiveDownloadError("failed to download PostgreSQL runtime archive");
  } finally {
    clearTimeout(timeout);
  }
}
