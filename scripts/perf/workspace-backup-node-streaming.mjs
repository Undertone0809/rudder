import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;

const SKIPPED_ENTRY_NAMES = new Set([
  ".DS_Store", ".cache", ".codex", ".config", ".git", ".gstack", ".local",
  ".mintlify", ".npm", ".nvm", ".pnpm-store", ".rudder", ".tmp", ".turbo",
  ".vite", "Library", "node_modules",
]);

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC32_TABLE[index] = value >>> 0;
}

function crc32Update(value, data) {
  let next = value;
  for (const byte of data) next = CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  return next >>> 0;
}

function crc32(data) {
  return (crc32Update(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function zipHeaders(name, dataSize, checksum, offset, directory) {
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021),
    u32(checksum), u32(dataSize), u32(dataSize), u16(nameBytes.length), u16(0), nameBytes,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021),
    u32(checksum), u32(dataSize), u32(dataSize), u16(nameBytes.length), u16(0), u16(0),
    u16(0), u16(0), u32(directory ? 0x10 : 0), u32(offset), nameBytes,
  ]);
  return { local, central };
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  return Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entryCount), u16(entryCount),
    u32(centralSize), u32(centralOffset), u16(0),
  ]);
}

function relativeName(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function skipped(name) {
  return SKIPPED_ENTRY_NAMES.has(name)
    || name.endsWith("~") || name.endsWith(".swp") || name.endsWith(".swo")
    || name.endsWith(".partial") || name.endsWith(".crdownload") || /\.tmp(?:[-.]|$)/.test(name);
}

export async function collectWorkspaceEntries(rootPath, rootFolder = path.basename(rootPath) || "workspace") {
  const root = path.resolve(rootPath);
  const entries = [{ path: `${rootFolder}/`, kind: "directory", byteSize: 0, sourcePath: null }];
  const warnings = [];
  let totalBytes = 0;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    const dirents = (await fsp.readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      const absolute = path.join(current, dirent.name);
      const relative = relativeName(root, absolute);
      if (skipped(dirent.name)) {
        warnings.push(`Skipped ${relative}`);
        continue;
      }
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        warnings.push(`Skipped symlink ${relative}`);
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ path: `${rootFolder}/${relative}/`, kind: "directory", byteSize: 0, sourcePath: null });
        queue.push(absolute);
        continue;
      }
      if (!stat.isFile()) {
        warnings.push(`Skipped unsupported file ${relative}`);
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        warnings.push(`Skipped oversized file ${relative}`);
        continue;
      }
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
        warnings.push(`Skipped ${relative} because the backup size limit was reached`);
        continue;
      }
      totalBytes += stat.size;
      entries.push({ path: `${rootFolder}/${relative}`, kind: "file", byteSize: stat.size, sourcePath: absolute });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { root, entries, warnings, fileCount: entries.filter((entry) => entry.kind === "file").length, byteSize: totalBytes };
}

