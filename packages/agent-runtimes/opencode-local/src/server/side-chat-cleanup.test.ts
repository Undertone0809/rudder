import { describe, expect, it } from "vitest";
import {
  openCodeForkCleanupSafetyError,
  openCodeSideChatCleanupContractError,
} from "./side-chat-cleanup.js";

function openCodeDoc() {
  return {
    paths: {
      "/session/{sessionID}": {
        get: { operationId: "session.get" },
        delete: {
          operationId: "session.delete",
          description: "Delete a session and permanently remove all associated data, including messages and history.",
          responses: {
            "200": { content: { "application/json": { schema: { type: "boolean" } } } },
          },
        },
      },
      "/session/{sessionID}/children": {
        get: {
          operationId: "session.children",
          description: "Retrieve all child sessions that were forked from the specified parent session.",
        },
      },
    },
  };
}

describe("OpenCode Side Chat fork cleanup contract", () => {
  it("requires the installed server to attest exact delete, get, and children operations", () => {
    expect(openCodeSideChatCleanupContractError(openCodeDoc())).toBeNull();
    const unsupported = openCodeDoc();
    unsupported.paths["/session/{sessionID}"].delete.description = "Delete a session.";
    expect(openCodeSideChatCleanupContractError(unsupported)).toContain("does not attest");
  });

  it("only allows deleting the exact fork when it has no Provider descendants", () => {
    const safeInput = {
      session: { id: "ses-child", parentID: "ses-parent" },
      sessionId: "ses-child",
      expectedParentSessionId: "ses-parent",
      children: [],
    };
    expect(openCodeForkCleanupSafetyError(safeInput)).toBeNull();
    expect(openCodeForkCleanupSafetyError({ ...safeInput, children: [{ id: "ses-grandchild" }] }))
      .toContain("descendants");
    expect(openCodeForkCleanupSafetyError({ ...safeInput, session: { id: "ses-child", parentID: "other" } }))
      .toContain("expected parent");
  });
});
