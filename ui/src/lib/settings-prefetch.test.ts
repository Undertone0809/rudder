import { describe, expect, it } from "vitest";
import { listSettingsPrefetchQueryKeys } from "./settings-prefetch";

describe("listSettingsPrefetchQueryKeys", () => {
  it("includes organization caches for organization settings", () => {
    expect(listSettingsPrefetchQueryKeys("/organization/settings", "org_123")).toEqual([
      ["access", "current-board-access"],
      ["organizations"],
      ["chats", "org_123", "archived"],
      ["issues", "org_123", "labels"],
    ]);
  });

  it("prefetches only the relevant instance settings page", () => {
    expect(listSettingsPrefetchQueryKeys("/instance/settings/profile", "org_123")).toEqual([
      ["access", "current-board-access"],
      ["organizations"],
      ["instance", "profile-settings"],
    ]);

    expect(listSettingsPrefetchQueryKeys("/instance/settings/langfuse", "org_123")).toEqual([
      ["access", "current-board-access"],
      ["organizations"],
      ["instance", "langfuse-settings"],
    ]);

    expect(listSettingsPrefetchQueryKeys("/instance/settings/notifications", "org_123")).toEqual([
      ["access", "current-board-access"],
      ["organizations"],
      ["instance", "notification-settings"],
    ]);

    expect(listSettingsPrefetchQueryKeys("/instance/settings/organizations", "org_123")).toEqual([
      ["access", "current-board-access"],
      ["organizations"],
      ["organizations", "stats"],
    ]);

    expect(listSettingsPrefetchQueryKeys("/instance/settings/heartbeats", "org_123")).toEqual([
      ["access", "current-board-access"],
      ["organizations"],
      ["instance", "scheduler-heartbeats"],
    ]);
  });

  it("falls back to core settings metadata for unknown targets", () => {
    expect(listSettingsPrefetchQueryKeys("/instance/settings/plugins/example", null)).toEqual([
      ["access", "current-board-access"],
      ["organizations"],
      ["plugins"],
    ]);
  });
});
