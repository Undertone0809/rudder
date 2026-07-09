import { describe, expect, it } from "vitest";
import { resolveKnownWebsiteIcon } from "./website-icons.js";

describe("resolveKnownWebsiteIcon", () => {
  it("resolves known public sites used in rendered link icons", () => {
    expect(resolveKnownWebsiteIcon("https://x.com/user/status/1")?.siteName).toBe("X");
    expect(resolveKnownWebsiteIcon("https://www.linkedin.com/pulse/post")?.siteName).toBe("LinkedIn");
  });

  it("does not treat unrelated provider subdomains as known site icons", () => {
    expect(resolveKnownWebsiteIcon("https://developers.google.com/engineering-practices/code-review")).toBeNull();
  });
});
