// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { openRunTranscriptLocalFile } from "./AgentDetail.run-log";

describe("openRunTranscriptLocalFile", () => {
  it("closes the fullscreen transcript before opening the basename-only local file target", () => {
    const calls: string[] = [];
    const openTarget = vi.fn((target) => {
      calls.push("open");
      return target;
    });
    const closeTranscriptDialog = vi.fn(() => calls.push("close"));

    openRunTranscriptLocalFile(
      openTarget,
      closeTranscriptDialog,
      "/workspace/src/RunTranscriptView.tsx",
      "/workspace/src/RunTranscriptView.tsx",
    );

    expect(calls).toEqual(["close", "open"]);
    expect(openTarget).toHaveBeenCalledWith({
      kind: "local_file",
      filePath: "/workspace/src/RunTranscriptView.tsx",
      label: "RunTranscriptView.tsx",
    });
  });
});
