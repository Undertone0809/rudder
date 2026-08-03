// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  consumeRunFeedbackPendingFiles,
  stageRunFeedbackPendingFiles,
} from "./run-feedback-pending-files";

describe("run feedback pending files", () => {
  it("keeps files keyed by mutation and annotation until the side panel consumes them", () => {
    const first = new File(["first"], "first.txt", { type: "text/plain" });
    const second = new File(["second"], "second.txt", { type: "text/plain" });

    stageRunFeedbackPendingFiles("mutation-1", "annotation-1", [first]);
    stageRunFeedbackPendingFiles("mutation-1", "annotation-2", [second]);

    expect(consumeRunFeedbackPendingFiles("mutation-1")).toEqual({
      "annotation-1": [first],
      "annotation-2": [second],
    });
    expect(consumeRunFeedbackPendingFiles("mutation-1")).toEqual({});
    expect(consumeRunFeedbackPendingFiles("mutation-2")).toEqual({});
  });
});
