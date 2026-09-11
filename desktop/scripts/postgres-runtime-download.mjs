import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_024 * 1024 * 1024;
const RETRYABLE_HTTP_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BYTES_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES";
const SHA256_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256";

class ArchiveDownloadError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = "ArchiveDownloadError";
    this.retryable = retryable;
  }
}

function resolvePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function resolveTimeoutMs(value) {
  return resolvePositiveInteger(
    value ?? process.env.RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
  );
}

function resolveMaxBytes(value) {
  return resolvePositiveInteger(
    value ?? process.env[MAX_BYTES_ENV],
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_BYTES,
  );
}

function resolveExpectedSha256(options) {
  const expectedSha256 = (
    options.expectedSha256
    ?? options.expectedDigest
    ?? process.env[SHA256_ENV]
  )?.trim().toLowerCase();
  if (!expectedSha256) {
    throw new ArchiveDownloadError(
      "PostgreSQL runtime archive SHA-256 digest is required",
      { retryable: false },
    );
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new ArchiveDownloadError(
      "PostgreSQL runtime archive SHA-256 digest must be a 64-character hexadecimal value",
      { retryable: false },
    );
  }
  return expectedSha256;
}

function contentLengthFromResponse(response, maxBytes) {
  const raw = typeof response.headers?.get === "function"
    ? response.headers.get("content-length")
    : response.headers?.["content-length"];
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const normalized = String(raw).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ArchiveDownloadError(
      "PostgreSQL runtime archive response has an invalid content-length",
      { retryable: false },
    );
  }
  const contentLength = Number(normalized);
  if (!Number.isSafeInteger(contentLength)) {
    throw new ArchiveDownloadError(
      "PostgreSQL runtime archive response has an invalid content-length",
      { retryable: false },
    );
  }
  if (contentLength > maxBytes) {
    throw new ArchiveDownloadError(
      `PostgreSQL runtime archive exceeds ${maxBytes} bytes`,
      { retryable: false },
    );
  }
  return contentLength;
}

function digestMatches(actualHex, expectedSha256) {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function streamArchive(readable, targetPath, options) {
  const {
    expectedSha256,
    expectedLength = null,
    maxBytes,
    signal,
  } = options;
  const temporaryPath = `${targetPath}.part-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hash = createHash("sha256");
  let bytes = 0;
  const monitor = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.byteLength > maxBytes - bytes) {
        callback(new ArchiveDownloadError(
          `PostgreSQL runtime archive exceeds ${maxBytes} bytes`,
          { retryable: false },
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
      { signal },
    );
    if (bytes === 0) {
      throw new ArchiveDownloadError(
        "PostgreSQL runtime archive response was empty",
        { retryable: false },
      );
    }
    if (expectedLength !== null && bytes !== expectedLength) {
      throw new ArchiveDownloadError(
        "PostgreSQL runtime archive response was truncated or had an invalid content-length",
        { retryable: false },
      );
    }
    if (!digestMatches(hash.digest("hex"), expectedSha256)) {
      throw new ArchiveDownloadError(
        "PostgreSQL runtime archive SHA-256 mismatch",
        { retryable: false },
      );
    }
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (error instanceof ArchiveDownloadError) throw error;
    throw new ArchiveDownloadError("failed to stream PostgreSQL runtime archive");
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function streamFileArchive(sourcePath, targetPath, options) {
  let sourceStats;
  try {
    sourceStats = await stat(sourcePath);
  } catch {
    throw new ArchiveDownloadError("failed to read PostgreSQL runtime archive source", { retryable: false });
  }
  if (!sourceStats.isFile()) {
    throw new ArchiveDownloadError("PostgreSQL runtime archive source is not a file", { retryable: false });
  }
  if (sourceStats.size > options.maxBytes) {
    throw new ArchiveDownloadError(
      `PostgreSQL runtime archive exceeds ${options.maxBytes} bytes`,
      { retryable: false },
    );
  }
  try {
    await streamArchive(createReadStream(sourcePath), targetPath, {
      ...options,
      expectedLength: sourceStats.size,
    });
  } catch (error) {
    if (error instanceof ArchiveDownloadError) throw error;
    throw new ArchiveDownloadError("failed to read PostgreSQL runtime archive source", { retryable: false });
  }
}

async function cancelResponseBody(response) {
  const body = response?.body;
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

function safeResponseError(response) {
  const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
  return new ArchiveDownloadError(
    `failed to download PostgreSQL runtime archive (HTTP ${response.status})`,
    { retryable },
  );
}

export async function downloadPostgresRuntimeArchive(url, targetPath, options = {}) {
  const expectedSha256 = resolveExpectedSha256(options);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  if (url.startsWith("file://")) {
    let sourcePath;
    try {
      sourcePath = fileURLToPath(url);
    } catch {
      throw new ArchiveDownloadError("invalid PostgreSQL runtime archive source", { retryable: false });
    }
    await streamFileArchive(sourcePath, targetPath, { expectedSha256, maxBytes });
    return;
  }

  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const maxAttempts = resolvePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, MAX_DOWNLOAD_ATTEMPTS);
  const retryDelayMs = resolvePositiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "user-agent": "Rudder-PostgreSQL-Runtime/1.0" },
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw safeResponseError(response);
      }
      const contentLength = contentLengthFromResponse(response, maxBytes);
      if (!response.body) {
        throw new ArchiveDownloadError(
          "PostgreSQL runtime archive response has no body",
          { retryable: false },
        );
      }
      await streamArchive(Readable.fromWeb(response.body), targetPath, {
        expectedSha256,
        expectedLength: contentLength,
        maxBytes,
        signal: controller.signal,
      });
      return;
    } catch (error) {
      await cancelResponseBody(response);
      const finalError = controller.signal.aborted
        ? new ArchiveDownloadError(
          `timed out downloading PostgreSQL runtime archive after ${timeoutMs}ms`,
        )
        : error instanceof ArchiveDownloadError
          ? error
          : new ArchiveDownloadError("failed to download PostgreSQL runtime archive");
      if (attempt === maxAttempts || finalError.retryable === false) throw finalError;
      lastError = finalError;
      const delayMs = retryDelayMs * attempt;
      console.error(`[postgres-runtime] archive download attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new ArchiveDownloadError("failed to download PostgreSQL runtime archive");
}
