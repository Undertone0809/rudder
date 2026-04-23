import { describe, expect, it } from "vitest";
import {
  isOnboardingPath,
  resolveRouteOnboardingOptions,
  shouldRedirectOrganizationlessRouteToOnboarding,
} from "./onboarding-route";

describe("isOnboardingPath", () => {
  it("matches the global onboarding route", () => {
    expect(isOnboardingPath("/onboarding")).toBe(true);
  });

  it("matches a organization-prefixed onboarding route", () => {
    expect(isOnboardingPath("/pap/onboarding")).toBe(true);
  });

  it("ignores non-onboarding routes", () => {
    expect(isOnboardingPath("/pap/dashboard")).toBe(false);
  });
});

describe("resolveRouteOnboardingOptions", () => {
  it("opens organization creation for the global onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding",
        organizations: [],
      }),
    ).toEqual({ initialStep: 1 });
  });

  it("opens agent creation when the prefixed organization exists", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        orgPrefix: "pap",
        organizations: [{ id: "organization-1", issuePrefix: "PAP" }],
      }),
    ).toEqual({ initialStep: 2, orgId: "organization-1" });
  });

  it("falls back to organization creation when the prefixed organization is missing", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        orgPrefix: "pap",
        organizations: [],
      }),
    ).toEqual({ initialStep: 1 });
  });
});

describe("shouldRedirectOrganizationlessRouteToOnboarding", () => {
  it("redirects companyless entry routes into onboarding", () => {
    expect(
      shouldRedirectOrganizationlessRouteToOnboarding({
        pathname: "/",
        hasOrganizations: false,
      }),
    ).toBe(true);
  });

  it("does not redirect when already on onboarding", () => {
    expect(
      shouldRedirectOrganizationlessRouteToOnboarding({
        pathname: "/onboarding",
        hasOrganizations: false,
      }),
    ).toBe(false);
  });

  it("does not redirect when organizations exist", () => {
    expect(
      shouldRedirectOrganizationlessRouteToOnboarding({
        pathname: "/issues",
        hasOrganizations: true,
      }),
    ).toBe(false);
  });
});
