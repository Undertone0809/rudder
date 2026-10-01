import { describe, expect, it, vi } from "vitest";
import { readManifestTranscriptSnapshot } from "./chat-work-manifest.transcript-snapshot.js";
import { TranscriptReaderError } from "./runtime-kernel/transcript-reader.js";

describe("Work Manifest transcript snapshot", () => {
  it("discards a drifted projection and restarts its paging from the beginning", async () => {
    const pages: Array<string | null> = [];
    let revision = 0;
    const read = vi.fn(async () => {
      const items: string[] = [];
      pages.push(null);
      items.push(revision === 0 ? "stale first page" : "current first page");
      pages.push("next");
      if (revision++ === 0) throw new TranscriptReaderError("cursor_revision_mismatch", "changed");
      items.push("current second page");
      return items;
    });
    expect(await readManifestTranscriptSnapshot(read)).toEqual(["current first page", "current second page"]);
    expect(pages).toEqual([null, "next", null, "next"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated drift and reports an explicit retryable conflict instead of an internal error", async () => {
    const read = vi.fn().mockRejectedValue(new TranscriptReaderError("cursor_revision_mismatch", "changed"));
    await expect(readManifestTranscriptSnapshot(read)).rejects.toMatchObject({
      status: 409, details: { code: "work_manifest_revision_changed" },
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not retry or suppress authorization, missing-source or unexpected failures", async () => {
    for (const error of [new TranscriptReaderError("cursor_invalid", "invalid"), new Error("missing source")]) {
      const read = vi.fn().mockRejectedValue(error);
      await expect(readManifestTranscriptSnapshot(read)).rejects.toBe(error);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
});
