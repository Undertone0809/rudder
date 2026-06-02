import { describe, expect, it } from "vitest";
import type { AgentRuntimeAvailability } from "@rudderhq/shared";
import {
  ONBOARDING_RUNTIME_INSTALL_HINTS,
  buildRuntimeAvailabilityMap,
  isRuntimeSelectable,
  listMissingRuntimes,
  pickFirstAvailableRuntime,
} from "./onboarding-runtime-availability";

function runtime(
  agentRuntimeType: string,
  available: boolean,
): AgentRuntimeAvailability {
  return {
    agentRuntimeType,
    label: agentRuntimeType,
    command: agentRuntimeType,
    status: available ? "available" : "missing",
    available,
    installUrl: "https://example.com/install",
    installLabel: "Install",
    detail: null,
    checkedAt: "2026-06-02T00:00:00.000Z",
  };
}

describe("onboarding runtime availability", () => {
  it("does not treat missing local runtimes as selectable", () => {
    const availability = buildRuntimeAvailabilityMap([
      runtime("claude_local", false),
      runtime("codex_local", true),
      runtime("opencode_local", false),
    ]);

    expect(isRuntimeSelectable("opencode_local", availability)).toBe(false);
    expect(isRuntimeSelectable("codex_local", availability)).toBe(true);
    expect(pickFirstAvailableRuntime(availability)).toBe("codex_local");
    expect(listMissingRuntimes(availability).map((entry) => entry.agentRuntimeType)).toEqual([
      "claude_local",
      "opencode_local",
    ]);
  });

  it("keeps static install hints available when live availability fails", () => {
    expect(ONBOARDING_RUNTIME_INSTALL_HINTS.some((entry) => (
      entry.agentRuntimeType === "opencode_local" && entry.installUrl.includes("opencode.ai")
    ))).toBe(true);
    expect(ONBOARDING_RUNTIME_INSTALL_HINTS.some((entry) => (
      entry.agentRuntimeType === "cursor" && entry.installUrl.includes("cursor.com")
    ))).toBe(true);
  });
});
