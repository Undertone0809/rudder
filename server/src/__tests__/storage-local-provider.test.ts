import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("local disk storage provider", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("round-trips bytes through storage service", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const content = Buffer.from("hello image bytes", "utf8");
    const stored = await service.putFile({
      orgId: "organization-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: content,
    });

    const fetched = await service.getObject("organization-1", stored.objectKey);
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("hello image bytes");
    expect(stored.sha256).toHaveLength(64);
  });

  it("blocks cross-organization object access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      orgId: "organization-a",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await expect(service.getObject("organization-b", stored.objectKey)).rejects.toMatchObject({ status: 403 });
  });

  it("delete is idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      orgId: "organization-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await service.deleteObject("organization-1", stored.objectKey);
    await service.deleteObject("organization-1", stored.objectKey);
    await expect(service.getObject("organization-1", stored.objectKey)).rejects.toMatchObject({ status: 404 });
  });
});
