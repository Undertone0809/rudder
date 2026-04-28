import { describe, expect, it } from "vitest";
import { PROJECT_COLORS } from "../constants.js";
import { createProjectSchema, updateProjectSchema } from "./project.js";

describe("project validators", () => {
  it("accepts supported gradient project colors", () => {
    expect(createProjectSchema.parse({
      name: "Gradient project",
      color: PROJECT_COLORS[0],
    }).color).toBe(PROJECT_COLORS[0]);
  });

  it("keeps legacy hex project colors valid", () => {
    expect(updateProjectSchema.parse({ color: "#336699" }).color).toBe("#336699");
  });

  it("rejects arbitrary CSS color payloads", () => {
    expect(() => updateProjectSchema.parse({ color: "url(https://example.com/color.png)" })).toThrow();
  });
});
