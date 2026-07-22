import { describe, expect, it } from "vitest";
import { resolveMessengerRoute } from "./useMessenger";

describe("resolveMessengerRoute Saved Views", () => {
  it("parses the stable Saved View workspace route", () => {
    expect(resolveMessengerRoute("/messenger/saved/30000000-0000-4000-8000-000000000001")).toEqual({
      kind: "saved_view",
      savedViewId: "30000000-0000-4000-8000-000000000001",
    });
  });
});
