import { describe, expect, it } from "vitest";
import { resolveMessengerLoadState, resolveMessengerRoute } from "./useMessenger";

describe("resolveMessengerRoute Saved Views", () => {
  it("parses the Main Workbench route before falling back to the Messenger root", () => {
    expect(resolveMessengerRoute("/messenger/workbench")).toEqual({
      kind: "workbench",
    });
  });

  it("parses the stable Saved View workspace route", () => {
    expect(resolveMessengerRoute("/messenger/saved/30000000-0000-4000-8000-000000000001")).toEqual({
      kind: "saved_view",
      savedViewId: "30000000-0000-4000-8000-000000000001",
    });
  });
});

describe("resolveMessengerLoadState", () => {
  const loaded = { data: { value: true }, error: null, isLoading: false };

  it("does not let an unrelated thread-summary failure replace the Chat workspace", () => {
    expect(resolveMessengerLoadState(
      { kind: "chat", conversationId: "chat-1" },
      {
        threads: { data: undefined, error: new Error("Failed to fetch"), isLoading: false },
        issues: loaded,
        approvals: loaded,
        system: loaded,
      },
    )).toEqual({ isLoading: false, error: null });
  });

  it("preserves loaded route data when a background refresh fails", () => {
    expect(resolveMessengerLoadState(
      { kind: "issues" },
      {
        threads: loaded,
        issues: { data: { detail: {} }, error: new Error("Failed to fetch"), isLoading: false },
        approvals: loaded,
        system: loaded,
      },
    )).toEqual({ isLoading: false, error: null });
  });

  it("surfaces an initial failure for the route that owns the missing data", () => {
    const error = new Error("Failed to fetch");
    expect(resolveMessengerLoadState(
      { kind: "approvals" },
      {
        threads: loaded,
        issues: loaded,
        approvals: { data: undefined, error, isLoading: false },
        system: loaded,
      },
    )).toEqual({ isLoading: false, error });
  });
});
