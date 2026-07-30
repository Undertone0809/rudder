import { describe, expect, it } from "vitest";
import { buildExportEnvelope, importEnvelopeSchema } from "@/lib/data-transfer";

describe("app data transfer", () => {
  it("round-trips the versioned export envelope", () => {
    const now = new Date("2026-07-29T00:00:00.000Z");
    const envelope = buildExportEnvelope([{
      id: "a1e99a5d-8fe0-43b9-90dc-5f67718d31dd",
      name: "Maya Chen",
      email: "maya@example.test",
      company: "Northwind",
      status: "replied",
      createdAt: now,
      updatedAt: now,
    }]);

    expect(importEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects unknown envelope fields before import", () => {
    expect(importEnvelopeSchema.safeParse({
      format: "rudder-app-data/v1",
      exportedAt: "2026-07-29T00:00:00.000Z",
      data: { contacts: [] },
      secret: "must-not-pass",
    }).success).toBe(false);
  });
});
