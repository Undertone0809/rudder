import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexMixedCoverageInput, CoverageIdentity } from "./native-transcript-coverage.js";
import { CodexGapDictionary } from "./transcript-object-compact.js";
import {
  createTranscriptObjectReader,
  createTranscriptObjectStore,
  type TranscriptObjectBeginInput,
} from "./transcript-object-store.js";
import type { NativeTranscriptReadInput } from "./transcript-reader.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-transcript-object-"));
  roots.push(root);
  return { root, store: createTranscriptObjectStore(root) };
}

const binding: TranscriptObjectBeginInput = {
  orgId: "org-1",
  runId: "run-1",
  spanId: "span-1",
  ownerToken: "owner-secret-1",
};

const entries: TranscriptEntry[] = [
  { kind: "assistant", ts: "2026-09-23T00:00:01.000Z", text: "first" },
  { kind: "tool_result", ts: "2026-09-23T00:00:02.000Z", toolUseId: "tool-1", content: "second", isError: false },
];

describe("first-write compact gap object, legacy compatibility and safe retention", () => {
  const identity: CoverageIdentity = { ...binding, attemptId: "attempt-1", attemptEpoch: 1,
    selector: { kind: "codex_turn", runId: binding.runId, threadId: "thread-1", turnId: "turn-1" } };
  const input = (objectRef: string) => ({ ...binding, objectRef, limit: 2 });
  const readAll = async (store: ReturnType<typeof createTranscriptObjectStore>, objectRef: string) => {
    const result: TranscriptEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await store.readRange({ ...input(objectRef), limit: 200, cursor });
      result.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  };
  const workload: TranscriptEntry[] = Array.from({ length: 8 }, (_, index) => ({ kind: "assistant",
    ts: `2026-10-03T00:00:0${index}.123456Z`, sourceEntryId: `entry-${index}`, segmentId: "msg-1",
    delta: index < 7, text: "Synthetic界🌍 chunk ".repeat(2000), phase: "final_answer" }));

  it("measures actual first written bytes vs SAME legacy load, reopens and paginates exact entries with no shadow", async () => {
    const f = await fixture();
    const writes = { legacy: 0, compact: 0 };
    let cohort: keyof typeof writes = "legacy";
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const write = file.writeFile.bind(file);
      file.writeFile = async (...values: Parameters<typeof file.writeFile>) => {
        const bytes = typeof values[0] === "string" ? Buffer.byteLength(values[0], "utf8")
          : values[0] instanceof Uint8Array ? values[0].byteLength : 0;
        await write(...values); writes[cohort] += bytes;
      };
      return file;
    });
    let legacy, compact;
    try {
      legacy = await f.store.begin(binding);
      for (const entry of workload) await f.store.append(legacy, entry);
      await f.store.finalize(legacy, { completeness: "partial" });
      cohort = "compact";
      compact = await f.store.begin({ ...binding, compactIdentity: identity });
      for (const entry of workload) await f.store.append(compact, entry);
      await f.store.finalize(compact, { completeness: "partial" });
    } finally { spy.mockRestore(); }
    expect(writes.compact).toBeLessThan(writes.legacy / 2); // ALL writeFile bytes, including metadata, not representation estimate.
    const reopened = createTranscriptObjectStore(f.root);
    const all: TranscriptEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await reopened.readRange({ ...input(compact!.objectRef), cursor });
      expect(page.completeness).toBe("partial"); all.push(...page.entries); cursor = page.nextCursor;
    } while (cursor);
    expect(all).toEqual(workload);
    const codec = new CodexGapDictionary();
    const compactPayload = await fs.readFile(path.join(f.root, "transcript-objects", compact!.objectRef + ".ndjson"), "utf8");
    const reconstructed = compactPayload.trimEnd().split("\n").map(line => codec.decode(line, 2 * 1024 * 1024, true) + "\n").join("");
    expect(Buffer.from(reconstructed)).toEqual(await fs.readFile(path.join(f.root, "transcript-objects", legacy!.objectRef + ".ndjson")));
    const meta = JSON.parse(await fs.readFile(path.join(f.root, "transcript-objects", compact!.objectRef + ".json"), "utf8"));
    expect(meta.encoding).toBe("codex-gap-dictionary-v1");
    expect(await fs.readdir(path.join(f.root, "transcript-objects"))).toHaveLength(4); // two objects only; no sidecar/shadow/dictionary file.
    expect((await reopened.readRange({ ...input(legacy!.objectRef), limit: 200 })).entries).toEqual(workload);
    console.log(JSON.stringify({ metric: "actual_initial_writeFile_UTF8_bytes_including_metadata", legacy: writes.legacy, compact: writes.compact, rows: workload.length }));
  });

  it("unknown/mismatched qualification remains v1, never converts existing legacy object on resume", async () => {
    const f = await fixture();
    const handle = await f.store.begin({ ...binding, compactIdentity: { ...identity, runId: "other-run" } });
    await f.store.append(handle, workload[0]!);
    const resumed = await f.store.resume({ ...binding, compactIdentity: identity, objectRef: handle.objectRef });
    await f.store.append(resumed, workload[1]!);
    const metadata = JSON.parse(await fs.readFile(path.join(f.root, "transcript-objects", handle.objectRef + ".json"), "utf8"));
    expect(metadata.encoding).toBeUndefined();
    expect(await f.store.isSelfContainedCompact!({ ...binding, objectRef: handle.objectRef })).toBe(false);
  });

  it("removes a sealed compact object after validating its decoded records", async () => {
    const f = await fixture();
    const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload.slice(0, 2));
    await f.store.finalize(handle, { completeness: "partial" });
    await f.store.removeSealed(input(handle.objectRef));
    expect(await fs.readdir(path.join(f.root, "transcript-objects"))).toEqual([]);
  });

  it("recovers a durable partial child prefix after a copy crash without duplicating the root history", async () => {
    const f = await fixture();
    const early = await f.store.begin({ ...binding, earlyHandoffEligible: true });
    const prefix: TranscriptEntry[] = Array.from({ length: 205 }, (_, index) => ({
      kind: "assistant",
      ts: `2026-10-04T00:00:${String(index).padStart(2, "0")}.000Z`,
      sourceEntryId: `early-${index}`,
      text: `early ${index}`,
    }));
    await f.store.append(early, prefix.slice(0, 200));
    await f.store.append(early, prefix.slice(200));

    const rename = fs.rename.bind(fs);
    let childMetadataPublishes = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith(".json") && !String(to).endsWith(`${early.objectRef}.json`)) {
        childMetadataPublishes += 1;
        if (childMetadataPublishes === 3) {
          throw Object.assign(new Error("synthetic process loss during child append"), { code: "EIO" });
        }
      }
      return rename(from, to);
    });
    try {
      await expect(f.store.handoffCompact!({
        handle: early,
        compactIdentity: identity,
        withPublishFence: async (publish) => { await publish(); return true; },
      })).rejects.toMatchObject({ code: "EIO" });
    } finally { spy.mockRestore(); }

    const objectDir = path.join(f.root, "transcript-objects");
    expect((await fs.readdir(objectDir)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    const reopened = createTranscriptObjectStore(f.root);
    const recoveredRoot = await reopened.resume({ ...binding, objectRef: early.objectRef });
    await expect(reopened.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: identity,
      withPublishFence: async (publish) => { await publish(); return true; },
    })).resolves.toMatchObject({ activated: true });
    expect((await fs.readdir(objectDir)).filter((name) => name.endsWith(".json"))).toHaveLength(2);

    const suffix: TranscriptEntry = {
      kind: "assistant", ts: "2026-10-04T00:01:00.000Z", sourceEntryId: "after-handoff", text: "after handoff",
    };
    await reopened.append(recoveredRoot, suffix);
    expect(await readAll(reopened, early.objectRef)).toEqual([...prefix, suffix]);
  });

  it("recovers a published handoff when its acknowledgement is lost and preserves raw evidence on a stale fence", async () => {
    const f = await fixture();
    const early = await f.store.begin({ ...binding, earlyHandoffEligible: true });
    await f.store.append(early, workload.slice(0, 2));
    let loseAcknowledgement = true;
    await expect(f.store.handoffCompact!({
      handle: early,
      compactIdentity: identity,
      withPublishFence: async (publish) => {
        await publish();
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("synthetic lost handoff acknowledgement");
        }
        return true;
      },
    })).rejects.toThrow("synthetic lost handoff acknowledgement");

    const reopened = createTranscriptObjectStore(f.root);
    const recoveredRoot = await reopened.resume({ ...binding, objectRef: early.objectRef });
    await expect(reopened.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: identity,
      withPublishFence: async (publish) => { await publish(); return true; },
    })).resolves.toMatchObject({ activated: true });
    expect(await readAll(reopened, early.objectRef)).toEqual(workload.slice(0, 2));
    expect((await fs.readdir(path.join(f.root, "transcript-objects"))).filter((name) => name.endsWith(".json"))).toHaveLength(2);

    const staleRoot = await reopened.begin({ ...binding, earlyHandoffEligible: true });
    await reopened.append(staleRoot, workload[0]!);
    await expect(reopened.handoffCompact!({
      handle: staleRoot,
      compactIdentity: identity,
      withPublishFence: async () => false,
    })).resolves.toMatchObject({ activated: false, objectRef: null });
    expect(await readAll(reopened, staleRoot.objectRef)).toEqual([workload[0]]);
  });

  it("reuses a published child after owner takeover only for the same stable selector and prefix", async () => {
    const f = await fixture();
    const root = await f.store.begin({ ...binding, earlyHandoffEligible: true });
    const prefix = workload.slice(0, 2);
    await f.store.append(root, prefix);
    const first = await f.store.handoffCompact!({
      handle: root,
      compactIdentity: identity,
      withPublishFence: async (publish) => { await publish(); return true; },
    });
    expect(first).toMatchObject({ activated: true });
    const objectDir = path.join(f.root, "transcript-objects");
    const firstRootMetadataBytes = await fs.readFile(path.join(objectDir, `${root.objectRef}.json`));
    const firstRootMetadata = JSON.parse(firstRootMetadataBytes.toString("utf8"));
    const childRef = firstRootMetadata.compactHandoff.objectRef as string;
    const rootMetadataPath = path.join(objectDir, `${root.objectRef}.json`);
    const childMetadataPath = path.join(objectDir, `${childRef}.json`);
    const childMetadataBytes = await fs.readFile(childMetadataPath);
    const childPayloadPath = path.join(objectDir, `${childRef}.ndjson`);

    const recovered = createTranscriptObjectStore(f.root);
    const recoveredRoot = await recovered.resume({ ...binding, ownerToken: "owner-2", objectRef: root.objectRef });
    const takeoverIdentity = { ...identity, ownerToken: "owner-2", attemptEpoch: 2 };

    await fs.writeFile(childMetadataPath, JSON.stringify({
      ...JSON.parse(childMetadataBytes.toString("utf8")),
      compactHandoffParentRef: "tobj_v1_00000000-0000-4000-8000-000000000000",
    }));
    await expect(recovered.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: takeoverIdentity,
      withPublishFence: async (publish) => { await publish(); return true; },
    })).rejects.toThrow("identity does not match its root");
    await fs.writeFile(childMetadataPath, childMetadataBytes);

    await expect(recovered.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: {
        ...takeoverIdentity,
        selector: { ...takeoverIdentity.selector, turnId: "different-turn" },
      },
      withPublishFence: async (publish) => { await publish(); return true; },
    })).rejects.toThrow("identity does not match its root");

    await fs.writeFile(rootMetadataPath, JSON.stringify({
      ...firstRootMetadata,
      compactHandoff: { ...firstRootMetadata.compactHandoff, prefixSha256: "0".repeat(64) },
    }));
    await expect(recovered.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: takeoverIdentity,
      withPublishFence: async (publish) => { await publish(); return true; },
    })).rejects.toThrow("prefix digest does not match its root");
    await fs.writeFile(rootMetadataPath, firstRootMetadataBytes);

    const takeover = await recovered.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: takeoverIdentity,
      withPublishFence: async (publish) => { await publish(); return true; },
    });
    expect(takeover).toEqual({ activated: true, objectRef: childRef });
    expect(JSON.parse((await fs.readFile(rootMetadataPath)).toString("utf8")))
      .toMatchObject({
        compactHandoff: {
          objectRef: childRef,
          prefixEntryCount: prefix.length,
          compactHandoffSelectorSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });

    const suffix: TranscriptEntry = {
      kind: "assistant", ts: "2026-10-04T00:02:00.000Z", sourceEntryId: "takeover-suffix", text: "new owner append",
    };
    await recovered.append(recoveredRoot, suffix, {
      withOwnerFence: async (commit) => { await commit(); return true; },
    });
    const durableRootMetadata = await fs.readFile(rootMetadataPath);
    const durableChildPayload = await fs.readFile(childPayloadPath);
    const staleSuffix: TranscriptEntry = {
      kind: "assistant", ts: "2026-10-04T00:02:01.000Z", sourceEntryId: "stale-owner-suffix", text: "must not append",
    };
    await expect(f.store.append(root, staleSuffix, {
      withOwnerFence: async () => false,
    })).rejects.toThrow("lost its active Run owner fence");
    await expect(f.store.handoffCompact!({
      handle: root,
      compactIdentity: identity,
      withPublishFence: async () => false,
    })).resolves.toEqual({ activated: false, objectRef: null });

    expect(await fs.readFile(rootMetadataPath)).toEqual(durableRootMetadata);
    expect(await fs.readFile(childPayloadPath)).toEqual(durableChildPayload);
    expect(await readAll(recovered, root.objectRef)).toEqual([...prefix, suffix]);
  });

  it("reuses an unpublished child after takeover and links its original owner-bound hash", async () => {
    const f = await fixture();
    const root = await f.store.begin({ ...binding, earlyHandoffEligible: true });
    const prefix = workload.slice(0, 2);
    await f.store.append(root, prefix);
    await expect(f.store.handoffCompact!({
      handle: root,
      compactIdentity: identity,
      withPublishFence: async () => false,
    })).resolves.toEqual({ activated: false, objectRef: null });

    const objectDir = path.join(f.root, "transcript-objects");
    const jsonFiles = await fs.readdir(objectDir);
    expect(jsonFiles.filter((name) => name.endsWith(".json"))).toHaveLength(2);
    const candidateRef = jsonFiles.find((name) => name.endsWith(".json") && !name.startsWith(`${root.objectRef}.`))
      ?.slice(0, -".json".length);
    expect(candidateRef).toBeTruthy();

    const recovered = createTranscriptObjectStore(f.root);
    const recoveredRoot = await recovered.resume({ ...binding, ownerToken: "owner-2", objectRef: root.objectRef });
    const takeoverIdentity = { ...identity, ownerToken: "owner-2", attemptEpoch: 2 };
    const takeover = await recovered.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: takeoverIdentity,
      withPublishFence: async (publish) => { await publish(); return true; },
    });
    expect(takeover).toEqual({ activated: true, objectRef: candidateRef });

    const rootMetadata = JSON.parse(await fs.readFile(path.join(objectDir, `${root.objectRef}.json`), "utf8"));
    const childMetadata = JSON.parse(await fs.readFile(path.join(objectDir, `${candidateRef}.json`), "utf8"));
    expect(rootMetadata.compactHandoff.compactIdentitySha256).toBe(childMetadata.compactIdentitySha256);
    expect(rootMetadata.compactHandoff.compactHandoffSelectorSha256)
      .toBe(childMetadata.compactHandoffSelectorSha256);
    await expect(recovered.handoffCompact!({
      handle: recoveredRoot,
      compactIdentity: takeoverIdentity,
      withPublishFence: async (publish) => { await publish(); return true; },
    })).resolves.toEqual({ activated: true, objectRef: candidateRef });
    expect((await fs.readdir(objectDir)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect(await readAll(recovered, root.objectRef)).toEqual(prefix);
  });

  it("stages, restores after reopen, and purges sealed compact retention without losing records", async () => {
    const f = await fixture();
    const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload.slice(0, 2));
    await f.store.finalize(handle, { completeness: "partial" });
    const staged = await f.store.stageSealedRemoval!(input(handle.objectRef));
    const reopened = createTranscriptObjectStore(f.root);
    await reopened.restoreStagedRemoval!({ ...input(handle.objectRef), stageId: staged.stageId });
    expect((await reopened.readRange(input(handle.objectRef))).entries).toEqual(workload.slice(0, 2));
    const restaged = await reopened.stageSealedRemoval!(input(handle.objectRef));
    await reopened.purgeStagedRemoval!({ ...input(handle.objectRef), stageId: restaged.stageId });
    expect(await fs.readdir(path.join(f.root, "transcript-objects"))).toEqual([]);
  });

  it("retains corrupted compact evidence instead of staging or deleting it", async () => {
    const f = await fixture();
    const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload[0]!);
    await f.store.finalize(handle, { completeness: "partial" });
    const payload = path.join(f.root, "transcript-objects", `${handle.objectRef}.ndjson`);
    const record = JSON.parse(await fs.readFile(payload, "utf8"));
    record.sha256 = "0".repeat(64);
    await fs.writeFile(payload, `${JSON.stringify(record)}\n`);
    const corrupted = await fs.readFile(payload);
    await expect(f.store.stageSealedRemoval!(input(handle.objectRef))).rejects.toThrow();
    await expect(f.store.removeSealed(input(handle.objectRef))).rejects.toThrow();
    expect(await fs.readFile(payload)).toEqual(corrupted);
    expect(await fs.readdir(path.join(f.root, "transcript-objects"))).toHaveLength(2);
  });

  it("rejects foreign ownership and corrupted staged compact restore/purge without removing evidence", async () => {
    const f = await fixture();
    const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload[0]!);
    await f.store.finalize(handle, { completeness: "partial" });
    const staged = await f.store.stageSealedRemoval!(input(handle.objectRef));
    const request = { ...input(handle.objectRef), stageId: staged.stageId };
    await expect(f.store.restoreStagedRemoval!({ ...request, orgId: "other-org" })).rejects.toThrow();
    await expect(f.store.purgeStagedRemoval!({ ...request, ownerToken: "other-owner" })).rejects.toThrow();
    const stageDir = path.join(f.root, "transcript-objects", `.retention-${handle.objectRef}-${staged.stageId}`);
    const payload = path.join(stageDir, `${handle.objectRef}.ndjson`);
    const record = JSON.parse(await fs.readFile(payload, "utf8"));
    record.sha256 = "0".repeat(64);
    await fs.writeFile(payload, `${JSON.stringify(record)}\n`);
    const corrupted = await fs.readFile(payload);
    await expect(f.store.restoreStagedRemoval!(request)).rejects.toThrow("digest");
    await expect(f.store.purgeStagedRemoval!(request)).rejects.toThrow("digest");
    expect(await fs.readFile(payload)).toEqual(corrupted);
    expect(await fs.readdir(stageDir)).toHaveLength(2);
  });

  it("rebuilds committed dictionary after store/owner recovery and rejects cross-org access", async () => {
    const f = await fixture(); const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload[0]!);
    const reopened = createTranscriptObjectStore(f.root);
    const resumed = await reopened.resume({ ...binding, ownerToken: "recovered-owner", objectRef: handle.objectRef });
    await reopened.append(resumed, workload[1]!);
    expect((await reopened.readRange({ ...input(handle.objectRef), ownerToken: "recovered-owner", allowOwnerRecovery: true })).entries).toEqual(workload.slice(0, 2));
    await expect(reopened.readRange({ ...input(handle.objectRef), orgId: "other-org" })).rejects.toThrow();
  });

  it("failed disk write does not commit/cache an entry; own reopen keeps last committed bytes", async () => {
    const f = await fixture(); const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload[0]!);
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".ndjson") && args[1] === "a") file.writeFile = async () => { throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" }); };
      return file;
    });
    try { await expect(f.store.append(handle, workload[1]!)).rejects.toMatchObject({ code: "ENOSPC" }); } finally { spy.mockRestore(); }
    const reopened = createTranscriptObjectStore(f.root);
    expect((await reopened.readRange(input(handle.objectRef))).entries).toEqual(workload.slice(0, 1));
    const resumed = await reopened.resume({ ...binding, objectRef: handle.objectRef });
    await reopened.append(resumed, workload[1]!);
    expect((await reopened.readRange(input(handle.objectRef))).entries).toEqual(workload.slice(0, 2));
  });

  it("metadata publish failure preserves committed prefix, then owner reopen reconciles uncommitted tail", async () => {
    const f = await fixture(); const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload[0]!);
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith(handle.objectRef + ".json")) throw Object.assign(new Error("synthetic metadata publish failure"), { code: "EIO" });
      return rename(from, to);
    });
    try { await expect(f.store.append(handle, workload[1]!)).rejects.toMatchObject({ code: "EIO" }); } finally { spy.mockRestore(); }
    expect((await f.store.readRange(input(handle.objectRef))).entries).toEqual(workload.slice(0, 1));
    const reopened = createTranscriptObjectStore(f.root);
    const resumed = await reopened.resume({ ...binding, objectRef: handle.objectRef });
    await reopened.append(resumed, workload[1]!);
    expect((await reopened.readRange(input(handle.objectRef))).entries).toEqual(workload.slice(0, 2));
  });

  it("sealed corruption fails, open corruption is partial; compression never bypasses logical byte quota", async () => {
    const f = await fixture(); const handle = await f.store.begin({ ...binding, compactIdentity: identity });
    await f.store.append(handle, workload[0]!);
    const payloadPath = path.join(f.root, "transcript-objects", handle.objectRef + ".ndjson");
    const metaPath = path.join(f.root, "transcript-objects", handle.objectRef + ".json");
    const metadata = JSON.parse(await fs.readFile(metaPath, "utf8"));
    const before = await fs.readFile(payloadPath);
    await fs.writeFile(metaPath, JSON.stringify({ ...metadata, logicalBytes: 256 * 1024 * 1024 }));
    await expect(f.store.append(handle, workload[1]!)).rejects.toThrow("size limit");
    expect(await fs.readFile(payloadPath)).toEqual(before);
    await fs.writeFile(metaPath, JSON.stringify(metadata));
    await f.store.finalize(handle, { completeness: "partial" });
    const record = JSON.parse(before.toString("utf8")); expect(record.version).toBe(2);
    record.sha256 = "0".repeat(64);
    await fs.writeFile(payloadPath, JSON.stringify(record) + "\n");
    await expect(f.store.readRange(input(handle.objectRef))).rejects.toThrow("digest");
    await fs.writeFile(metaPath, JSON.stringify({ ...metadata, state: "open" }));
    expect(await f.store.readRange(input(handle.objectRef))).toMatchObject({ entries: [], completeness: "partial" });
  });
});

