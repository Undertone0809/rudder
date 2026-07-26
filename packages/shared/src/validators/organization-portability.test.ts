import { describe, expect, it } from "vitest";
import {
  portabilityAgentManifestEntrySchema,
  portabilityTargetSchema,
} from "./organization-portability.js";

describe("portabilityTargetSchema", () => {
  it("normalizes an explicit new-organization Issue Key", () => {
    expect(portabilityTargetSchema.parse({
      mode: "new_organization",
      newOrganizationName: "Imported Rudder",
      newOrganizationIssueKey: " im7 ",
    })).toMatchObject({ newOrganizationIssueKey: "IM7" });
  });

  it("rejects an invalid new-organization Issue Key", () => {
    expect(() => portabilityTargetSchema.parse({
      mode: "new_organization",
      newOrganizationIssueKey: "7IM",
    })).toThrow(/Issue key must start with a letter/);
  });
});

const baseAgent = {
  slug: "builder",
  name: "Builder",
  path: "agents/builder/AGENTS.md",
  skills: [],
  role: "engineer",
  title: null,
  icon: null,
  capabilities: null,
  agentRuntimeType: "process",
  agentRuntimeConfig: {},
  runtimeConfig: {},
  permissions: {},
  budgetMonthlyCents: 0,
  metadata: null,
};

describe("organization portability agent compatibility", () => {
  it("continues accepting historical v4 reporting metadata", () => {
    expect(portabilityAgentManifestEntrySchema.parse({
      ...baseAgent,
      reportsToSlug: "lead",
    }).reportsToSlug).toBe("lead");
  });

  it("normalizes a missing reporting field to the deprecated v4 null shape", () => {
    expect(portabilityAgentManifestEntrySchema.parse(baseAgent).reportsToSlug).toBeNull();
  });
});
