import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_BACKUP_V2_MANIFEST_PATH,
  WORKSPACE_BACKUP_V2_MAX_FILE_BYTES,
  WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES,
  createWorkspaceBackupV2,
  createWorkspaceBackupV2File,
  createWorkspaceBackupV2Native,
  inspectWorkspaceBackupV2,
  inspectWorkspaceBackupV2File,
  readWorkspaceBackupV2File,
  resolveNativeArchiveBinary,
  walkWorkspaceBackupV2,
  workspaceBackupV2NativeDiagnostic,
} from "./workspace-backup-v2.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-v2-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function fakeNative(root: string, behavior: string) {
  const script = path.join(root, "fake-native.mjs");
  await writeFile(script, `#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
const args = process.argv.slice(2);
const behavior = ${JSON.stringify(behavior)};
if (behavior === "timeout") setTimeout(() => {}, 60000);
else if (behavior === "nonzero") { console.log(JSON.stringify({ok:false,protocolVersion:1,errorCode:"source_changed"})); console.error("rudder-native: archive operation failed"); process.exit(2); }
else if (behavior === "malformed") console.log("not-json");
else if (args[1] === "capabilities") console.log(JSON.stringify(behavior === "capability" ? {ok:true,protocolVersion:1,capabilities:[]} : behavior === "protocol" ? {ok:true,protocolVersion:9,capabilities:["archive.create"]} : {ok:true,protocolVersion:1,capabilities:["archive.create"]}));
else {
  const plan = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const output = args[3];
  const source = process.env.RUDDER_TEST_NATIVE_ARCHIVE;
  fs.copyFileSync(source, output);
  const bytes = fs.readFileSync(output);
  const manifest = fs.readFileSync(plan.manifestSource);
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  console.log(JSON.stringify({ok:true,operation:"create",protocolVersion:1,byteSize:bytes.length,sha256:behavior === "hash" ? "0".repeat(64) : hash(bytes),manifestSha256:hash(manifest),treeSha256:plan.treeSha256}));
}
`);
  await chmod(script, 0o755);
  return script;
}

