import { describe, expect, it } from "vitest";
import {
  appBuilderOpaqueBindingSchema,
  createAppBuilderAppSchema,
  updateAppBuilderBuildSchema,
} from "./app-builder.js";

describe("App Builder validators", () => {
  it("accepts a workspace-relative app source root", () => {
    expect(
      createAppBuilderAppSchema.parse({
        name: "Cold Email CRM",
        sourceRoot: "apps/cold-email-crm",
        scaffoldVersion: "1",
      }),
    ).toMatchObject({
      sourceRoot: "apps/cold-email-crm",
      scaffoldVersion: "1",
    });
  });

  it.each([
    "/tmp/cold-email-crm",
    "../cold-email-crm",
    "apps/nested/cold-email-crm",
    "apps/.hidden",
    "apps/ColdEmail",
    "apps/cold_email",
  ])("rejects an unsafe or non-canonical source root: %s", (sourceRoot) => {
    expect(() =>
      createAppBuilderAppSchema.parse({
        name: "Cold Email CRM",
        sourceRoot,
        scaffoldVersion: "1",
      }),
    ).toThrow();
  });

  it("keeps the Desktop app slug boundary at 63 characters", () => {
    expect(() => createAppBuilderAppSchema.parse({
      name: "Long App",
      sourceRoot: `apps/${"a".repeat(63)}`,
      scaffoldVersion: "1",
    })).not.toThrow();
    expect(() => createAppBuilderAppSchema.parse({
      name: "Too Long App",
      sourceRoot: `apps/${"a".repeat(64)}`,
      scaffoldVersion: "1",
    })).toThrow();
  });

  it("defaults build updates to the build run kind", () => {
    expect(updateAppBuilderBuildSchema.parse({ status: "building" })).toEqual({
      status: "building",
      runKind: "build",
    });
  });

  it("accepts the explicit verification lifecycle status", () => {
    expect(
      updateAppBuilderBuildSchema.parse({
        status: "verifying",
        runKind: "verification",
      }),
    ).toEqual({
      status: "verifying",
      runKind: "verification",
    });
  });

  it("requires the verification run kind when entering verification", () => {
    expect(() =>
      updateAppBuilderBuildSchema.parse({
        status: "verifying",
      }),
    ).toThrow();
  });

  it("accepts only bounded opaque local binding identifiers", () => {
    expect(
      appBuilderOpaqueBindingSchema.parse({
        desktopInstallationId: "desktop_01HXYZ",
        appPublicId: "app_01HXYZ",
        localBindingId: "binding_01HXYZ",
      }),
    ).toEqual({
      desktopInstallationId: "desktop_01HXYZ",
      appPublicId: "app_01HXYZ",
      localBindingId: "binding_01HXYZ",
    });

    expect(() =>
      appBuilderOpaqueBindingSchema.parse({
        desktopInstallationId: "desktop/../../../tmp",
        appPublicId: "app-1",
        localBindingId: "binding-1",
      }),
    ).toThrow();
  });
});
