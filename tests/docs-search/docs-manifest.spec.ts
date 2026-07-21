import { expect, test } from "@playwright/test";

import { verifyStaticDocs } from "../../scripts/verify-docs-static-export.mjs";

test("passes the manifest-complete static docs acceptance verifier", async ({ baseURL }) => {
  const result = await verifyStaticDocs(baseURL ?? "http://127.0.0.1:4179", {
    timeoutMs: 10_000,
  });
  expect(result.canonical).toBe(68);
  expect(result.aliases).toBeGreaterThan(27);
});
