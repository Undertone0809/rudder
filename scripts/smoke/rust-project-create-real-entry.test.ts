import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseYamlFile } from "../../server/src/services/knowledge-portability/organization-portability.package.js";
import {
  assertCliCompatibleProjectId,
  buildExistingOrganizationProjectImport,
  isOrganizationImportHydrationResponse,
  ownedFoundationPids,
  projectImportMutationKey,
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

  it("selects only the direct child running the exact disposable foundation binary or wrapper", () => {
    const binary = "/tmp/rudder-create-owned/rudder-server-foundation";
    const listing = [
      " 101 42 " + binary,
      " 102 43 " + binary,
      " 103 42 " + binary + ".other",
      " 104 42 /another/rudder-server-foundation",
      " 105 42 /usr/bin/echo " + binary,
      " 106 42 /usr/bin/node " + binary,
      " 107 42 /usr/bin/node " + binary + ".other",
    ].join("\n");
    assert.deepEqual(ownedFoundationPids(listing, 42, binary), [101, 106]);
    assert.deepEqual(ownedFoundationPids(listing, 99, binary), []);
  });

  it("builds an existing-organization replacement with workspace hydration", () => {
    const input = buildExistingOrganizationProjectImport({
      targetOrgId: "11111111-1111-4111-8111-111111111111",
      projectSlug: "existing-project",
      projectName: "Existing Project",
      description: "Imported description",
      workspaceRepoUrl: "https://example.com/project.git",
    });
    const result = input as Record<string, any>;
    const source = result.source as Record<string, any>;
    const files = source.files as Record<string, string>;
    const extension = parseYamlFile(files[".rudder.yaml"]!);

    assert.deepEqual(result.target, {
      mode: "existing_organization",
      orgId: "11111111-1111-4111-8111-111111111111",
    });
    assert.deepEqual(result.include, {
      organization: false,
      agents: false,
      projects: true,
      issues: false,
      skills: false,
    });
    assert.equal(result.collisionStrategy, "replace");
    assert.equal(extension.projects["existing-project"].executionWorkspacePolicy.defaultProjectWorkspaceKey, "primary");
    assert.equal(extension.projects["existing-project"].workspaces.primary.repoUrl, "https://example.com/project.git");
  });

  it("drops only a Rust organization-import workspace hydration response", () => {
    const requestPath = "/api/orgs/org-id/projects/project-id/goal-set";
    const hydration = JSON.stringify({
      mutationOrigin: "organization_import",
      projectPatch: { executionWorkspacePolicy: { defaultProjectWorkspaceId: "workspace-id" } },
    });
    assert.equal(isOrganizationImportHydrationResponse(requestPath, hydration), true);
    assert.equal(isOrganizationImportHydrationResponse(requestPath, "{"), false);
    assert.equal(isOrganizationImportHydrationResponse(requestPath, JSON.stringify({
      mutationOrigin: "organization_import",
      projectPatch: { executionWorkspacePolicy: { defaultProjectWorkspaceKey: "primary" } },
    })), false);
    assert.equal(isOrganizationImportHydrationResponse("/api/projects/project-id", hydration), false);
  });

  it("derives repeatable distinct Rust receipt keys from the caller import key and phase", () => {
    const replaceKey = projectImportMutationKey("same-import", "org-id", "project-id", "replace");
    const hydrateKey = projectImportMutationKey("same-import", "org-id", "project-id", "hydrate");
    assert.match(replaceKey, /^[0-9a-f]{64}$/u);
    assert.equal(projectImportMutationKey("same-import", "org-id", "project-id", "replace"), replaceKey);
    assert.notEqual(hydrateKey, replaceKey);
    assert.notEqual(projectImportMutationKey("changed-import", "org-id", "project-id", "replace"), replaceKey);
  });
});
