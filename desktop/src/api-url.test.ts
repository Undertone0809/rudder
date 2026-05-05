import { describe, expect, it } from "vitest";
import { buildDesktopApiRequestUrl } from "./api-url.js";

describe("desktop API URL helpers", () => {
  it("adds the API prefix when the runtime descriptor stores the board base URL", () => {
    expect(buildDesktopApiRequestUrl("http://127.0.0.1:3200", "/orgs")).toBe(
      "http://127.0.0.1:3200/api/orgs",
    );
  });

  it("preserves descriptors that already include the API prefix", () => {
    expect(buildDesktopApiRequestUrl("http://127.0.0.1:3200/api", "/orgs")).toBe(
      "http://127.0.0.1:3200/api/orgs",
    );
  });

  it("does not duplicate explicit API paths", () => {
    expect(buildDesktopApiRequestUrl("http://127.0.0.1:3200", "/api/orgs")).toBe(
      "http://127.0.0.1:3200/api/orgs",
    );
    expect(buildDesktopApiRequestUrl("http://127.0.0.1:3200/api", "/api/orgs")).toBe(
      "http://127.0.0.1:3200/api/orgs",
    );
  });
});
