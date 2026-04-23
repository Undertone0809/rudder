import { describe, expect, it } from "vitest";
import {
  getRememberedPathOwnerOrganizationId,
  sanitizeRememberedPathForOrganization,
} from "../lib/organization-page-memory";

const organizations = [
  { id: "for", issuePrefix: "FOR", urlKey: "forge" },
  { id: "pap", issuePrefix: "PAP", urlKey: "paper" },
];

describe("getRememberedPathOwnerOrganizationId", () => {
  it("uses the route organization instead of stale selected-organization state for prefixed routes", () => {
    expect(
      getRememberedPathOwnerOrganizationId({
        organizations,
        pathname: "/FOR/issues/FOR-1",
        fallbackOrganizationId: "pap",
      }),
    ).toBe("for");
  });

  it("resolves route ownership when the path uses the organization's urlKey alias", () => {
    expect(
      getRememberedPathOwnerOrganizationId({
        organizations,
        pathname: "/paper/dashboard",
        fallbackOrganizationId: "for",
      }),
    ).toBe("pap");
  });

  it("skips saving when a prefixed route cannot yet be resolved to a known organization", () => {
    expect(
      getRememberedPathOwnerOrganizationId({
        organizations: [],
        pathname: "/FOR/issues/FOR-1",
        fallbackOrganizationId: "pap",
      }),
    ).toBeNull();
  });

  it("falls back to the previous organization for unprefixed board routes", () => {
    expect(
      getRememberedPathOwnerOrganizationId({
        organizations,
        pathname: "/dashboard",
        fallbackOrganizationId: "pap",
      }),
    ).toBe("pap");
  });

  it("treats unprefixed skills routes as board routes instead of organization prefixes", () => {
    expect(
      getRememberedPathOwnerOrganizationId({
        organizations,
        pathname: "/skills/skill-123/files/SKILL.md",
        fallbackOrganizationId: "pap",
      }),
    ).toBe("pap");
  });
});

describe("sanitizeRememberedPathForOrganization", () => {
  it("keeps remembered issue paths that belong to the target organization", () => {
    expect(
      sanitizeRememberedPathForOrganization({
        path: "/issues/PAP-12",
        organizationPrefix: "PAP",
      }),
    ).toBe("/issues/PAP-12");
  });

  it("falls back to dashboard for remembered issue identifiers from another organization", () => {
    expect(
      sanitizeRememberedPathForOrganization({
        path: "/issues/FOR-1",
        organizationPrefix: "PAP",
      }),
    ).toBe("/dashboard");
  });

  it("falls back to dashboard when no remembered path exists", () => {
    expect(
      sanitizeRememberedPathForOrganization({
        path: null,
        organizationPrefix: "PAP",
      }),
    ).toBe("/dashboard");
  });

  it("keeps remembered skills paths intact for the target organization", () => {
    expect(
      sanitizeRememberedPathForOrganization({
        path: "/skills/skill-123/files/SKILL.md",
        organizationPrefix: "PAP",
      }),
    ).toBe("/skills/skill-123/files/SKILL.md");
  });
});
