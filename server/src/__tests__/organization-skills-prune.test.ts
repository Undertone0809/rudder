import { describe, expect, it } from "vitest";
import { listStaleBundledSkillIds } from "../services/organization-skills.js";

describe("organization bundled skill pruning", () => {
  it("prunes stale bundled rows that are no longer present in the current bundled set", () => {
    const staleIds = listStaleBundledSkillIds(
      [
        {
          id: "keep-rudder",
          key: "rudder/rudder",
          metadata: { sourceKind: "rudder_bundled" },
        },
        {
          id: "drop-agent-browser",
          key: "rudder/agent-browser",
          metadata: { sourceKind: "rudder_bundled" },
        },
        {
          id: "drop-legacy-paperclip",
          key: "rudder/office-hours",
          metadata: { sourceKind: "paperclip_bundled" },
        },
        {
          id: "keep-local",
          key: "organization/org-1/build-advisor",
          metadata: { sourceKind: "managed_local" },
        },
      ],
      ["rudder/rudder", "rudder/rudder-create-agent"],
    );

    expect(staleIds).toEqual(["drop-agent-browser", "drop-legacy-paperclip"]);
  });
});