async function readFileBounded(sourcePath, expectedSize) {
  const chunks = [];
  let total = 0;
  for await (const chunk of fs.createReadStream(sourcePath, { highWaterMark: COPY_CHUNK_BYTES })) {
    total += chunk.byteLength;
    if (total > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
    chunks.push(chunk);
  }
  if (total !== expectedSize) throw new Error("file changed while creating backup");
  return Buffer.concat(chunks, total);
}

async function hashFile(sourcePath, expectedSize) {
  const hash = crypto.createHash("sha256");
  let checksum = 0xffffffff;
  let total = 0;
  for await (const chunk of fs.createReadStream(sourcePath, { highWaterMark: COPY_CHUNK_BYTES })) {
    total += chunk.byteLength;
    checksum = crc32Update(checksum, chunk);
    hash.update(chunk);
  }
  if (total !== expectedSize) throw new Error("file changed while creating backup");
  return { crc32: (checksum ^ 0xffffffff) >>> 0, sha256: hash.digest("hex"), byteSize: total };
}

function writeChunk(stream, chunk, streamError) {
  return stream.write(chunk) ? Promise.resolve() : Promise.race([once(stream, "drain"), streamError]);
}

async function closeStream(stream) {
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

export async function createBufferedZip(entries, outputPath) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.kind === "file" ? await readFileBounded(entry.sourcePath, entry.byteSize) : Buffer.alloc(0);
    const headers = zipHeaders(entry.path, data.byteLength, crc32(data), offset, entry.kind === "directory");
    local.push(headers.local, data);
    central.push(headers.central);
    offset += headers.local.byteLength + data.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const archive = Buffer.concat([...local, centralBytes, endOfCentralDirectory(entries.length, centralBytes.byteLength, offset)]);
  await fsp.writeFile(outputPath, archive, { mode: 0o600 });
  return { byteSize: archive.byteLength, sha256: crypto.createHash("sha256").update(archive).digest("hex") };
}

export async function createStreamingZip(entries, outputPath) {
  const stream = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600, highWaterMark: COPY_CHUNK_BYTES });
  stream.setMaxListeners(0);
  const streamError = new Promise((_, reject) => stream.once("error", reject));
  const archiveHash = crypto.createHash("sha256");
  const central = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const metadata = entry.kind === "file" ? await hashFile(entry.sourcePath, entry.byteSize) : { crc32: 0, byteSize: 0 };
      const headers = zipHeaders(entry.path, metadata.byteSize, metadata.crc32, offset, entry.kind === "directory");
      await writeChunk(stream, headers.local, streamError);
      archiveHash.update(headers.local);
      if (entry.kind === "file") {
        for await (const chunk of fs.createReadStream(entry.sourcePath, { highWaterMark: COPY_CHUNK_BYTES })) {
          archiveHash.update(chunk);
          await writeChunk(stream, chunk, streamError);
        }
      }
      central.push(headers.central);
      offset += headers.local.byteLength + metadata.byteSize;
    }
    const centralBytes = Buffer.concat(central);
    const end = endOfCentralDirectory(entries.length, centralBytes.byteLength, offset);
    await writeChunk(stream, centralBytes, streamError);
    await writeChunk(stream, end, streamError);
    archiveHash.update(centralBytes);
    archiveHash.update(end);
    await closeStream(stream);
  } catch (error) {
    stream.destroy();
    await fsp.rm(outputPath, { force: true });
    throw error;
  }
  return { byteSize: offset + Buffer.concat(central).byteLength + 22, sha256: archiveHash.digest("hex") };
}

export async function runBenchmark(rootPath, outputDir) {
  outputDir ??= await fsp.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-benchmark-"));
  const plan = await collectWorkspaceEntries(rootPath);
  const bufferedPath = path.join(outputDir, "buffered.zip");
  const streamingPath = path.join(outputDir, "streaming.zip");
  const bufferedBefore = process.memoryUsage().rss;
  const bufferedStart = performance.now();
  const buffered = await createBufferedZip(plan.entries, bufferedPath);
  const bufferedMs = performance.now() - bufferedStart;
  const bufferedAfter = process.memoryUsage().rss;
  const streamingBefore = process.memoryUsage().rss;
  const streamingStart = performance.now();
  const streaming = await createStreamingZip(plan.entries, streamingPath);
  const streamingMs = performance.now() - streamingStart;
  const streamingAfter = process.memoryUsage().rss;
  return {
    root: plan.root,
    fileCount: plan.fileCount,
    byteSize: plan.byteSize,
    warnings: plan.warnings,
    buffered: { ...buffered, elapsedMs: Number(bufferedMs.toFixed(3)), rssDeltaBytes: bufferedAfter - bufferedBefore, outputPath: bufferedPath },
    streaming: { ...streaming, elapsedMs: Number(streamingMs.toFixed(3)), rssDeltaBytes: streamingAfter - streamingBefore, outputPath: streamingPath },
    byteParity: buffered.byteSize === streaming.byteSize && buffered.sha256 === streaming.sha256,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) {
    console.error("Usage: node scripts/perf/workspace-backup-node-streaming.mjs <workspace-root> [output-dir]");
    process.exitCode = 2;
  } else {
    const result = await runBenchmark(root, process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
  }
}
