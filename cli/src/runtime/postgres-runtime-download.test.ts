import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadRuntimePostgresArchive } from "./postgres-runtime-download.js";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function responseFor(body: ReadableStream<Uint8Array>, contentLength?: string | number): Response {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers,
    body,
  } as unknown as Response;
}

function readableBody(contents: string, error?: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(contents));
      if (error) controller.error(error);
      else controller.close();
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("PostgreSQL runtime archive download", () => {
  it("rejects an override without an expected digest before fetching", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-digest-required-"));
    roots.push(root);
    const fetchImpl = vi.fn();

    await expect(downloadRuntimePostgresArchive(
      "https://token@example.test/archive.zip?secret=redacted",
      path.join(root, "target.zip"),
      null,
      { fetchImpl: fetchImpl as never },
    )).rejects.toThrow("SHA-256 digest is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("verifies a matching trusted digest and publishes the complete file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-match-"));
    roots.push(root);
    const source = path.join(root, "source.zip");
    const target = path.join(root, "target.zip");
    const contents = "trusted archive";
    await fs.writeFile(source, contents, "utf8");

    await downloadRuntimePostgresArchive(
      new URL(`file://${source}`).toString(),
      target,
      sha256(contents),
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe(contents);
  });

  it("rejects a digest mismatch without replacing the existing archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-mismatch-"));
    roots.push(root);
    const source = path.join(root, "source.zip");
    const target = path.join(root, "target.zip");
    await fs.writeFile(source, "tampered archive", "utf8");
    await fs.writeFile(target, "previous archive", "utf8");

    await expect(downloadRuntimePostgresArchive(
      new URL(`file://${source}`).toString(),
      target,
      sha256("different archive"),
    )).rejects.toThrow("SHA-256 mismatch");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("previous archive");
    await expect(fs.readdir(root)).resolves.toEqual(["source.zip", "target.zip"]);
  });

  it("rejects a content-length larger than the hard limit before streaming", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-content-length-"));
    roots.push(root);
    const target = path.join(root, "target.zip");
    const fetchImpl = vi.fn(async () => responseFor(readableBody("archive"), 5));

    await expect(downloadRuntimePostgresArchive(
      "https://example.test/archive.zip",
      target,
      sha256("archive"),
      { maxBytes: 4, fetchImpl: fetchImpl as never },
    )).rejects.toThrow("exceeds 4 bytes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects a response stream that exceeds the hard limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-byte-limit-"));
    roots.push(root);
    const target = path.join(root, "target.zip");

    await expect(downloadRuntimePostgresArchive(
      "https://example.test/archive.zip",
      target,
      sha256("12345"),
      { maxBytes: 4, fetchImpl: async () => responseFor(readableBody("12345")) },
    )).rejects.toThrow("exceeds 4 bytes");
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects a truncated response without publishing a partial archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-truncated-"));
    roots.push(root);
    const target = path.join(root, "target.zip");
    const contents = "short";

    await expect(downloadRuntimePostgresArchive(
      "https://example.test/archive.zip",
      target,
      sha256(contents),
      { fetchImpl: async () => responseFor(readableBody(contents), 10) },
    )).rejects.toThrow("truncated");
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects an invalid content-length without leaking the URL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-invalid-length-"));
    roots.push(root);
    const target = path.join(root, "target.zip");
    const privateUrl = "https://token@example.test/archive.zip?secret=redacted";
    const error = await downloadRuntimePostgresArchive(
      privateUrl,
      target,
      sha256("archive"),
      { fetchImpl: async () => responseFor(readableBody("archive"), "not-a-length") },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid content-length");
    expect((error as Error).message).not.toContain(privateUrl);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("aborts a stalled file archive copy and removes its partial output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-timeout-"));
    roots.push(root);
    const source = path.join(root, "source.zip");
    const target = path.join(root, "target.zip");
    await fs.writeFile(source, "source exists", "utf8");
    const stalled = new Readable({ read() {} });

    await expect(downloadRuntimePostgresArchive(
      new URL(`file://${source}`).toString(),
      target,
      "0".repeat(64),
      {
        timeoutMs: 20,
        createReadStreamImpl: (() => stalled) as never,
      },
    )).rejects.toThrow("timed out after 20ms");
    expect(stalled.destroyed).toBe(true);
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.readdir(root)).resolves.toEqual(["source.zip"]);
  });
});
