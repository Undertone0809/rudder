import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverCodexDeveloperInstructions } from "../services/run-instruction-recovery.js";

const sessionId = "01a0e913-d765-7640-b5cc-3ff37eef37ba";
const turnId = "01a0e914-025a-7a91-8d01-510c230b8631";
const text = "historical developer instructions 你好 🐕";
const sha256 = createHash("sha256").update(text).digest("hex");
const message = { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] } };
const rows = [{ type: "session_meta", payload: { id: sessionId } }, message, { type: "turn_context", payload: { turn_id: turnId } }];

describe("bounded historical Codex developer instruction recovery", () => {
  let root: string;
  let home: string;
  let file: string;
  const recover = () => recoverCodexDeveloperInstructions({ managedRoot: root, managedHome: home, persistedHome: home, sessionId, turnId, sha256 });
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rudder-instruction-recovery-"));
    home = path.join(root, "organizations", "org", "codex-home", "agents", "agent");
    const directory = path.join(home, "sessions", "2026", "09", "29");
    await mkdir(directory, { recursive: true });
    file = path.join(directory, `rollout-2026-09-29T01-33-06-${sessionId}.jsonl`);
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("returns only the unique hash-matched block before the exact native turn", async () => {
    await expect(recover()).resolves.toEqual({ text, sha256, byteSize: Buffer.byteLength(text) });
  });
  it("recovers B for the resulting revision after an A to B update in the same session", async () => {
    const textB = "updated developer instructions B";
    const revisionB = createHash("sha256").update(textB).digest("hex");
    const updated = { ...message, payload: { ...message.payload, content: [{ type: "input_text", text: textB }] } };
    await writeFile(file, [rows[0], message,
      { type: "turn_context", payload: { turn_id: "01a0e914-025a-7a91-8d01-510c230b8630" } },
      updated, rows[2],
    ].map((row) => JSON.stringify(row)).join("\n"));
    await expect(recoverCodexDeveloperInstructions({
      managedRoot: root, managedHome: home, persistedHome: home, sessionId, turnId, sha256: revisionB,
    })).resolves.toEqual({ text: textB, sha256: revisionB, byteSize: Buffer.byteLength(textB) });
  });
  it.each([
    ["wrong session", [{ type: "session_meta", payload: { id: turnId } }, ...rows.slice(1)]],
    ["missing turn", rows.slice(0, 2)],
    ["duplicate turn", [...rows, rows[2]]],
    ["duplicate match", [rows[0], message, message, rows[2]]],
    ["later instructions", [rows[0], rows[2], message]],
    ["wrong revision", [rows[0], { ...message, payload: { ...message.payload, content: [{ type: "input_text", text: "different" }] } }, rows[2]]],
    ["non-developer text", [rows[0], { ...message, payload: { ...message.payload, role: "user" } }, rows[2]]],
  ])("fails closed for %s", async (_name, content) => {
    await writeFile(file, content.map((row) => JSON.stringify(row)).join("\n"));
    await expect(recover()).resolves.toBeNull();
  });
  it("rejects ambiguous session files", async () => {
    await writeFile(path.join(path.dirname(file), `rollout-other-${sessionId}.jsonl`), "");
    await expect(recover()).resolves.toBeNull();
  });
  it("rejects a symlinked rollout", async () => {
    const outside = path.join(root, "other.jsonl");
    await writeFile(outside, rows.map((row) => JSON.stringify(row)).join("\n"));
    await rm(file);
    await symlink(outside, file);
    await expect(recover()).resolves.toBeNull();
  });
  it("rejects an organization redirected through a symlink", async () => {
    const linked = path.join(root, "linked");
    await symlink(path.join(root, "organizations"), linked);
    home = path.join(linked, "org", "codex-home", "agents", "agent");
    await expect(recover()).resolves.toBeNull();
  });
  it("rejects oversized lines rather than returning an earlier match", async () => {
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n" + "x".repeat(1024 * 1024 + 1));
    await expect(recover()).resolves.toBeNull();
  });
  it("rejects a file larger than the total scan budget before reading its prefix", async () => {
    await truncate(file, 32 * 1024 * 1024 + 1);
    await expect(recover()).resolves.toBeNull();
  });
  it("rejects malformed trailing records rather than returning an earlier match", async () => {
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n{");
    await expect(recover()).resolves.toBeNull();
  });
  it("rejects a persisted profile outside its managed home", async () => {
    await expect(recoverCodexDeveloperInstructions({ managedRoot: root, managedHome: home, persistedHome: root, sessionId, turnId, sha256 })).resolves.toBeNull();
  });
});
