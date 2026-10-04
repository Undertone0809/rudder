import type { Db } from "@rudderhq/db";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { forwardRustOrganizationResourceMutation } from "./organization-resource-rust-authority.js";
import type { RustFoundationBridge } from "./rust-foundation-bridge.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const req = {
  actor: { type: "board", source: "local_implicit", userId: "local-board" },
  header: (name: string) => name === "x-rudder-idempotency-key" ? "resource-retry" : undefined,
} as unknown as Request;

function fixture(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue(rows);
  const mutation = vi.fn();
  const bridge = {
    projectGoalSetMode: "required",
    organizationResourceMutation: mutation,
  } as unknown as RustFoundationBridge;
  return { db: { execute } as unknown as Db, bridge, mutation };
}

describe("organization resource authority routing", () => {
  it("leaves a verified Node-only resource on its existing authority", async () => {
    const { db, bridge, mutation } = fixture([{ requires_rust: false }]);
    expect(await forwardRustOrganizationResourceMutation(db, bridge, req, orgId, resourceId, "update", { name: "Shared" })).toBeNull();
    expect(mutation).not.toHaveBeenCalled();
  });

  it("fails closed when resource ownership cannot be established", async () => {
    const { db, bridge, mutation } = fixture([]);
    await expect(forwardRustOrganizationResourceMutation(db, bridge, req, orgId, resourceId, "delete", {}))
      .rejects.toMatchObject({ status: 503 });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("keeps a Rust outage terminal instead of selecting the Node writer", async () => {
    const { db, bridge, mutation } = fixture([{ requires_rust: true }]);
    mutation.mockRejectedValue(new Error("connection lost after possible commit"));
    await expect(forwardRustOrganizationResourceMutation(db, bridge, req, orgId, resourceId, "update", { name: "Retry" }))
      .rejects.toMatchObject({ status: 503 });
    expect(mutation).toHaveBeenCalledOnce();
  });

  it("preserves the stable key, operation and exact Rust failure response", async () => {
    const { db, bridge, mutation } = fixture([{ requires_rust: true }]);
    const response = { status: 409, contentType: "application/json", body: Buffer.from('{"error":"mutation_idempotency_conflict"}') };
    mutation.mockResolvedValue(response);
    expect(await forwardRustOrganizationResourceMutation(db, bridge, req, orgId, resourceId, "update", { name: "Changed" })).toBe(response);
    const args = mutation.mock.calls[0]!;
    expect(args.slice(0, 4)).toEqual([req, orgId, resourceId, "update"]);
    expect(JSON.parse(args[4].toString("utf8"))).toEqual({ data: { name: "Changed" }, runId: null });
    expect(args[5]).toBe("resource-retry");
  });
});
