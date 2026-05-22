import { describe, expect, it } from "vitest";
import { createAgentSchema, updateAgentSchema } from "./agent.js";

describe("agent avatar validation", () => {
  it("accepts DiceBear Notionists and uploaded image avatar references", () => {
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
});
