import { describe, expect, it } from "vitest";
import { organizationEntityReferenceSchema } from "./reference.js";

describe("organizationEntityReferenceSchema", () => {
  it("accepts UUIDs and typed short references for the requested kind", () => {
    expect(organizationEntityReferenceSchema("agent").safeParse(
      "11111111-1111-4111-8111-111111111111",
    ).success).toBe(true);
    expect(organizationEntityReferenceSchema("agent").safeParse("agt_11111111").success).toBe(true);
    expect(organizationEntityReferenceSchema("project").safeParse("prj_22222222").success).toBe(true);
    expect(organizationEntityReferenceSchema("goal").safeParse("gol_33333333").success).toBe(true);
    expect(organizationEntityReferenceSchema("issue").safeParse("iss_44444444").success).toBe(true);
  });

  it("rejects a short reference with the wrong entity kind or malformed syntax", () => {
    const wrongKind = organizationEntityReferenceSchema("project").safeParse("agt_11111111");
    expect(wrongKind.success).toBe(false);
    if (!wrongKind.success) {
      expect(wrongKind.error.issues[0]?.message).toContain("project");
    }

    expect(organizationEntityReferenceSchema("issue").safeParse("issue-1").success).toBe(false);
    expect(organizationEntityReferenceSchema("issue").safeParse("iss_").success).toBe(false);
    expect(organizationEntityReferenceSchema("issue").safeParse("iss_nothex00").success).toBe(false);
  });
});
