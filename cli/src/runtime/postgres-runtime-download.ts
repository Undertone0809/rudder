import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS_ENV = "RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS";
const RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256";
const RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES";
const DEFAULT_RUNTIME_POSTGRES_ARCHIVE_MAX_BYTES = 1_024 * 1024 * 1024;

export async function downloadRuntimePostgresArchive(
  url: string,
  targetPath: string,
  trustedSha256?: string | null,
  options: {
    timeoutMs?: number;
    /** Test-only stream injection for deterministic timeout coverage. */
    createReadStreamImpl?: typeof createReadStream;
  } = {},
): Promise<void> {
  const expectedSha256 = (trustedSha256 ?? process.env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV])
    ?.trim().toLowerCase() || null;
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(`${RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV} must be a 64-character SHA-256 digest`);
  }
  const configuredMaxBytes = Number.parseInt(process.env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES_ENV] ?? "", 10);
  const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : DEFAULT_RUNTIME_POSTGRES_ARCHIVE_MAX_BYTES;

  const parsedTimeout = Number.parseInt(
    String(options.timeoutMs ?? process.env[RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS_ENV] ?? "600000"),
    10,
  );
  const controller = new AbortController();
  const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? setTimeout(() => controller.abort(), parsedTimeout)
    : null;
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const monitor = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          callback(new Error(`PostgreSQL runtime archive exceeds ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    if (url.startsWith("file://")) {
      const readStream = (options.createReadStreamImpl ?? createReadStream)(fileURLToPath(url));
      await pipeline(readStream, monitor, createWriteStream(targetPath), { signal: controller.signal });
      if (expectedSha256) {
        const actual = hash.digest("hex");
        if (actual !== expectedSha256) throw new Error(`PostgreSQL runtime archive SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
      }
      return;
    }
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
      throw new Error(`PostgreSQL runtime archive exceeds ${maxBytes} bytes`);
    }
    if (!response.body) throw new Error("PostgreSQL runtime archive response has no body");
    await pipeline(
      Readable.fromWeb(response.body as never),
      monitor,
      createWriteStream(targetPath, { flags: "wx" }),
      { signal: controller.signal },
    );
    if (expectedSha256) {
      const actual = hash.digest("hex");
      if (actual !== expectedSha256) throw new Error(`PostgreSQL runtime archive SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`PostgreSQL runtime archive download timed out after ${parsedTimeout}ms`, { cause: error });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
