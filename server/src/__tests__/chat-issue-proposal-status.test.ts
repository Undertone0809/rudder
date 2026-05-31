import { describe, expect, it } from "vitest";
import { issueProposalFromPayload } from "../services/chats.helpers.js";

describe("chat issue proposal status defaults", () => {
  it("defaults agent-created issue proposals to todo", () => {
    expect(issueProposalFromPayload({
      issueProposal: {
        title: "Runnable proposal",
        description: "This should be available for agent execution after approval.",
        assigneeUnassignedReason: "The operator will choose an owner during approval.",
      },
    })).toMatchObject({
      title: "Runnable proposal",
      status: "todo",
    });
  });

  it("preserves an explicit backlog status when the proposal defers work", () => {
    expect(issueProposalFromPayload({
      issueProposal: {
        title: "Deferred proposal",
        description: "This should not be picked up automatically yet.",
        status: "backlog",
        assigneeUnassignedReason: "The operator wants to triage this later.",
      },
    })).toMatchObject({
      title: "Deferred proposal",
      status: "backlog",
    });
  });
});
