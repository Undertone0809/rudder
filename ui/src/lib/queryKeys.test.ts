import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

describe("queryKeys agent runs", () => {
  it("uses an org-wide prefix key for broad invalidation", () => {
    expect(queryKeys.agentRuns("org-1")).toEqual(["agent-runs", "org-1"]);
  });

  it("keeps specific agent and limit keys under the org-wide prefix", () => {
    expect(queryKeys.agentRuns("org-1", "agent-1")).toEqual(["agent-runs", "org-1", "agent-1"]);
    expect(queryKeys.agentRuns("org-1", undefined, 50)).toEqual(["agent-runs", "org-1", undefined, 50]);
    expect(queryKeys.heartbeats("org-1")).toEqual(queryKeys.agentRuns("org-1"));
  });
});

describe("queryKeys instance Browser settings", () => {
  it("uses a stable instance-scoped key", () => {
    expect(queryKeys.instance.browserSettings).toEqual(["instance", "browser-settings"]);
  });
});
