import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertDeleteReceipt,
  assertLegacyDeleteResponse,
  ownedFoundationPids,
} from "./rust-project-delete-real-entry.js";

describe("Project deletion real-entry smoke assertions (no database)", () => {
  it("reports a real executable failure as nonzero before database startup", { skip: process.platform === "win32" }, () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../../cli/node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("./rust-project-delete-real-entry.ts", import.meta.url)),
    ], {
      env: { ...process.env, RUDDER_SERVER_FOUNDATION_PATH: `/tmp/rudder-missing-${randomUUID()}/foundation` },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stdout, /RUST_PROJECT_DELETE_REAL_ENTRY_PASS/);
  });
  const id = "ab7d83ab-937d-40b2-8749-c8c087c71c11";
  const response = { id, name: "Selected Project", icon: "Folder", urlKey: "selected-project-ab7d83ab" };
  const receipt = {
    command_kind: "project_delete", outcome: "applied", activity_id: id,
    result: { result: { kind: "project_deleted", project_id: id, response } },
  };

  it("compares legacy response fields while excluding GET-only enrichments", () => {
    const before = { ...response, goalIds: [id], resources: [{ id }] };
    assertLegacyDeleteResponse(response, before, { ...response, id: "legacy-id" });
    assert.throws(() => assertLegacyDeleteResponse({ ...response, resources: [] }, before, response));
    assert.throws(() => assertLegacyDeleteResponse({ ...response, name: "changed" }, before, response));
    const { icon: _icon, ...missingField } = response;
    assert.throws(() => assertLegacyDeleteResponse(missingField, before, response));
  });

  it("rejects duplicate receipts, wrong command kinds, scope and replay bodies", () => {
    assertDeleteReceipt([receipt], id, response);
    assert.throws(() => assertDeleteReceipt([], id, response));
    assert.throws(() => assertDeleteReceipt([receipt, receipt], id, response));
    assert.throws(() => assertDeleteReceipt([{ ...receipt, command_kind: "project_goal_set_replacement" }], id, response));
    assert.throws(() => assertDeleteReceipt([receipt], "different-project", response));
    assert.throws(() => assertDeleteReceipt([receipt], id, { ...response, name: "current state, not original response" }));
    assert.throws(() => assertDeleteReceipt([{ ...receipt, result: { result: { ...receipt.result.result, kind: "project_patch" } } }], id, response));
  });

  it("selects only the direct child running the exact disposable foundation binary", () => {
    const binary = "/tmp/rudder-delete-owned/rudder-server-foundation";
    const listing = [
      ` 101 42 ${binary}`,
      ` 102 43 ${binary}`,
      ` 103 42 ${binary}.other`,
      ` 104 42 /another/rudder-server-foundation`,
      ` 105 42 /usr/bin/echo ${binary}`,
    ].join("\n");
    assert.deepEqual(ownedFoundationPids(listing, 42, binary), [101]);
    assert.deepEqual(ownedFoundationPids(listing, 99, binary), []);
  });
});
