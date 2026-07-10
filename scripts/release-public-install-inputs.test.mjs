import { describe, expect, it } from "vitest";
import {
  validatePublicInstallPackageSpec,
  validatePublicInstallReleaseRepo,
} from "./public-install-inputs.mjs";

describe("public install smoke inputs", () => {
  it.each([
    "@rudderhq/cli@latest",
    "@rudderhq/cli@canary",
    "@rudderhq/cli@1.2.3",
    "@rudderhq/cli@1.2.3-canary.4",
  ])("accepts an approved package spec: %s", (value) => {
    expect(validatePublicInstallPackageSpec(value)).toBe(value);
  });

  it.each([
    "left-pad@latest",
    "@rudderhq/cli@next",
    "@rudderhq/cli@^1.2.3",
    "@rudderhq/cli@latest & whoami",
    "@rudderhq/cli@latest|whoami",
  ])("rejects an unsafe package spec: %s", (value) => {
    expect(() => validatePublicInstallPackageSpec(value)).toThrow();
  });

  it("accepts a GitHub owner/repository slug", () => {
    expect(validatePublicInstallReleaseRepo("Undertone0809/rudder")).toBe(
      "Undertone0809/rudder",
    );
  });

  it.each([
    "Undertone0809/rudder & whoami",
    "Undertone0809/rudder|whoami",
    "Undertone0809/rudder/extra",
    "-invalid/rudder",
  ])("rejects an unsafe repository slug: %s", (value) => {
    expect(() => validatePublicInstallReleaseRepo(value)).toThrow();
  });
});
