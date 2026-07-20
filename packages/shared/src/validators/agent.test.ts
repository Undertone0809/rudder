import { describe, expect, it } from "vitest";
import { createAgentHireSchema, createAgentSchema, updateAgentSchema } from "./agent.js";

describe("agent avatar validation", () => {
  it("accepts Oreo, DiceBear Notionists, and uploaded image avatar references", () => {
    expect(
      createAgentSchema.parse({
        name: "Builder",
        icon: "oreo:nova:vanilla-sky:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }).icon,
    ).toBe("oreo:nova:vanilla-sky:cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    expect(
      createAgentSchema.parse({
        name: "Builder",
        icon: "dicebear:notionists:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb?bg=sky",
      }).icon,
    ).toBe("dicebear:notionists:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb?bg=sky");

    expect(
      updateAgentSchema.parse({
        icon: "asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?bg=mint",
      }).icon,
    ).toBe("asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?bg=mint");
  });

  it("rejects custom text and emoji avatar values", () => {
    expect(() => updateAgentSchema.parse({ icon: "WE" })).toThrow();
    expect(() => updateAgentSchema.parse({ icon: "🧪" })).toThrow();
    expect(() => updateAgentSchema.parse({
      icon: "asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?bg=neon",
    })).toThrow();
  });

  it.each([
    "oreo:unknown:rose-milk:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "oreo:bloom:unknown:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "oreo:bloom:rose-milk:not-a-uuid",
    "oreo:bloom:rose-milk",
    "oreo::rose-milk:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "oreo:bloom::cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "oreo:bloom:rose-milk:cccccccc-cccc-4ccc-8ccc-cccccccccccc?bg=sky",
  ])("rejects malformed Oreo avatar reference %s", (icon) => {
    expect(() => updateAgentSchema.parse({ icon })).toThrow("Invalid Oreo avatar reference");
  });
});

describe("agent permission validation", () => {
  it("defaults new agents to agent creation access", () => {
    expect(
      createAgentSchema.parse({
        name: "Builder",
        permissions: {},
      }).permissions,
    ).toEqual({
      canCreateAgents: true,
      canManageSkills: true,
    });
  });

  it("preserves an explicit agent creation denial", () => {
    expect(
      createAgentSchema.parse({
        name: "Builder",
        permissions: { canCreateAgents: false },
      }).permissions?.canCreateAgents,
    ).toBe(false);
  });
});

describe("agent intelligence seeding validation", () => {
  it("allows organization intelligence seeding only on direct agent creation", () => {
    expect(
      createAgentSchema.parse({
        name: "Builder",
        seedOrganizationIntelligenceDefaults: true,
      }).seedOrganizationIntelligenceDefaults,
    ).toBe(true);

    expect(
      createAgentHireSchema.parse({
        name: "Builder",
        seedOrganizationIntelligenceDefaults: true,
      } as unknown),
    ).not.toHaveProperty("seedOrganizationIntelligenceDefaults");

    expect(
      updateAgentSchema.parse({
        name: "Builder",
        seedOrganizationIntelligenceDefaults: true,
      } as unknown),
    ).not.toHaveProperty("seedOrganizationIntelligenceDefaults");
  });
});
