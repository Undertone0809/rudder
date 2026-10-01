import { describe, expect, it } from "vitest";
import { getUIAdapter, listUIAdapters } from "./registry";

describe("UI runtime registry", () => {
  it("keeps removed Gemini agents out of the executable adapters while decoding their history", () => {
    const adapter = getUIAdapter("gemini_local");

    expect(adapter.type).toBe("gemini_local");
    expect(adapter.label).toBe("Gemini CLI (removed)");
    expect(
      adapter.parseStdoutLine(
        '{"type":"message","content":"Gemini output"}',
        "2026-09-30T00:00:00.000Z",
      ),
    ).toEqual([{ kind: "assistant", ts: "2026-09-30T00:00:00.000Z", text: "Gemini output" }]);
    expect(listUIAdapters().some((entry) => entry.type === "gemini_local")).toBe(false);
    expect(getUIAdapter("openclaw_gateway").type).toBe("openclaw_gateway");
  });
});