async function shadowFixture() {
  const f = await fixture();
  const identity: CoverageIdentity = { ...binding, attemptId: "attempt-1", attemptEpoch: 1,
    selector: { kind: "codex_turn", runId: binding.runId, threadId: "thread-1", turnId: "turn-1" } };
  const ts = "2026-01-01T00:00:00.000Z";
  const handle = await f.store.begin(binding);
  await f.store.append(handle, [
    { kind: "stdout", ts, text: "synthetic retained bootstrap diagnostic" },
    { kind: "init", ts, sessionId: "thread-1", model: "synthetic" },
    { kind: "system", ts, text: "reasoning started" },
    { kind: "assistant", ts, delta: true, phase: "final_answer", segmentId: "msg-1", text: "first界" },
    { kind: "assistant", ts: "2026-01-01T00:00:01.123Z", delta: true, phase: "final_answer", segmentId: "msg-1", text: "second🌍" },
  ]);
  await f.store.finalize(handle, { completeness: "partial" });
  const native: CodexMixedCoverageInput["native"] = { identity, source: "native", availability: "available", completeness: "complete",
    revisionBefore: "native-r1", revisionAfter: "native-r1", entries: [{ kind: "assistant", ts,
      phase: "final_answer", segmentId: "msg-1", sourceEntryId: "msg-1", text: "first界second🌍" }] };
  const input = { objectRef: handle.objectRef, identity, native };
  const payload = path.join(f.root, "transcript-objects", handle.objectRef + ".ndjson");
  const metadata = path.join(f.root, "transcript-objects", handle.objectRef + ".json");
  const published = path.join(f.root, "transcript-objects", "codex-timeline-shadows", handle.objectRef);
  return { ...f, input, payload, metadata, published, original: await fs.readFile(payload), originalMetadata: await fs.readFile(metadata) };
}

