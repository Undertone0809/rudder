import { describe, expect, it } from "vitest";
import { blockerFingerprint } from "../services/requests.js";

describe("blockerFingerprint", () => {
  it("normalizes volatile ids, attempt counters, case, and whitespace", () => {
    const first = blockerFingerprint(
      "GitHub SUDO failed for run 9C5A854E-99D3-4CBF-A88E-D84D89AE3546 at https://github.com/settings/tokens (attempt 1)",
      "Approve mobile confirmation",
    );
    const second = blockerFingerprint(
      " github sudo failed for run 25a74551-3d3c-49da-98f7-fe94e7787f3d at https://github.com/settings/tokens (attempt 2) ",
      "APPROVE   MOBILE confirmation",
    );
    expect(first).toBe(second);
  });

  it("keeps distinct resources, ports, and error codes in separate lineages", () => {
    expect(blockerFingerprint("Connection failed at http://127.0.0.1:3200/api with 403", "Restore access"))
      .not.toBe(blockerFingerprint("Connection failed at http://127.0.0.1:3100/health with 401", "Restore access"));
  });

  it("keeps materially different requested actions in separate lineages", () => {
    expect(blockerFingerprint("GitHub authentication stopped", "Approve mobile confirmation"))
      .not.toBe(blockerFingerprint("GitHub authentication stopped", "Provide a replacement token"));
  });
});
