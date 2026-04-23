import { describe, expect, it } from "vitest";
import {
  isGithubShorthand,
  isGithubUrl,
  isHttpUrl,
  normalizeGithubImportSource,
} from "../commands/client/company.js";

describe("isHttpUrl", () => {
  it("matches http URLs", () => {
    expect(isHttpUrl("http://example.com/foo")).toBe(true);
  });

  it("matches https URLs", () => {
    expect(isHttpUrl("https://example.com/foo")).toBe(true);
  });

  it("rejects local paths", () => {
    expect(isHttpUrl("/tmp/my-company")).toBe(false);
    expect(isHttpUrl("./relative")).toBe(false);
  });
});

describe("isGithubUrl", () => {
  it("matches GitHub URLs", () => {
    expect(isGithubUrl("https://github.com/org/repo")).toBe(true);
  });

  it("rejects non-GitHub HTTP URLs", () => {
    expect(isGithubUrl("https://example.com/foo")).toBe(false);
  });

  it("rejects local paths", () => {
    expect(isGithubUrl("/tmp/my-company")).toBe(false);
  });
});

describe("isGithubShorthand", () => {
  it("matches owner/repo/path shorthands", () => {
    expect(isGithubShorthand("rudder/companies/gstack")).toBe(true);
    expect(isGithubShorthand("rudder/companies")).toBe(true);
  });

  it("rejects local-looking paths", () => {
    expect(isGithubShorthand("./exports/acme")).toBe(false);
    expect(isGithubShorthand("/tmp/acme")).toBe(false);
    expect(isGithubShorthand("C:\\temp\\acme")).toBe(false);
  });
});

describe("normalizeGithubImportSource", () => {
  it("normalizes shorthand imports to canonical GitHub sources", () => {
    expect(normalizeGithubImportSource("rudder/companies/gstack")).toBe(
      "https://github.com/rudder/companies?ref=main&path=gstack",
    );
  });

  it("applies --ref to shorthand imports", () => {
    expect(normalizeGithubImportSource("rudder/companies/gstack", "feature/demo")).toBe(
      "https://github.com/rudder/companies?ref=feature%2Fdemo&path=gstack",
    );
  });

  it("applies --ref to existing GitHub tree URLs without losing the package path", () => {
    expect(
      normalizeGithubImportSource(
        "https://github.com/rudder/companies/tree/main/gstack",
        "release/2026-03-23",
      ),
    ).toBe(
      "https://github.com/rudder/companies?ref=release%2F2026-03-23&path=gstack",
    );
  });
});
