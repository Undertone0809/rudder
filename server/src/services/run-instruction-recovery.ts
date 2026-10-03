import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_SCAN_ENTRIES = 4_096;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Instruction provenance only, not a transcript Reader or a reconstructed stack.
 * Match the persisted revision before returning any text; complete the bounded
 * scan to reject ambiguous matches, changed files, and missing native turns.
 */
export async function recoverCodexDeveloperInstructions(input: {
  managedRoot: string;
  managedHome: string;
  persistedHome: string;
  sessionId: string;
  turnId: string;
  sha256: string;
}): Promise<{ text: string; sha256: string; byteSize: number } | null> {
  if (!UUID.test(input.sessionId) || !UUID.test(input.turnId) || !/^[a-f0-9]{64}$/u.test(input.sha256)
    || !path.isAbsolute(input.persistedHome)
    || path.resolve(input.persistedHome) !== path.resolve(input.managedHome)) return null;
  try {
    const deadline = Date.now() + 5_000;
    const checkTime = () => { if (Date.now() > deadline) throw new Error("Recovery scan limit"); };
    const relativeHome = path.relative(input.managedRoot, input.managedHome);
    if (relativeHome.startsWith("..") || path.isAbsolute(relativeHome)) return null;
    const home = await realpath(input.managedHome);
    // Resolve platform aliases at the trusted instance root only. No symlink
    // below it may redirect an organization or agent to another profile.
    if (home !== path.join(await realpath(input.managedRoot), relativeHome)) return null;
    const root = path.join(home, "sessions");
    if (await realpath(root) !== root) return null;
    let visited = 0;
    const matches: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      checkTime();
      if (await realpath(directory) !== directory) throw new Error("Recovery path changed");
      const entries = await opendir(directory);
      for await (const entry of entries) {
        checkTime();
        if (++visited > MAX_SCAN_ENTRIES) throw new Error("Recovery scan limit");
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Recovery symlink");
        if (entry.isDirectory()) {
          if (depth >= 3 || !/^\d{2,4}$/u.test(entry.name)) throw new Error("Unexpected session directory");
          await visit(target, depth + 1);
        } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(`-${input.sessionId}.jsonl`)) {
          if (!entry.isFile()) throw new Error("Recovery source is not regular");
          matches.push(target);
          if (matches.length > 1) throw new Error("Ambiguous session source");
        }
      }
    };
    await visit(root, 0);
    if (matches.length !== 1) return null;
    const filename = matches[0]!;
    if (await realpath(filename) !== filename) return null;
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_SCAN_BYTES) return null;
      let bytes = 0;
      let pending = Buffer.alloc(0);
      let sessionMatches = 0;
      let turnMatches = 0;
      let instructionMatches = 0;
      let recovered: string | null = null;
      const consume = (line: Buffer) => {
        if (!line.length) return;
        if (line.length > MAX_LINE_BYTES) throw new Error("Recovery line limit");
        const row = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        const payload = record(row.payload);
        if (row.type === "session_meta") {
          if (payload.id !== input.sessionId) throw new Error("Session mismatch");
          sessionMatches += 1;
        }
        if (row.type === "turn_context" && payload.turn_id === input.turnId) turnMatches += 1;
        if (row.type !== "response_item" || payload.type !== "message" || payload.role !== "developer"
          || !Array.isArray(payload.content)) return;
        for (const item of payload.content) {
          const block = record(item);
          if (block.type !== "input_text" || typeof block.text !== "string") continue;
          const size = Buffer.byteLength(block.text, "utf8");
          if (size === 0 || size > MAX_INSTRUCTION_BYTES) continue;
          if (createHash("sha256").update(block.text, "utf8").digest("hex") !== input.sha256) continue;
          // Instructions after the requested turn cannot establish its inputs.
          if (turnMatches > 0) throw new Error("Instruction follows target turn");
          instructionMatches += 1;
          recovered = block.text;
        }
      };
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        checkTime();
        const read = await file.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        if (bytes > MAX_SCAN_BYTES) return null;
        pending = Buffer.concat([pending, buffer.subarray(0, read.bytesRead)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          consume(pending.subarray(0, newline));
          pending = pending.subarray(newline + 1);
        }
        if (pending.length > MAX_LINE_BYTES) return null;
      }
      if (pending.length) consume(pending);
      const after = await file.stat();
      const current = await lstat(filename);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size
        || current.dev !== after.dev || current.ino !== after.ino || !current.isFile()
        || await realpath(filename) !== filename) return null;
      if (sessionMatches !== 1 || turnMatches !== 1 || instructionMatches !== 1 || recovered === null) return null;
      return { text: recovered, sha256: input.sha256, byteSize: Buffer.byteLength(recovered, "utf8") };
    } finally {
      await file.close();
    }
  } catch {
    // Never expose filesystem paths, provider contents, or partial evidence.
    return null;
  }
}
