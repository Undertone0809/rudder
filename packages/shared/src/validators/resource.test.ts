import { describe, expect, it } from "vitest";
import {
  createOrganizationResourceSchema,
  updateOrganizationResourceSchema,
} from "./resource.js";

describe("organization resource validators", () => {
  it("accepts library resources with normalized relative locators", () => {
    expect(createOrganizationResourceSchema.parse({
      name: "Spec",
      kind: "file",
      sourceType: "library",
      locator: "projects/product/spec.md",
    })).toMatchObject({
      sourceType: "library",
      locator: "projects/product/spec.md",
    });
  });

  it("accepts project Library root locators for directory resources", () => {
    expect(createOrganizationResourceSchema.parse({
      name: "Product folder",
      kind: "directory",
      sourceType: "library",
      locator: "projects/product",
    })).toMatchObject({
      sourceType: "library",
      locator: "projects/product",
    });
  });

  it("rejects library resources that are not file or directory resources", () => {
    expect(() => createOrganizationResourceSchema.parse({
      name: "Website",
      kind: "url",
      sourceType: "library",
      locator: "projects/product/spec.md",
    })).toThrow(/file or directory/);
  });

  it.each([
    "https://example.com/spec.md",
    "/Users/acme/spec.md",
    "../spec.md",
    "docs/spec.md",
    "projects/spec.md",
    "docs/../spec.md",
    "docs//spec.md",
    "docs/./spec.md",
    "docs\\spec.md",
    "agents/builder--123/instructions/SOUL.md",
    "artifacts/report.md",
    "plans/project-plan.md",
    "skills/writer/SKILL.md",
  ])("rejects unsafe library locator %s", (locator) => {
    expect(() => createOrganizationResourceSchema.parse({
      name: "Spec",
      kind: "file",
      sourceType: "library",
      locator,
    })).toThrow(/normalized project Library path/);
  });

  it("validates library update patches when the updated fields are present", () => {
    expect(() => updateOrganizationResourceSchema.parse({
      sourceType: "library",
      kind: "file",
      locator: "../outside.md",
    })).toThrow(/normalized project Library path/);
  });

  it("requires update patches to include a project child path unless they declare a directory resource", () => {
    expect(() => updateOrganizationResourceSchema.parse({
      sourceType: "library",
      locator: "projects/spec.md",
    })).toThrow(/normalized project Library path/);

    expect(updateOrganizationResourceSchema.parse({
      sourceType: "library",
      kind: "directory",
      locator: "projects/product",
    })).toMatchObject({
      sourceType: "library",
      kind: "directory",
      locator: "projects/product",
    });
  });
});
