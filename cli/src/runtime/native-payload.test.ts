import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractNativePayload,
  NativePayloadError,
  nativePayloadPolicy,
  tryInstallNativePayload,
  verifyNativePayload,
} from "./native-payload.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.RUDDER_NATIVE_MODE;
  delete process.env.RUDDER_NATIVE_PAYLOAD_PATH;
  delete process.env.RUDDER_NATIVE_RUNTIME_PAYLOAD;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(mode: "success" | "accepted-failure" | "digest-mismatch") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-native-payload-ts-"));
  roots.push(root);
  const archive = path.join(root, "payload.zip");
  await fs.writeFile(archive, "payload", "utf8");
  const binary = path.join(root, "native.mjs");
  await fs.writeFile(binary, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const capability = args[0] === "payload" && args[1] === "verify" ? "payload.verify" : "payload.extract";
if (capability === "payload.verify" && ${JSON.stringify(mode)} === "digest-mismatch") {
  console.log(JSON.stringify({ ok: false, capability, protocolVersion: 1, accepted: false, fallbackSafe: true, errorCode: "sha256_mismatch" }));
  process.exit(2);
}
if (capability === "payload.extract" && ${JSON.stringify(mode)} === "accepted-failure") {
  fs.mkdirSync(args[4], { recursive: true });
  console.log(JSON.stringify({ ok: false, capability, protocolVersion: 1, accepted: true, fallbackSafe: false, errorCode: "extract_write_failed" }));
  process.exit(2);
}
if (capability === "payload.extract") fs.mkdirSync(args[4], { recursive: true });
console.log(JSON.stringify({ ok: true, capability, protocolVersion: 1, accepted: capability === "payload.extract", fallbackSafe: capability !== "payload.extract" }));
`, { mode: 0o755 });
  return { root, archive, binary };
}

describe("native runtime payload bridge", () => {
  const deadlineTestTimeoutMs = 5_000;

  it("runs verify before extraction and preserves accepted ownership", async () => {
    const f = await fixture("success");
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = f.binary;
    await expect(verifyNativePayload(f.archive, "0".repeat(64), 1024)).resolves.toMatchObject({
      capability: "payload.verify",
      accepted: false,
    });
    const staging = path.join(f.root, "staging");
    await expect(extractNativePayload(f.archive, staging, 1024)).resolves.toMatchObject({
      capability: "payload.extract",
      accepted: true,
    });
    await expect(fs.stat(staging)).resolves.toBeTruthy();
  });

  it("marks a missing binary as a pre-accept fallback-safe failure", async () => {
    const f = await fixture("success");
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = path.join(f.root, "missing");
    await expect(extractNativePayload(f.archive, path.join(f.root, "staging"), 1024)).rejects.toMatchObject({
      fallbackSafe: true,
      accepted: false,
    });
  });

  it("forbids fallback after Rust creates extraction staging", async () => {
    const f = await fixture("accepted-failure");
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = f.binary;
    const error = await extractNativePayload(f.archive, path.join(f.root, "staging"), 1024).catch((value) => value);
    expect(error).toBeInstanceOf(NativePayloadError);
    expect(error).toMatchObject({ code: "extract_write_failed", accepted: true, fallbackSafe: false });
  });

  it("honors global and capability rollback settings", () => {
    process.env.RUDDER_NATIVE_MODE = "node";
    expect(nativePayloadPolicy()).toMatchObject({ enabled: false, disabledBy: "RUDDER_NATIVE_MODE" });
    process.env.RUDDER_NATIVE_MODE = "auto";
    process.env.RUDDER_NATIVE_RUNTIME_PAYLOAD = "0";
    expect(nativePayloadPolicy()).toMatchObject({ enabled: false, disabledBy: "RUDDER_NATIVE_RUNTIME_PAYLOAD" });
  });

  it("fails closed before Node extraction when native payload is required", async () => {
    const f = await fixture("success");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = path.join(f.root, "missing");
    await expect(tryInstallNativePayload({
      archivePath: f.archive,
      extractPath: path.join(f.root, "extract"),
      publishStagingPath: path.join(f.root, "publish"),
      destinationPath: path.join(f.root, "destination"),
      maxArchiveBytes: 1024,
      preparePublish: async () => "bin/postgres",
      validatePublished: async () => undefined,
    })).rejects.toMatchObject({ fallbackSafe: true, accepted: false });
  });

  it("does not manufacture a trusted digest from the downloaded archive", async () => {
    const f = await fixture("success");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = f.binary;
    await expect(tryInstallNativePayload({
      archivePath: f.archive,
      extractPath: path.join(f.root, "extract"),
      publishStagingPath: path.join(f.root, "publish"),
      destinationPath: path.join(f.root, "destination"),
      maxArchiveBytes: 1024,
      preparePublish: async () => "bin/postgres",
      validatePublished: async () => undefined,
    })).rejects.toMatchObject({ code: "trusted_digest_unavailable", accepted: false });
  });

  it("fails closed in auto mode when the archive has no trusted digest", async () => {
    const f = await fixture("success");
    process.env.RUDDER_NATIVE_MODE = "auto";
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = f.binary;
    await expect(tryInstallNativePayload({
      archivePath: f.archive,
      extractPath: path.join(f.root, "extract"),
      publishStagingPath: path.join(f.root, "publish"),
      destinationPath: path.join(f.root, "destination"),
      maxArchiveBytes: 1024,
      preparePublish: async () => "bin/postgres",
      validatePublished: async () => undefined,
    })).rejects.toMatchObject({ code: "trusted_digest_unavailable", accepted: false });
  });

  it("fails closed on a trusted digest mismatch before Node publication", async () => {
    const f = await fixture("digest-mismatch");
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = f.binary;
    let prepared = false;
    await expect(tryInstallNativePayload({
      archivePath: f.archive,
      extractPath: path.join(f.root, "extract"),
      publishStagingPath: path.join(f.root, "publish"),
      destinationPath: path.join(f.root, "destination"),
      maxArchiveBytes: 1024,
      expectedSha256: "0".repeat(64),
      preparePublish: async () => {
        prepared = true;
        return "bin/postgres";
      },
      validatePublished: async () => undefined,
    })).rejects.toMatchObject({ code: "sha256_mismatch", accepted: false, fallbackSafe: false });
    expect(prepared).toBe(false);
    await expect(fs.stat(path.join(f.root, "destination"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts a stalled accepted prepare callback at the shared deadline", async () => {
    const f = await fixture("success");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = f.binary;
    const callback = { signal: null as AbortSignal | null };

    await expect(tryInstallNativePayload({
      archivePath: f.archive,
      extractPath: path.join(f.root, "extract"),
      publishStagingPath: path.join(f.root, "publish"),
      destinationPath: path.join(f.root, "destination"),
      maxArchiveBytes: 1024,
      expectedSha256: createHash("sha256").update("payload").digest("hex"),
      timeoutMs: deadlineTestTimeoutMs,
      preparePublish: async (_extractPath, _publishPath, context) => {
        callback.signal = context.signal;
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
        return "bin/postgres";
      },
      validatePublished: async () => undefined,
    })).rejects.toMatchObject({ code: "deadline_exceeded", accepted: true, fallbackSafe: false });

    expect(callback.signal).not.toBeNull();
    expect(callback.signal?.aborted).toBe(true);
  });

  it("does not extend the shared deadline while native staging cleanup is stalled", async () => {
    const f = await fixture("success");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_PAYLOAD_PATH = f.binary;
    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const startedAt = Date.now();

    await expect(tryInstallNativePayload({
      archivePath: f.archive,
      extractPath: path.join(f.root, "extract"),
      publishStagingPath: path.join(f.root, "publish"),
      destinationPath: path.join(f.root, "destination"),
      maxArchiveBytes: 1024,
      expectedSha256: createHash("sha256").update("payload").digest("hex"),
      timeoutMs: deadlineTestTimeoutMs,
      preparePublish: async (_extractPath, _publishPath, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
        return "bin/postgres";
      },
      validatePublished: async () => undefined,
      cleanupPublishStaging: async () => {
        markCleanupStarted();
        await new Promise<void>((resolve) => { releaseCleanup = resolve; });
      },
    })).rejects.toMatchObject({ code: "deadline_exceeded" });

    expect(Date.now() - startedAt).toBeLessThan(deadlineTestTimeoutMs + 1_000);
    await cleanupStarted;
    releaseCleanup();
  });
});
