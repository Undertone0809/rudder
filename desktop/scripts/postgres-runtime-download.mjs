import { createWriteStream } from "node:fs";
import { copyFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const RETRYABLE_HTTP_STATUS = new Set([403, 429, 500, 502, 503, 504]);

function resolvePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTimeoutMs(value) {
  return resolvePositiveInteger(
    value ?? process.env.RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
  );
}

export async function downloadPostgresRuntimeArchive(url, targetPath, options = {}) {
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), targetPath);
    return;
  }

  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const maxAttempts = resolvePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = resolvePositiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = true;

    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "user-agent": "Rudder-PostgreSQL-Runtime/1.0" },
      });
      if (!response.ok) {
        retryable = RETRYABLE_HTTP_STATUS.has(response.status);
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error("PostgreSQL runtime archive response has no body");
      }

      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(targetPath),
        { signal: controller.signal },
      );
      return;
    } catch (error) {
      const finalError = controller.signal.aborted
        ? new Error(`timed out downloading ${url} after ${timeoutMs}ms`, { cause: error })
        : error;
      if (attempt === maxAttempts || !retryable) throw finalError;
      lastError = finalError;
      const delayMs = retryDelayMs * attempt;
      console.error(`[postgres-runtime] download attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms: ${finalError.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error(`failed to download ${url}`);
}
