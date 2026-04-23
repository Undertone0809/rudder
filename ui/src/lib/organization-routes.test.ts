import { describe, expect, it } from "vitest";
import {
  applyOrganizationPrefix,
  extractOrganizationPrefixFromPath,
  findOrganizationByPrefix,
  toOrganizationRelativePath,
} from "./organization-routes";

describe("organization-routes", () => {
  it("prefixes unprefixed messenger paths and preserves the query string", () => {
    expect(
      applyOrganizationPrefix("/messenger?prefill=hello%20world", "ACM"),
    ).toBe("/ACM/messenger?prefill=hello%20world");
  });

  it("treats unprefixed messenger paths as board routes instead of organization-prefixed paths", () => {
    expect(extractOrganizationPrefixFromPath("/messenger")).toBeNull();
  });

  it("strips the organization prefix from messenger paths", () => {
    expect(toOrganizationRelativePath("/ACM/messenger?prefill=hello%20world")).toBe("/messenger?prefill=hello%20world");
  });

  it("treats resources as an unprefixed board route", () => {
    expect(applyOrganizationPrefix("/resources?path=skills%2FSKILL.md", "ACM")).toBe(
      "/ACM/resources?path=skills%2FSKILL.md",
    );
    expect(extractOrganizationPrefixFromPath("/resources")).toBeNull();
    expect(toOrganizationRelativePath("/ACM/resources?path=skills%2FSKILL.md")).toBe(
      "/resources?path=skills%2FSKILL.md",
    );
  });

  it("treats workspaces as an unprefixed board route", () => {
    expect(applyOrganizationPrefix("/workspaces?path=resources.md", "ACM")).toBe(
      "/ACM/workspaces?path=resources.md",
    );
    expect(extractOrganizationPrefixFromPath("/workspaces")).toBeNull();
    expect(toOrganizationRelativePath("/ACM/workspaces?path=resources.md")).toBe(
      "/workspaces?path=resources.md",
    );
  });

  it("finds organizations by prefix case-insensitively", () => {
    const organizations = [
      { id: "org_1", issuePrefix: "ACM", urlKey: "acme" },
      { id: "org_2", issuePrefix: "BETA", urlKey: "beta-labs" },
    ];

    expect(
      findOrganizationByPrefix({
        organizations,
        organizationPrefix: "beta",
      }),
    ).toEqual(organizations[1]);
  });

  it("finds organizations by urlKey alias case-insensitively", () => {
    const organizations = [
      { id: "org_1", issuePrefix: "RUD", urlKey: "rudder" },
      { id: "org_2", issuePrefix: "BETA", urlKey: "beta-labs" },
    ];

    expect(
      findOrganizationByPrefix({
        organizations,
        organizationPrefix: "RUDDER",
      }),
    ).toEqual(organizations[0]);
  });

  it("returns null when the prefix is missing or unknown", () => {
    const organizations = [
      { id: "org_1", issuePrefix: "ACM", urlKey: "acme" },
    ];

    expect(
      findOrganizationByPrefix({
        organizations,
        organizationPrefix: null,
      }),
    ).toBeNull();

    expect(
      findOrganizationByPrefix({
        organizations,
        organizationPrefix: "missing",
      }),
    ).toBeNull();
  });
});