describe("Codex timeline shadow persistence: no writer/ref switch", () => {
  it("does not allow the scoped write capability to escape or publish twice", async () => {
    const f = await shadowFixture();
    let escaped: NonNullable<Parameters<NonNullable<typeof f.store.withCodexTimelineShadowLock>>[1]> extends (write: infer W) => unknown ? W : never;
    await f.store.withCodexTimelineShadowLock!(f.input.objectRef, async write => {
      escaped = write;
      expect(await write({ ...f.input, beforePublish: async () => true })).toMatchObject({ ok: true });
      expect(await write({ ...f.input, beforePublish: async () => true })).toMatchObject({ ok: false, reason: "shadow_lock_scope_invalid" });
    });
    expect(await escaped!({ ...f.input, beforePublish: async () => true })).toMatchObject({ ok: false, reason: "shadow_lock_scope_invalid" });
  });

  it.each(["manifest", "residual", "metadata", "payload"].flatMap(target => ["symlink", "fifo"].map(replacement => ({ target, replacement }))))(
    "rejects $target swapped to $replacement at open without blocking or reading it", async ({ target, replacement }) => {
      const f = await shadowFixture();
      expect(await f.store.writeCodexTimelineShadow!({ ...f.input, beforePublish: async () => true })).toMatchObject({ ok: true });
      const filePath = target === "manifest" ? path.join(f.published, "manifest.json")
        : target === "residual" ? path.join(f.published, "residual.bin") : target === "metadata" ? f.metadata : f.payload;
      const outside = path.join(f.root, "not-authorized");
      await fs.writeFile(outside, await fs.readFile(filePath)); // SAME bytes: following a symlink is still forbidden.
      const originalOpen = fs.open.bind(fs);
      let swapped = false;
      const swap = async () => {
        swapped = true;
        await fs.rename(filePath, filePath + ".saved");
        if (replacement === "symlink") await fs.symlink(outside, filePath);
        else execFileSync("mkfifo", [filePath]); // OWN temp FIFO only, no runtime/native process.
      };
      const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (String(file) === filePath && !swapped) {
          expect(typeof flags).toBe("number");
          expect(Number(flags) & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
          expect(Number(flags) & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
          await swap();
        }
        return originalOpen(file, flags, mode);
      });
      const originalRead = fs.readFile.bind(fs);
      const read = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
        // 61b reaches here after lstat/stat, then follows the replaced SAME-byte
        // symlink. Never inject a FIFO into its old blocking read path.
        if (replacement === "symlink" && String(file) === filePath && !swapped) await swap();
        return originalRead(file, options);
      });
      try {
        expect(await f.store.compareCodexTimelineShadow!(f.input)).toMatchObject({ ok: false, authorizesOldObjectDelete: false });
        expect(swapped).toBe(true);
      } finally { read.mockRestore(); open.mockRestore(); }
    }, 1500);

  it("reads the original opened FD after pathname replacement, never reopens through the replacement", async () => {
    const f = await shadowFixture();
    expect(await f.store.writeCodexTimelineShadow!({ ...f.input, beforePublish: async () => true })).toMatchObject({ ok: true });
    const residual = path.join(f.published, "residual.bin"), outside = path.join(f.root, "private-unrelated");
    await fs.writeFile(outside, "must not be read");
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (String(file) === residual && !swapped) {
        swapped = true; await fs.rename(residual, residual + ".saved"); await fs.symlink(outside, residual);
      }
      return handle;
    });
    try {
      expect(await f.store.compareCodexTimelineShadow!(f.input)).toMatchObject({ ok: true, authorizesOldObjectDelete: false });
      expect(swapped).toBe(true);
    } finally { open.mockRestore(); }
  });

  it("atomically persists and reopens a byte-exact shadow while original partial reads remain identical", async () => {
    const f = await shadowFixture();
    const before = await f.store.readRange(readInput(f.input.objectRef));
    const guard = vi.fn(async () => true);
    const written = await f.store.writeCodexTimelineShadow!({ ...f.input, beforePublish: guard });
    expect(written).toMatchObject({ ok: true, authorizesOldObjectDelete: false });
    expect(guard).toHaveBeenCalledOnce();
    const reopened = createTranscriptObjectStore(f.root);
    expect(await reopened.compareCodexTimelineShadow!(f.input)).toEqual(written);
    expect(await reopened.readRange(readInput(f.input.objectRef))).toEqual(before);
    expect(before.completeness).toBe("partial");
    expect(await fs.readFile(f.payload)).toEqual(f.original);
    expect(await fs.readFile(f.metadata)).toEqual(f.originalMetadata);
    expect((await fs.stat(path.join(f.published, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(f.published, "residual.bin"))).mode & 0o777).toBe(0o600);
  });

  it.each(["manifest", "residual", "missing", "offline", "partial", "revision", "owner", "attempt"])("retains original fallback after %s failure", async (failure) => {
    const f = await shadowFixture();
    expect(await f.store.writeCodexTimelineShadow!({ ...f.input, beforePublish: async () => true })).toMatchObject({ ok: true });
    if (failure === "manifest") await fs.writeFile(path.join(f.published, "manifest.json"), "invalid-json");
    if (failure === "residual") await fs.writeFile(path.join(f.published, "residual.bin"), "corruption");
    if (failure === "missing") await fs.unlink(path.join(f.published, "residual.bin"));
    if (failure === "offline") Object.assign(f.input.native, { availability: "offline" });
    if (failure === "partial") Object.assign(f.input.native, { completeness: "partial" });
    if (failure === "revision") f.input.native.revisionAfter = "native-r2";
    if (failure === "owner") f.input.identity.ownerToken = "wrong-owner";
    if (failure === "attempt") f.input.identity.attemptId = "wrong-attempt";
    expect(await createTranscriptObjectStore(f.root).compareCodexTimelineShadow!(f.input)).toMatchObject({ ok: false, authorizesOldObjectDelete: false });
    expect(await f.store.readRange(readInput(f.input.objectRef))).toMatchObject({ entries: expect.any(Array), completeness: "partial" });
    expect(await fs.readFile(f.payload)).toEqual(f.original);
    expect(await fs.readFile(f.metadata)).toEqual(f.originalMetadata);
  });

  it("does not publish after the final retention fence rejects; keeps original and pending evidence", async () => {
    const f = await shadowFixture();
    expect(await f.store.writeCodexTimelineShadow!({ ...f.input, beforePublish: async () => false })).toMatchObject({ ok: false, reason: "shadow_publication_fence_changed" });
    expect(await fs.stat(f.published).catch(() => null)).toBeNull();
    expect(await fs.readFile(f.payload)).toEqual(f.original);
    expect(await fs.readdir(path.dirname(f.published))).toEqual([expect.stringMatching(/^\.pending-/u)]);
  });

  it("does not publish or remove data on an atomic rename failure", async () => {
    const f = await shadowFixture();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === f.published) throw new Error("synthetic publish failure");
      return originalRename(from, to);
    });
    try {
      expect(await f.store.writeCodexTimelineShadow!({ ...f.input, beforePublish: async () => true })).toMatchObject({ ok: false, reason: "shadow_persistence_failed" });
    } finally { rename.mockRestore(); }
    expect(await fs.stat(f.published).catch(() => null)).toBeNull();
    expect(await fs.readFile(f.payload)).toEqual(f.original);
    expect(await fs.readFile(f.metadata)).toEqual(f.originalMetadata);
  });
});