describe("workspace backup v2 comparator", () => {
  it("resolves explicit, dev, compiled, and packaged native locations in order", async () => {
    const previousPath = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
    const previousResources = process.env.RUDDER_DESKTOP_RESOURCES_PATH;
    try {
      process.env.RUDDER_NATIVE_ARCHIVE_PATH = "/tmp/explicit-rudder-native";
      expect(resolveNativeArchiveBinary()).toBe(path.resolve("/tmp/explicit-rudder-native"));
      delete process.env.RUDDER_NATIVE_ARCHIVE_PATH;
      process.env.RUDDER_DESKTOP_RESOURCES_PATH = "/tmp/rudder-resources";
      expect(resolveNativeArchiveBinary()).toContain(path.join("native", "target", "debug", process.platform === "win32" ? "rudder-native.exe" : "rudder-native"));
    } finally {
      if (previousPath === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH; else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousPath;
      if (previousResources === undefined) delete process.env.RUDDER_DESKTOP_RESOURCES_PATH; else process.env.RUDDER_DESKTOP_RESOURCES_PATH = previousResources;
    }
  });

  it.each([
    ["capability", "capability", "create_unavailable"],
    ["protocol", "protocol", "version_mismatch"],
    ["malformed", "protocol", "malformed_json"],
    ["nonzero", "process", "source_changed"],
    ["hash", "integrity", "output_mismatch"],
    ["timeout", "timeout", "process_timeout"],
  ])("returns bounded structured diagnostics for native %s failures", async (behavior, category, code) => {
    const f = await fixture();
    const previousPath = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
    const previousArchive = process.env.RUDDER_TEST_NATIVE_ARCHIVE;
    const previousTimeout = process.env.RUDDER_NATIVE_ARCHIVE_TIMEOUT_MS;
    try {
      await writeFile(path.join(f.root, "file.txt"), "content");
      const comparator = await createWorkspaceBackupV2({ rootPath: f.root, orgId: "org", instanceId: "instance" });
      const comparatorPath = path.join(f.root, "comparator.zip");
      await writeFile(comparatorPath, comparator.archive);
      process.env.RUDDER_NATIVE_ARCHIVE_PATH = await fakeNative(f.root, behavior);
      process.env.RUDDER_TEST_NATIVE_ARCHIVE = comparatorPath;
      process.env.RUDDER_NATIVE_ARCHIVE_TIMEOUT_MS = behavior === "timeout" ? "25" : "2000";
      const output = path.join(f.root, "native-output.zip");
      let caught: unknown;
      try {
        await createWorkspaceBackupV2Native({ rootPath: f.root, orgId: "org", instanceId: "instance", artifactPath: output });
      } catch (error) { caught = error; }
      expect(workspaceBackupV2NativeDiagnostic(caught)).toMatchObject({ category, code, fallbackAllowed: true });
      expect(workspaceBackupV2NativeDiagnostic(caught).detail.length).toBeLessThanOrEqual(180);
      await expect(readFile(output)).rejects.toThrow();
      expect((await readdir(f.root)).filter((entry) => entry.startsWith(".rudder-native-archive-"))).toEqual([]);
    } finally {
      if (previousPath === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH; else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousPath;
      if (previousArchive === undefined) delete process.env.RUDDER_TEST_NATIVE_ARCHIVE; else process.env.RUDDER_TEST_NATIVE_ARCHIVE = previousArchive;
      if (previousTimeout === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_TIMEOUT_MS; else process.env.RUDDER_NATIVE_ARCHIVE_TIMEOUT_MS = previousTimeout;
      await f.dispose();
    }
  });

  it("blocks fallback when the final native destination already exists", async () => {
    const f = await fixture();
    const previousPath = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
    const previousArchive = process.env.RUDDER_TEST_NATIVE_ARCHIVE;
    try {
      await writeFile(path.join(f.root, "file.txt"), "content");
      const comparator = await createWorkspaceBackupV2({ rootPath: f.root, orgId: "org", instanceId: "instance" });
      const comparatorPath = path.join(f.root, "comparator.zip");
      await writeFile(comparatorPath, comparator.archive);
      process.env.RUDDER_NATIVE_ARCHIVE_PATH = await fakeNative(f.root, "success");
      process.env.RUDDER_TEST_NATIVE_ARCHIVE = comparatorPath;
      const output = path.join(f.root, "native-output.zip");
      await writeFile(output, "keep");
      await expect(createWorkspaceBackupV2Native({ rootPath: f.root, orgId: "org", instanceId: "instance", artifactPath: output }))
        .rejects.toMatchObject({ diagnostic: { category: "publication", code: "final_exists", fallbackAllowed: false } });
      await expect(readFile(output, "utf8")).resolves.toBe("keep");
    } finally {
      if (previousPath === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH; else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousPath;
      if (previousArchive === undefined) delete process.env.RUDDER_TEST_NATIVE_ARCHIVE; else process.env.RUDDER_TEST_NATIVE_ARCHIVE = previousArchive;
      await f.dispose();
    }
  });

  it("never overwrites a final artifact raced into Node or native publication", async () => {
    for (const mode of ["node", "native"] as const) {
      const f = await fixture();
      const previousPath = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
      const previousArchive = process.env.RUDDER_TEST_NATIVE_ARCHIVE;
      try {
        await writeFile(path.join(f.root, "file.txt"), "content");
        const output = path.join(f.root, `${mode}.zip`);
        const beforePublish = async () => { await writeFile(output, "raced-final", { flag: "wx" }); };
        if (mode === "node") {
          await expect(createWorkspaceBackupV2File({ rootPath: f.root, orgId: "org", instanceId: "instance", artifactPath: output, beforePublish }))
            .rejects.toMatchObject({ diagnostic: { category: "publication", code: "final_exists" } });
        } else {
          const comparator = await createWorkspaceBackupV2({ rootPath: f.root, orgId: "org", instanceId: "instance" });
          const comparatorPath = path.join(f.root, "comparator.zip");
          await writeFile(comparatorPath, comparator.archive);
          process.env.RUDDER_NATIVE_ARCHIVE_PATH = await fakeNative(f.root, "success");
          process.env.RUDDER_TEST_NATIVE_ARCHIVE = comparatorPath;
          await expect(createWorkspaceBackupV2Native({ rootPath: f.root, orgId: "org", instanceId: "instance", artifactPath: output, beforePublish }))
            .rejects.toMatchObject({ diagnostic: { category: "publication", code: "final_exists" } });
        }
        await expect(readFile(output, "utf8")).resolves.toBe("raced-final");
      } finally {
        if (previousPath === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH; else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousPath;
        if (previousArchive === undefined) delete process.env.RUDDER_TEST_NATIVE_ARCHIVE; else process.env.RUDDER_TEST_NATIVE_ARCHIVE = previousArchive;
        await f.dispose();
      }
    }
  });

  it.each(["unlink", "sync"])("forbids fallback when published validation rollback %s fails", async (failure) => {
    const f = await fixture();
    const previousPath = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
    const previousArchive = process.env.RUDDER_TEST_NATIVE_ARCHIVE;
    try {
      await writeFile(path.join(f.root, "file.txt"), "content");
      const invalidArchive = path.join(f.root, "invalid.zip");
      await writeFile(invalidArchive, "not-a-zip");
      process.env.RUDDER_NATIVE_ARCHIVE_PATH = await fakeNative(f.root, "success");
      process.env.RUDDER_TEST_NATIVE_ARCHIVE = invalidArchive;
      const output = path.join(f.root, "published-invalid.zip");
      const publicationOps = {
        link: async (source: string, destination: string) => { await link(source, destination); },
        rm: async (filePath: string) => {
          if (failure === "unlink" && filePath === output) throw new Error("injected unlink failure");
          await rm(filePath);
        },
        syncParent: async (filePath: string) => {
          if (failure === "sync" && filePath === output && !await readFile(output).then(() => true).catch(() => false)) throw new Error("injected rollback sync failure");
          const handle = await open(path.dirname(filePath), "r");
          try { await handle.sync(); } finally { await handle.close(); }
        },
      };
      await expect(createWorkspaceBackupV2Native({ rootPath: f.root, orgId: "org", instanceId: "instance", artifactPath: output, publicationOps }))
        .rejects.toMatchObject({ diagnostic: { category: "publication", code: "publication_recovery_required", fallbackAllowed: false } });
    } finally {
      if (previousPath === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH; else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousPath;
      if (previousArchive === undefined) delete process.env.RUDDER_TEST_NATIVE_ARCHIVE; else process.env.RUDDER_TEST_NATIVE_ARCHIVE = previousArchive;
      await f.dispose();
    }
  });

  it("writes a file-backed archive with bounded per-file materialization", async () => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.root, "nested"));
      await writeFile(path.join(f.root, "nested", "one.txt"), "one\n");
      await writeFile(path.join(f.root, "nested", "two.txt"), "two\n");
      const artifactPath = path.join(f.root, "backup.zip");
      const artifact = await createWorkspaceBackupV2File({ rootPath: f.root, orgId: "org", instanceId: "instance", artifactPath, createdAt: new Date("2026-01-01T00:00:00.000Z") });
      expect(artifact).not.toHaveProperty("archive");
      expect(artifact.artifactPath).toBe(artifactPath);
      expect(artifact.compressedSize).toBe((await readFile(artifactPath)).byteLength);
      expect(artifact.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      const inspected = await inspectWorkspaceBackupV2File(artifactPath);
      expect(inspected.manifest).toEqual(artifact.manifest);
      await expect(readWorkspaceBackupV2File(artifactPath, inspected, "nested/two.txt")).resolves.toEqual(Buffer.from("two\n"));
      const tempArtifacts = (await readdir(f.root)).filter((entry) => entry.includes(".tmp"));
      expect(tempArtifacts).toEqual([]);
    } finally { await f.dispose(); }
  });

  it("publishes and inspects exactly 100 MiB of workspace content without charging the manifest", async () => {
    const f = await fixture();
    try {
      const payload = Buffer.alloc(5 * 1024 * 1024, 0x61);
      for (let index = 0; index < 20; index += 1) {
        await writeFile(path.join(f.root, `payload-${String(index).padStart(2, "0")}.bin`), payload);
      }
      const artifactPath = path.join(f.root, "backup-100m.zip");
      const artifact = await createWorkspaceBackupV2File({
        rootPath: f.root,
        orgId: "org",
        instanceId: "instance",
        artifactPath,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      expect(artifact.byteSize).toBe(100 * 1024 * 1024);
      const inspected = await inspectWorkspaceBackupV2File(artifactPath);
      expect(inspected.manifest.entries.filter((entry) => entry.kind === "file")).toHaveLength(20);
    } finally { await f.dispose(); }
  }, 120_000);

  it("walks canonical paths and preserves Unicode bytes in a round trip", async () => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.root, "nested"));
      await writeFile(path.join(f.root, "nested", "你好.txt"), Buffer.from([0, 1, 2, 255]));
      const artifact = await createWorkspaceBackupV2({ rootPath: f.root, orgId: "org-1", instanceId: "instance-1", createdAt: new Date("2026-01-01T00:00:00.000Z") });
      const inspected = inspectWorkspaceBackupV2(artifact.archive);
      expect(inspected.manifest.identity.orgId).toBe("org-1");
      expect(inspected.manifest.entries.map((entry) => entry.path)).toEqual(["nested", "nested/你好.txt"]);
      expect(inspected.files.get("nested/你好.txt")).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(inspected.manifest).not.toHaveProperty("dataBase64");
      expect(artifact.archive.includes(Buffer.from(WORKSPACE_BACKUP_V2_MANIFEST_PATH))).toBe(true);
    } finally { await f.dispose(); }
  });

  it("keeps the v1 skip policy and rejects symlinks", async () => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.root, ".git"));
      await writeFile(path.join(f.root, ".git", "ignored"), "ignored");
      await writeFile(path.join(f.root, "draft.tmp-123"), "ignored");
      await writeFile(path.join(f.root, "kept.txt"), "kept");
      try { await symlink(path.join(f.root, "kept.txt"), path.join(f.root, "link.txt")); } catch { /* Windows may deny symlinks. */ }
      const walked = await walkWorkspaceBackupV2(f.root);
      expect(walked.entries.map((entry) => entry.path)).toEqual(["kept.txt"]);
      expect(walked.warnings.some((warning) => warning.includes(".git"))).toBe(true);
      expect(walked.warnings.some((warning) => warning.includes("draft.tmp-123"))).toBe(true);
      if (walked.warnings.some((warning) => warning.includes("symlink"))) expect(walked.warnings).toContain("Skipped symlink link.txt");
    } finally { await f.dispose(); }
  });

  it("skips oversized files and stops at the total byte limit", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.root, "too-large.bin"), Buffer.alloc(WORKSPACE_BACKUP_V2_MAX_FILE_BYTES + 1, 1));
      const perFile = WORKSPACE_BACKUP_V2_MAX_FILE_BYTES;
      const includedFileCount = WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES / perFile;
      for (let index = 0; index < includedFileCount; index += 1) {
        await writeFile(path.join(f.root, `part-${String(index).padStart(2, "0")}.bin`), Buffer.alloc(perFile, index));
      }
      await writeFile(path.join(f.root, "z-overflow.bin"), Buffer.from("overflow"));
      const walked = await walkWorkspaceBackupV2(f.root);
      expect(walked.byteSize).toBe(WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES);
      expect(walked.entries.some((entry) => entry.path === "too-large.bin")).toBe(false);
      expect(walked.entries.some((entry) => entry.path === "z-overflow.bin")).toBe(false);
      expect(walked.warnings.some((warning) => warning.includes("oversized"))).toBe(true);
      expect(walked.warnings.some((warning) => warning.includes("size limit"))).toBe(true);
    } finally { await f.dispose(); }
  });

  it("fails closed for malformed and tampered archives", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.root, "file.txt"), "content");
      const archive = await createWorkspaceBackupV2({ rootPath: f.root, orgId: "org", instanceId: "instance" });
      expect(() => inspectWorkspaceBackupV2(archive.archive.subarray(0, archive.archive.length - 8))).toThrow();
      const tampered = Buffer.from(archive.archive);
      const marker = Buffer.from("content");
      const index = tampered.indexOf(marker);
      expect(index).toBeGreaterThan(0);
      tampered[index] ^= 1;
      expect(() => inspectWorkspaceBackupV2(tampered)).toThrow(/checksum|invalid|corrupt/i);
      await expect(readFile(path.join(f.root, "file.txt"))).resolves.toEqual(Buffer.from("content"));
    } finally { await f.dispose(); }
  });
});
