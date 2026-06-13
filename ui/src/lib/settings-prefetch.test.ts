import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessApi } from "@/api/access";
import { healthApi } from "@/api/health";
import { organizationsApi } from "@/api/orgs";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  listSettingsPrefetchQueryKeys,
  scheduleSettingsPrefetchQueries,
} from "./settings-prefetch";

vi.mock("@/api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: vi.fn(async () => ({ isInstanceAdmin: true })),
  },
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    list: vi.fn(async () => []),
  },
}));

vi.mock("@/api/health", () => ({
  healthApi: {
    get: vi.fn(async () => ({ version: "test" })),
  },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    listInstanceSchedulerAgents: vi.fn(async () => []),
  },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: vi.fn(async () => ({ locale: "en" })),
    getLangfuse: vi.fn(async () => ({})),
    getNotifications: vi.fn(async () => ({})),
    getProfile: vi.fn(async () => ({ nickname: "", moreAboutYou: "" })),
    getShortcuts: vi.fn(async () => ({ shortcuts: [] })),
  },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    listLabels: vi.fn(async () => []),
  },
}));

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    list: vi.fn(async () => []),
  },
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    list: vi.fn(async () => []),
  },
}));

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

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

describe("scheduleSettingsPrefetchQueries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers settings prefetch work off the immediate click path", async () => {
    const queryClient = makeQueryClient();

    scheduleSettingsPrefetchQueries(queryClient, {
      target: "/instance/settings/general",
      organizationId: "org_123",
    });

    expect(accessApi.getCurrentBoardAccess).not.toHaveBeenCalled();
    expect(organizationsApi.list).not.toHaveBeenCalled();
    expect(instanceSettingsApi.getGeneral).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(accessApi.getCurrentBoardAccess).toHaveBeenCalledTimes(1);
    expect(organizationsApi.list).toHaveBeenCalledTimes(1);
    expect(instanceSettingsApi.getGeneral).toHaveBeenCalledTimes(1);
  });

  it("dedupes repeated warm calls for the same settings target", async () => {
    const queryClient = makeQueryClient();

    scheduleSettingsPrefetchQueries(queryClient, {
      target: "/instance/settings/about",
      organizationId: "org_123",
    });
    scheduleSettingsPrefetchQueries(queryClient, {
      target: "/instance/settings/about",
      organizationId: "org_123",
    });

    await vi.runOnlyPendingTimersAsync();

    expect(accessApi.getCurrentBoardAccess).toHaveBeenCalledTimes(1);
    expect(organizationsApi.list).toHaveBeenCalledTimes(1);
    expect(healthApi.get).toHaveBeenCalledTimes(1);
  });
});
