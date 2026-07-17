// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHiddenIssueThreadsStorageKey,
  getMessengerDefaultThreadOrderStorageKey,
  getMessengerThreadGroupOrderStorageKey,
  readCollapsedThreadGroups,
  readHiddenIssueThreadWatermarks,
  readSplitIssueNotifications,
  readStringList,
  readThreadDensity,
  readThreadOrganizationRule,
  writeCollapsedThreadGroups,
  writeHiddenIssueThreadWatermarks,
  writeSplitIssueNotifications,
  writeStringList,
  writeThreadDensity,
  writeThreadOrganizationRule,
} from "./messenger-preferences";

describe("messenger preferences", () => {
  let values: Record<string, string>;

  beforeEach(() => {
    values = {};
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => values[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          values[key] = value;
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses safe defaults for missing and malformed organization preferences", () => {
    values["rudder.messengerThreadOrganizationByOrg"] = "{";
    values["rudder.messengerThreadDensityByOrg"] = JSON.stringify({ "org-1": "oversized" });
    values["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-1": "yes" });

    expect(readThreadOrganizationRule("org-1")).toBe("latest");
    expect(readThreadDensity("org-1")).toBe("compact");
    expect(readSplitIssueNotifications("org-1")).toBe(true);
    expect(readCollapsedThreadGroups("org-1", "attention")).toEqual(new Set());
  });

  it("preserves other organizations while updating organization-scoped preferences", () => {
    values["rudder.messengerThreadOrganizationByOrg"] = JSON.stringify({ "org-2": "agent" });
    values["rudder.messengerThreadDensityByOrg"] = JSON.stringify({ "org-2": "comfortable" });
    values["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-2": false });

    writeThreadOrganizationRule("org-1", "project");
    writeThreadDensity("org-1", "comfortable");
    writeSplitIssueNotifications("org-1", false);

    expect(JSON.parse(values["rudder.messengerThreadOrganizationByOrg"] ?? "{}")).toEqual({
      "org-1": "project",
      "org-2": "agent",
    });
    expect(JSON.parse(values["rudder.messengerThreadDensityByOrg"] ?? "{}")).toEqual({
      "org-1": "comfortable",
      "org-2": "comfortable",
    });
    expect(JSON.parse(values["rudder.messengerSplitIssueNotificationsByOrg"] ?? "{}")).toEqual({
      "org-1": false,
      "org-2": false,
    });
  });

  it("isolates user ordering keys and normalizes persisted string lists", () => {
    expect(getMessengerThreadGroupOrderStorageKey("org-1", " user-1 ", "agent"))
      .toBe("rudder.messengerThreadGroupOrder:agent:org-1:user-1");
    expect(getMessengerDefaultThreadOrderStorageKey("org-1", null))
      .toBe("rudder.messengerDefaultThreadOrder:org-1:anonymous");
    expect(getHiddenIssueThreadsStorageKey("org-1", "user-2"))
      .toBe("rudder.messengerHiddenIssueThreads:org-1:user-2");

    writeStringList("order", ["chat:1", "", "chat:2"]);
    expect(readStringList("order")).toEqual(["chat:1", "chat:2"]);

    values.order = JSON.stringify(["chat:3", 4, null]);
    expect(readStringList("order")).toEqual(["chat:3"]);
  });

  it("keeps collapsed groups scoped by organization and grouping rule", () => {
    writeCollapsedThreadGroups("org-1", "agent", new Set(["agent:1"]));
    writeCollapsedThreadGroups("org-1", "kind", new Set(["kind:chat"]));
    writeCollapsedThreadGroups("org-2", "agent", new Set(["agent:2"]));

    expect(readCollapsedThreadGroups("org-1", "agent")).toEqual(new Set(["agent:1"]));
    expect(readCollapsedThreadGroups("org-1", "kind")).toEqual(new Set(["kind:chat"]));
    expect(readCollapsedThreadGroups("org-2", "agent")).toEqual(new Set(["agent:2"]));
  });

  it("filters invalid hidden-thread watermarks and persists valid records", () => {
    values.hidden = JSON.stringify({ "issue:1": "watermark-1", "issue:2": 2, "": "ignored" });
    expect(readHiddenIssueThreadWatermarks("hidden")).toEqual({ "issue:1": "watermark-1" });

    writeHiddenIssueThreadWatermarks("hidden", { "issue:3": "watermark-3" });
    expect(JSON.parse(values.hidden ?? "{}")).toEqual({ "issue:3": "watermark-3" });
  });
});
