import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { syncDirectory, syncFileHandle } from "../../file-system-durability.js";
import { buildCodexByteTimeline, reconstructCodexByteTimeline, type CodexByteTimeline } from "./native-transcript-coverage.js";
import type { CodexTimelineShadowInput, CodexTimelineShadowResult } from "./transcript-object-store.js";

// Use the authoritative store primitives, including the original payload lock.
interface ShadowStoreDependencies {
  root: string;
  objectPaths: (root: string, objectRef: string) => {
    root: string; ref: string; metadataPath: string; payloadPath: string;
  };
  parseStoredObjectMetadata: (value: unknown) => {
    objectRef: string; orgId: string; runId: string; spanId: string;
    sourceOwnerHash: string; state: "open" | "sealed"; bytes: number; entryCount: number;
    encoding?: string;
  };
  ownerTokenSha256: (ownerToken: string) => string;
  withObjectLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
}

export function createCodexTimelineShadowStore({
  root, objectPaths, parseStoredObjectMetadata, ownerTokenSha256, withObjectLock,
}: ShadowStoreDependencies) {
  const shadowFailure = (reason: string): CodexTimelineShadowResult => ({ ok: false, reason, authorizesOldObjectDelete: false });
  const shadowPaths = (objectRef: string) => {
    const paths = objectPaths(root, objectRef);
    const shadows = path.join(paths.root, "codex-timeline-shadows");
    return { ...paths, shadows, published: path.join(shadows, paths.ref) };
  };
  // Shadow paths only. Never stat a path then reopen it: a FIFO/symlink swap
  // must fail without blocking, and all bounds/data checks use the SAME FD.
  async function readShadowFile(filePath: string, maximum: number) {
    const file = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > maximum) throw new Error("shadow_file_bounds");
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat();
      if (length > maximum || length !== before.size || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("shadow_file_changed");
      return buffer.subarray(0, length);
    } finally { await file.close(); }
  }
  async function readShadowOriginal(input: CodexTimelineShadowInput) {
    const paths = shadowPaths(input.objectRef);
    const metadata = parseStoredObjectMetadata(JSON.parse((await readShadowFile(paths.metadataPath, 128 * 1024)).toString("utf8")));
    if (metadata.objectRef !== paths.ref || metadata.orgId !== input.identity.orgId
      || metadata.runId !== input.identity.runId || metadata.spanId !== input.identity.spanId
      || metadata.sourceOwnerHash !== ownerTokenSha256(input.identity.ownerToken)) throw new Error("shadow_original_identity");
    if (metadata.state !== "sealed" || metadata.bytes > 2 * 1024 * 1024 || metadata.entryCount > 256) throw new Error("shadow_original_not_bounded_sealed");
    if (metadata.encoding) throw new Error("shadow_compact_already_selfcontained");
    const bytes = await readShadowFile(paths.payloadPath, 2 * 1024 * 1024);
    if (bytes.length !== metadata.bytes) throw new Error("shadow_original_byte_count");
    return { paths, metadata, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async function compareShadow(input: CodexTimelineShadowInput): Promise<CodexTimelineShadowResult> {
    try {
      const paths = shadowPaths(input.objectRef);
      const parent = await fs.lstat(paths.shadows).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!parent) return shadowFailure("shadow_not_present");
      if (!parent.isDirectory() || parent.isSymbolicLink()) return shadowFailure("shadow_directory_invalid");
      const published = await fs.lstat(paths.published).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!published) return shadowFailure("shadow_not_present");
      const original = await readShadowOriginal(input);
      const directory = await fs.lstat(original.paths.published);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return shadowFailure("shadow_directory_invalid");
      const manifestPath = path.join(original.paths.published, "manifest.json");
      const residualPath = path.join(original.paths.published, "residual.bin");
      const manifest = await readShadowFile(manifestPath, 128 * 1024);
      const residualBytes = await readShadowFile(residualPath, 2 * 1024 * 1024);
      const timeline = { ...JSON.parse(manifest.toString("utf8")), residualBytes } as CodexByteTimeline;
      const reconstructed = reconstructCodexByteTimeline({ expected: input.identity,
        expectedObject: { objectRef: input.objectRef, sha256: original.sha256 }, native: input.native, timeline });
      if (!reconstructed.ok) return reconstructed;
      if (!Buffer.from(reconstructed.bytes).equals(original.bytes)) return shadowFailure("shadow_original_byte_mismatch");
      return { ok: true, originalSha256: original.sha256, reconstructedSha256: reconstructed.sha256,
        manifestSha256: createHash("sha256").update(manifest).digest("hex"),
        residualSha256: timeline.residualSha256, originalBytes: original.bytes.byteLength,
        residualBytes: residualBytes.byteLength, authorizesOldObjectDelete: false };
    } catch {
      return shadowFailure("shadow_missing_or_invalid");
    }
  }

  async function withShadowLock<T>(objectRef: string, operation: (
    write: (input: CodexTimelineShadowInput & { beforePublish: () => Promise<boolean> }) => Promise<CodexTimelineShadowResult>,
  ) => Promise<T>): Promise<T> {
    const paths = shadowPaths(objectRef);
    return withObjectLock(paths.payloadPath, async () => {
      let active = true;
      let writing: Promise<CodexTimelineShadowResult> | undefined;
      try {
        return await operation(async input => {
          if (!active || writing || input.objectRef !== objectRef) return shadowFailure("shadow_lock_scope_invalid");
          writing = writeShadowLocked(input);
          return writing;
        });
      } finally {
        active = false;
        if (writing) await writing; // Do not release ownership around a detached in-flight write.
      }
    });
  }
  async function writeShadow(input: CodexTimelineShadowInput & { beforePublish: () => Promise<boolean> }): Promise<CodexTimelineShadowResult> {
    return withShadowLock(input.objectRef, write => write(input));
  }
  async function writeShadowLocked(input: CodexTimelineShadowInput & { beforePublish: () => Promise<boolean> }): Promise<CodexTimelineShadowResult> {
    const paths = shadowPaths(input.objectRef);
      try {
        const original = await readShadowOriginal(input);
        const built = buildCodexByteTimeline({ expected: input.identity,
          supplement: { identity: input.identity, objectRef: input.objectRef, bytes: original.bytes,
            sha256: original.sha256, entryCount: original.metadata.entryCount, state: "sealed" }, native: input.native });
        if (!built.ok) return built;
        // Never replace a published shadow. Existing corruption/drift is evidence,
        // not an invitation to repair automatically or fall back to deletion.
        const existing = await fs.lstat(paths.published).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (existing) return compareShadow(input);
        await fs.mkdir(paths.shadows, { recursive: true, mode: 0o700 });
        const parent = await fs.lstat(paths.shadows);
        if (!parent.isDirectory() || parent.isSymbolicLink()) return shadowFailure("shadow_directory_invalid");
        const { residualBytes, ...metadata } = built.timeline;
        const manifest = Buffer.from(JSON.stringify(metadata));
        if (manifest.byteLength > 128 * 1024) return shadowFailure("shadow_manifest_bounds");
        const stage = await fs.mkdtemp(path.join(paths.shadows, ".pending-"));
        for (const [name, bytes] of [["residual.bin", residualBytes], ["manifest.json", manifest]] as const) {
          const file = await fs.open(path.join(stage, name), "wx", 0o600);
          try { await file.writeFile(bytes); await syncFileHandle(file); } finally { await file.close(); }
        }
        await syncDirectory(stage);
        // Caller holds Run retention advisory lock and row locks. Revalidate
        // owner/attempt/native snapshot after fsync, before atomic visibility.
        if (!await input.beforePublish()) return shadowFailure("shadow_publication_fence_changed");
        const current = await readShadowOriginal(input);
        if (current.sha256 !== original.sha256) return shadowFailure("shadow_original_changed");
        await fs.rename(stage, paths.published);
        await syncDirectory(paths.shadows);
        return compareShadow(input);
      } catch {
        // Keep unpublished files for evidence; no remove/stage/purge operation.
        return shadowFailure("shadow_persistence_failed");
      }
  }

  return { writeShadow, compareShadow, withShadowLock };
}
