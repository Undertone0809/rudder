import { contactCreateSchema } from "@/lib/domain";
import { describe, expect, it } from "vitest";

describe("contact input", () => {
  it("normalizes a valid contact", () => {
    expect(contactCreateSchema.parse({
      name: "  Maya Chen ",
      email: "maya@example.test",
    })).toEqual({
      name: "Maya Chen",
      email: "maya@example.test",
      company: "",
      status: "new",
    });
  });

  it("rejects an invalid email", () => {
    expect(contactCreateSchema.safeParse({
      name: "Maya",
      email: "not-an-email",
    }).success).toBe(false);
  });
});