function readInput(objectRef: string, overrides: Partial<TranscriptObjectBeginInput> = {}) {
  return {
    objectRef,
    ...binding,
    ...overrides,
  };
}

describe("transcript object store", () => {
  it("does not delete an existing payload when allocation collides", async () => {
    const { root, store } = await fixture();
    const originalOpen = fs.open.bind(fs);
    let collisionPath: string | null = null;
    const open = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (!collisionPath && flags === "wx" && String(filePath).endsWith(".ndjson")) {
        collisionPath = String(filePath);
        await fs.writeFile(collisionPath, "existing-payload", "utf8");
        throw Object.assign(new Error("File exists"), { code: "EEXIST" });
      }
      return originalOpen(filePath, flags, mode);
    });
    try {
      await store.begin(binding);
    } finally {
      open.mockRestore();
    }
    expect(collisionPath).toMatch(/^.+\.ndjson$/u);
    expect(collisionPath).toContain(root);
    await expect(fs.readFile(collisionPath!, "utf8")).resolves.toBe("existing-payload");
  });

  it("reads an empty object before and after sealing without opening a negative byte range", async () => {
    const { store } = await fixture();
    const handle = await store.begin(binding);
    await expect(store.readRange(readInput(handle.objectRef))).resolves.toMatchObject({
      entries: [],
      nextCursor: null,
      completeness: "partial",
    });
    await store.finalize(handle);
    await expect(store.readRange(readInput(handle.objectRef))).resolves.toMatchObject({
      entries: [],
      nextCursor: null,
      completeness: "complete",
    });
  });

  it("streams entries into an open partial object, pages them, then seals immutably", async () => {
    const { store } = await fixture();
    const handle = await store.begin(binding);

    await store.append(handle, entries[0]!);
    await store.append(handle, [entries[1]!]);

    const first = await store.readRange({ ...readInput(handle.objectRef), limit: 1 });
    expect(first).toMatchObject({
      source: "native_plus_objects",
      availability: "available",
      completeness: "partial",
    });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ kind: "assistant", text: "first" });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await store.readRange({
      ...readInput(handle.objectRef),
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.entries).toEqual([expect.objectContaining({ kind: "tool_result", content: "second" })]);
    expect(second.nextCursor).toBeNull();

    const receipt = await store.finalize(handle);
    expect(receipt).toMatchObject({ objectRef: handle.objectRef, entryCount: 2, completeness: "complete" });
    await expect(store.append(handle, entries[0]!)).rejects.toMatchObject({ status: 409 });

    const sealed = await store.readRange({ ...readInput(handle.objectRef), limit: 10 });
    expect(sealed).toMatchObject({ completeness: "complete", revision: first.revision });
    expect(sealed.entries).toHaveLength(2);
  });

  it("supports one-shot write while keeping the reference opaque and owner material out of metadata", async () => {
    const { root, store } = await fixture();
    const objectRef = await store.write({ ...binding, entries });

    expect(objectRef).toMatch(/^tobj_v1_[0-9a-f-]{36}$/u);
    const metadata = await fs.readFile(path.join(root, "transcript-objects", `${objectRef}.json`), "utf8");
    expect(metadata).not.toContain(binding.ownerToken);
    await expect(store.readRange({ ...readInput(objectRef), limit: 10 })).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "complete",
      entries,
    });
  });

  it("rejects an oversized append before serializing the full entry", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    const input: Record<string, unknown> = { oversized: "x".repeat(2 * 1024 * 1024), cycle: null };
    input.cycle = input;

    await expect(store.append(handle, {
      kind: "tool_call",
      ts: "2026-09-23T00:00:00.000Z",
      name: "large-tool",
      input,
    })).rejects.toMatchObject({ status: 400 });
    await expect(fs.stat(path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`)))
      .resolves.toMatchObject({ size: 0 });
  });

  it("checks the aggregate append budget before serializing any entry", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    const makeEntry = (input: Record<string, unknown>): TranscriptEntry => ({
      kind: "tool_call",
      ts: "2026-09-23T00:00:00.000Z",
      name: "large-tool",
      input,
    });
    const firstTwo = [
      makeEntry({ text: "x".repeat(1400 * 1024) }),
      makeEntry({ text: "x".repeat(1400 * 1024) }),
    ];
    const finalInput: Record<string, unknown> = { text: "x".repeat(1400 * 1024), cycle: null };
    finalInput.cycle = finalInput;

    await expect(store.append(handle, [...firstTwo, makeEntry(finalInput)]))
      .rejects.toMatchObject({ status: 400 });
    await expect(fs.stat(path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`)))
      .resolves.toMatchObject({ size: 0 });
  });

  it("rejects stored lines that exceed the byte cap while reading and scanning", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    await store.finalize(handle);
    const payload = JSON.stringify({
      version: 1,
      entry: { kind: "assistant", ts: "2026-09-23T00:00:00.000Z", text: "x".repeat(2 * 1024 * 1024) },
    });
    await fs.writeFile(path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`), `${payload}\n`, "utf8");
    const metadataPath = path.join(root, "transcript-objects", `${handle.objectRef}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.bytes = Buffer.byteLength(`${payload}\n`, "utf8");
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

    await expect(store.readRange({ ...readInput(handle.objectRef) }))
      .rejects.toThrow("Transcript object line limit exceeded");
    await expect(store.finalize(handle)).rejects.toThrow("Transcript object line limit exceeded");
  });

  it("rejects forged references and every cross-binding read", async () => {
    const { store } = await fixture();
    const objectRef = await store.write({ ...binding, entries });

    await expect(store.readRange({ ...readInput("tobj_v1_00000000-0000-0000-0000-000000000000") })).rejects.toMatchObject({ status: 404 });
    await expect(store.readRange({ ...readInput(objectRef), objectRef: "../outside" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), orgId: "org-2" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), runId: "run-2" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), spanId: "span-2" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), ownerToken: "owner-secret-2" })).rejects.toMatchObject({ status: 403 });
  });

  it("exposes only the span supplemental ref through the Reader hook", async () => {
    const { store } = await fixture();
    const objectRef = await store.write({ ...binding, entries: [entries[0]!] });
    const reader = createTranscriptObjectReader(store);
    const input = {
      readonly: true,
      scope: "run",
      orgId: binding.orgId,
      run: { id: binding.runId },
      span: {
        id: binding.spanId,
        ownerToken: binding.ownerToken,
        supplementalObjectRef: objectRef,
      },
    } as unknown as NativeTranscriptReadInput;

    await expect(reader.readRange!(input)).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "complete",
      entries: [expect.objectContaining({ text: "first" })],
    });
    await expect(reader.readRange!({
      ...input,
      span: { ...input.span, supplementalObjectRef: null },
    })).resolves.toMatchObject({ availability: "missing", completeness: "unknown", items: [] });
  });

  it("keeps the source owner hash while allowing only the attached Reader path to read after owner recovery", async () => {
    const { store } = await fixture();
    const objectRef = await store.write({ ...binding, entries: [entries[0]!] });

    await expect(store.readRange({
      ...readInput(objectRef),
      ownerToken: "recovered-owner",
    })).rejects.toMatchObject({ status: 403 });

    const reader = createTranscriptObjectReader(store);
    const input = {
      readonly: true,
      scope: "run",
      orgId: binding.orgId,
      run: { id: binding.runId },
      span: {
        id: binding.spanId,
        ownerToken: "recovered-owner",
        supplementalObjectRef: objectRef,
      },
    } as unknown as import("./transcript-reader.js").NativeTranscriptReadInput;
    await expect(reader.readRange!(input)).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "complete",
      entries: [expect.objectContaining({ text: "first" })],
    });
  });

  it("resumes the attached open object for owner recovery without changing its lineage", async () => {
    const { store } = await fixture();
    const original = await store.begin(binding);
    await store.append(original, entries[0]!);

    await expect(store.resume({
      ...binding,
      orgId: "org-2",
      objectRef: original.objectRef,
    })).rejects.toMatchObject({ status: 403 });

    const recovered = await store.resume({
      ...binding,
      ownerToken: "recovered-owner",
      objectRef: original.objectRef,
    });
    await store.append(recovered, entries[1]!);
    await expect(store.finalize(recovered, { completeness: "partial" })).resolves.toMatchObject({
      objectRef: original.objectRef,
      completeness: "partial",
      entryCount: 2,
    });

    await expect(store.readRange({
      ...readInput(original.objectRef),
      ownerToken: "recovered-owner",
    })).rejects.toMatchObject({ status: 403 });

    const reader = createTranscriptObjectReader(store);
    const input = {
      readonly: true,
      scope: "run",
      orgId: binding.orgId,
      run: { id: binding.runId },
      span: {
        id: binding.spanId,
        ownerToken: "recovered-owner",
        supplementalObjectRef: original.objectRef,
      },
    } as unknown as NativeTranscriptReadInput;
    await expect(reader.readRange!(input)).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "partial",
      entries,
    });
  });

  it("hides an uncommitted append and discards its torn tail before recovery", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    const payloadPath = path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`);
    const committedBytes = (await fs.stat(payloadPath)).size;
    await fs.appendFile(payloadPath, `${JSON.stringify({ version: 1, entry: entries[1] })}\n{"version":1,"entry":`, "utf8");

    const before = await store.readRange({ ...readInput(handle.objectRef), limit: 10 });
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0]).toMatchObject({ text: "first" });
    const recoveredStore = createTranscriptObjectStore(root);
    const recovered = await recoveredStore.resume({ ...binding, objectRef: handle.objectRef });
    expect((await fs.stat(payloadPath)).size).toBe(committedBytes);
    await recoveredStore.append(recovered, entries[1]!);
    await expect(recoveredStore.finalize(recovered)).resolves.toMatchObject({ entryCount: 2 });
    const after = await recoveredStore.readRange({ ...readInput(handle.objectRef), limit: 10 });
    expect(after.entries).toMatchObject([{ text: "first" }, { content: "second" }]);
    expect(after.completeness).toBe("complete");
  });

  it("seals only committed entries after a failed append leaves a tail", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    const payloadPath = path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`);
    const committedBytes = (await fs.stat(payloadPath)).size;
    await fs.appendFile(payloadPath, '{"version":1,"entry":', "utf8");

    await expect(store.finalize(handle)).resolves.toMatchObject({ entryCount: 1, bytes: committedBytes });
    expect((await fs.stat(payloadPath)).size).toBe(committedBytes);
    const result = await store.readRange(readInput(handle.objectRef));
    expect(result.entries).toHaveLength(1);
    expect(result.completeness).toBe("complete");
  });

  it("refuses to resume or append when committed payload bytes are missing", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    const payloadPath = path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`);
    await fs.truncate(payloadPath, 1);
    const recoveredStore = createTranscriptObjectStore(root);
    await expect(recoveredStore.resume({ ...binding, objectRef: handle.objectRef }))
      .rejects.toThrow("shorter than committed metadata");
    await expect(store.append(handle, entries[1]!)).rejects.toThrow("shorter than committed metadata");
    await expect(store.finalize(handle)).rejects.toThrow("shorter than committed metadata");
    await expect(store.readRange(readInput(handle.objectRef))).rejects.toThrow("does not match committed metadata");
  });

  it("sweeps only old unreferenced objects and preserves protected or recent objects", async () => {
    const { root, store } = await fixture();
    const protectedRef = await store.write({ ...binding, entries: [entries[0]!] });
    const collectableRef = await store.write({ ...binding, entries: [entries[1]!] });
    const recentRef = await store.write({ ...binding, entries: [entries[0]!] });
    const now = new Date();
    const oldUpdatedAt = new Date(now.getTime() - 60_000).toISOString();
    const metadataPath = (ref: string) => path.join(root, "transcript-objects", `${ref}.json`);
    for (const ref of [protectedRef, collectableRef]) {
      const metadata = JSON.parse(await fs.readFile(metadataPath(ref), "utf8")) as Record<string, unknown>;
      metadata.updatedAt = oldUpdatedAt;
      await fs.writeFile(metadataPath(ref), `${JSON.stringify(metadata)}\n`, "utf8");
    }

    const swept = await store.sweepUnreferenced({
      protectedObjectRefs: [protectedRef],
      now,
      minAgeMs: 1_000,
    });
    expect(swept).toMatchObject({
      scanned: 3,
      protected: 1,
      deletedObjectRefs: [collectableRef],
    });
    await expect(fs.stat(metadataPath(protectedRef))).resolves.toBeTruthy();
    await expect(fs.stat(metadataPath(collectableRef))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(metadataPath(recentRef))).resolves.toBeTruthy();
  });

  it("preserves aged payload-only crash-window files without invoking the retention guard", async () => {
    const { root, store } = await fixture();
    const objectRoot = path.join(root, "transcript-objects");
    await fs.mkdir(objectRoot, { recursive: true });
    const emptyRef = `tobj_v1_${randomUUID()}`;
    const recoverableRef = `tobj_v1_${randomUUID()}`;
    const emptyPath = path.join(objectRoot, `${emptyRef}.ndjson`);
    const recoverablePath = path.join(objectRoot, `${recoverableRef}.ndjson`);
    const oldDate = new Date("2026-09-20T00:00:00.000Z");
    await fs.writeFile(emptyPath, "", "utf8");
    await fs.writeFile(recoverablePath, `${JSON.stringify({ version: 1, entry: entries[0] })}\n`, "utf8");
    await fs.utimes(emptyPath, oldDate, oldDate);
    await fs.utimes(recoverablePath, oldDate, oldDate);
    const withRetentionGuard = vi.fn(async () => "deleted" as const);

    const swept = await store.sweepUnreferenced({
      protectedObjectRefs: [emptyRef],
      withRetentionGuard,
      now: new Date("2026-09-24T00:00:00.000Z"),
      minAgeMs: 1_000,
    });

    expect(swept.deletedObjectRefs).toEqual([]);
    expect(withRetentionGuard).not.toHaveBeenCalled();
    await expect(fs.readFile(emptyPath, "utf8")).resolves.toBe("");
    await expect(fs.readFile(recoverablePath, "utf8")).resolves.toContain("first");
  });

  it("preserves symlinked payload-only files and their targets", async () => {
    const { root, store } = await fixture();
    const objectRoot = path.join(root, "transcript-objects");
    await fs.mkdir(objectRoot, { recursive: true });
    const ref = `tobj_v1_${randomUUID()}`;
    const linkPath = path.join(objectRoot, `${ref}.ndjson`);
    const targetPath = path.join(root, "recoverable-transcript.ndjson");
    await fs.writeFile(targetPath, "recoverable payload\n", "utf8");
    await fs.symlink(targetPath, linkPath);

    const swept = await store.sweepUnreferenced({ now: new Date(), minAgeMs: 0 });

    expect(swept.deletedObjectRefs).toEqual([]);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("recoverable payload\n");
  });

  it("does not destroy malformed or incomplete objects during a sweep", async () => {
    const { root, store } = await fixture();
    const objectRef = await store.write({ ...binding, entries: [entries[0]!] });
    const metadataPath = path.join(root, "transcript-objects", `${objectRef}.json`);
    const payloadPath = path.join(root, "transcript-objects", `${objectRef}.ndjson`);
    await fs.writeFile(metadataPath, "not-json\n", "utf8");

    const swept = await store.sweepUnreferenced({
      now: new Date("2026-09-23T00:00:00.000Z"),
      minAgeMs: 0,
    });
    expect(swept.deletedObjectRefs).toEqual([]);
    expect(swept.skipped).toBe(1);
    await expect(fs.stat(metadataPath)).resolves.toBeTruthy();
    await expect(fs.readFile(payloadPath, "utf8")).resolves.toContain("first");
  });

  it("bounds sweeps when the caller does not provide a limit", async () => {
    const { root, store } = await fixture();
    const objectRoot = path.join(root, "transcript-objects");
    await fs.mkdir(objectRoot, { recursive: true });
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 60_000).toISOString();
    const objectCount = 501;
    for (let index = 0; index < objectCount; index += 1) {
      const ref = `tobj_v1_${randomUUID()}`;
      await fs.writeFile(path.join(objectRoot, `${ref}.json`), `${JSON.stringify({
        version: 1,
        objectRef: ref,
        orgId: binding.orgId,
        runId: binding.runId,
        spanId: binding.spanId,
        sourceOwnerHash: "0".repeat(64),
        state: "sealed",
        completeness: "complete",
        entryCount: 0,
        bytes: 0,
        createdAt: updatedAt,
        updatedAt,
      })}\n`, "utf8");
    }

    const swept = await store.sweepUnreferenced({ now, minAgeMs: 0 });
    expect(swept.scanned).toBeGreaterThan(0);
    expect(swept.scanned).toBeLessThan(objectCount);
    expect(swept.skipped).toBe(swept.scanned);

    const nextBatch = await store.sweepUnreferenced({ now, minAgeMs: 0 });
    expect(nextBatch.scanned).toBe(objectCount - swept.scanned);
    expect(nextBatch.skipped).toBe(nextBatch.scanned);
  });
});
