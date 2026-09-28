import { describe, expect, it, vi } from "vitest";
import {
  configuredOrganizationBrandingOrgIds,
  handoffOrganizationBrandingAuthorityInTransaction,
  lockOrganizationBrandingAuthorityForDeletion,
  organizationBrandingOrgIsSelected,
} from "./organization-branding-fence.js";

describe("organization branding authority handoff", () => {
  it("allows a repeated Rust handoff without changing Rust-owned rows", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(handoffOrganizationBrandingAuthorityInTransaction({ execute })).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(2);
    const updateQuery = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(updateQuery).toContain("owner = 'node'");
  });

  it("rejects an invalid persisted owner before the handoff update", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [{ org_id: "00000000-0000-4000-8000-000000000001" }],
    });

    await expect(handoffOrganizationBrandingAuthorityInTransaction({ execute }))
      .rejects.toThrow("invalid owner");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("validates and deduplicates the explicit organization rollout allowlist", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    expect(configuredOrganizationBrandingOrgIds(`${first}, ${first},${second}`)).toEqual([first, second]);
    expect(organizationBrandingOrgIsSelected(first, [first])).toBe(true);
    expect(organizationBrandingOrgIsSelected(second, [first])).toBe(false);
    expect(organizationBrandingOrgIsSelected(second, [])).toBe(true);
    expect(() => configuredOrganizationBrandingOrgIds("not-a-uuid")).toThrow("must contain UUIDs");
  });

  it("locks a Rust-owned branding row for terminal organization deletion", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [{
        owner: "rust",
        mutation_version: "2",
        fence_epoch: "1",
        fence_token: "00000000-0000-4000-8000-000000000001",
      }],
    });

    await expect(lockOrganizationBrandingAuthorityForDeletion({ execute }, "org-1"))
      .resolves.toMatchObject({ owner: "rust", fence_epoch: "1" });
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("FOR UPDATE");
  });
});
