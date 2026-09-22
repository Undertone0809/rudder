import { describe, expect, it, vi } from "vitest";
import { handoffOrganizationBrandingAuthorityInTransaction } from "./organization-branding-fence.js";

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

  it.each(["rows", "array"])("rejects an invalid persisted owner from %s results before the handoff update", async (format) => {
    const rows = [{ org_id: "00000000-0000-4000-8000-000000000001" }];
    const execute = vi.fn().mockResolvedValueOnce(format === "array" ? rows : { rows });

    await expect(handoffOrganizationBrandingAuthorityInTransaction({ execute }))
      .rejects.toThrow("invalid owner");
    expect(execute).toHaveBeenCalledOnce();
  });
});
