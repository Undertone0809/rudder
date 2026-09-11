import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPostgresRuntimeArchive } from "./postgres-runtime-download.mjs";

const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function responseFor(body, contentLength) {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return { ok: true, status: 200, statusText: "OK", headers, body };
}

function readableBody(contents, { error } = {}) {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return;
      sent = true;
      if (contents) controller.enqueue(new TextEncoder().encode(contents));
      if (error) setTimeout(() => controller.error(error), 0);
      else controller.close();
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("PostgreSQL runtime archive download", () => {
  it("rejects an override without an expected digest before fetching", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-digest-required-"));
    roots.push(root);
    const fetchImpl = vi.fn();

    await expect(downloadPostgresRuntimeArchive("https://example.test/archive.zip", path.join(root, "archive.zip"), {
      fetchImpl,
    })).rejects.toThrow("SHA-256 digest is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a digest mismatch without publishing the archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-digest-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    await fs.writeFile(target, "previous archive");

    await expect(downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      expectedSha256: sha256("trusted archive"),
      fetchImpl: async () => responseFor(readableBody("tampered archive")),
    })).rejects.toThrow("SHA-256 mismatch");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("previous archive");
    await expect(fs.readdir(root)).resolves.toEqual(["archive.zip"]);
  });

  it("streams and verifies a response body to the target archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const contents = "archive contents";

    await downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      expectedSha256: sha256(contents),
      fetchImpl: async () => responseFor(readableBody(contents), contents.length),
    });

    await expect(fs.readFile(target, "utf8")).resolves.toBe(contents);
  });

  it("rejects a content-length larger than the hard limit before streaming", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-content-length-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const body = readableBody("archive");
    const fetchImpl = vi.fn(async () => responseFor(body, 5));

    await expect(downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      expectedSha256: sha256("archive"),
      maxBytes: 4,
      fetchImpl,
    })).rejects.toThrow("exceeds 4 bytes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects a stream that exceeds the hard byte limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-byte-limit-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");

    await expect(downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      expectedSha256: sha256("12345"),
      maxBytes: 4,
      fetchImpl: async () => responseFor(readableBody("12345")),
    })).rejects.toThrow("exceeds 4 bytes");
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects a truncated response without publishing a partial archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-truncated-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const contents = "short";

    await expect(downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      expectedSha256: sha256(contents),
      fetchImpl: async () => responseFor(readableBody(contents), 10),
    })).rejects.toThrow("truncated");
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects an invalid content-length without leaking the URL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-invalid-length-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const privateUrl = "https://token@example.test/archive.zip?secret=redacted";
    const error = await downloadPostgresRuntimeArchive(privateUrl, target, {
      expectedSha256: sha256("archive"),
      fetchImpl: async () => responseFor(readableBody("archive"), "not-a-length"),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("invalid content-length");
    expect(error.message).not.toContain(privateUrl);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("cleans a failed attempt before retrying and publishes only the verified retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-retry-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const contents = "verified retry";
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return responseFor(
        attempts === 1
          ? readableBody("partial", { error: new Error("connection reset") })
          : readableBody(contents),
      );
    });

    await downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      expectedSha256: sha256(contents),
      maxAttempts: 2,
      retryDelayMs: 1,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(fs.readFile(target, "utf8")).resolves.toBe(contents);
    await expect(fs.readdir(root)).resolves.toEqual(["archive.zip"]);
  });

  it("aborts a response body that stalls after headers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-timeout-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const body = new ReadableStream({
      start() {
        // Simulate a server that sends headers but never finishes the archive.
      },
    });

    await expect(downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      expectedSha256: "0".repeat(64),
      timeoutMs: 20,
      maxAttempts: 1,
      fetchImpl: async () => responseFor(body),
    })).rejects.toThrow("timed out downloading PostgreSQL runtime archive after 20ms");
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });
});
