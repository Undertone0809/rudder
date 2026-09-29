import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCliCompatibleProjectId,
  ownedFoundationPids,
} from "./rust-project-create-real-entry.js";

describe("Project creation real-entry smoke assertions (no database)", () => {
  it("preserves the CLI UUID v1-v5 contract and rejects the proposed v8 form", () => {
    for (const version of [1, 2, 3, 4, 5]) {
      assert.doesNotThrow(() => assertCliCompatibleProjectId(
        "00000000-0000-" + version + "000-8000-000000000000",
      ));
    }
    assert.throws(() => assertCliCompatibleProjectId("00000000-0000-8000-8000-000000000000"));
    assert.throws(() => assertCliCompatibleProjectId("not-a-uuid"));
  });

  it("selects only the direct child running the exact disposable foundation binary", () => {
    const binary = "/tmp/rudder-create-owned/rudder-server-foundation";
    const listing = [
      " 101 42 " + binary,
      " 102 43 " + binary,
      " 103 42 " + binary + ".other",
      " 104 42 /another/rudder-server-foundation",
      " 105 42 /usr/bin/echo " + binary,
    ].join("\n");
    assert.deepEqual(ownedFoundationPids(listing, 42, binary), [101]);
    assert.deepEqual(ownedFoundationPids(listing, 99, binary), []);
  });
});
