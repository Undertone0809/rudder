import { describe, expect, it } from "vitest";
import {
  chatAskUserRequestFromStructuredPayload,
  chatAskUserRequestSchema,
  convertChatToIssueSchema,
  chatRichReferencesFromStructuredPayload,
  sanitizeChatStructuredPayload,
} from "./chat.js";

describe("chat ask_user request payloads", () => {
  it("accepts one to three structured questions with two to three options", () => {
    const payload = {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the agent implement?",
            options: [
              { id: "narrow", label: "Narrow", description: "Smallest shippable path", recommended: true },
              { id: "broad", label: "Broad" },
            ],
            selectionMode: "multiple",
            allowFreeform: true,
          },
        ],
      },
    };

    expect(chatAskUserRequestSchema.safeParse(payload.requestUserInput).success).toBe(true);
    expect(chatAskUserRequestFromStructuredPayload(payload)).toEqual(payload.requestUserInput);
    expect(sanitizeChatStructuredPayload(payload)).toEqual(payload);
  });

  it("rejects unsupported ask_user selection modes", () => {
    const parsed = chatAskUserRequestSchema.safeParse({
      questions: [
        {
          id: "scope",
          question: "Which scope?",
          selectionMode: "all",
          options: [
            { id: "narrow", label: "Narrow" },
            { id: "broad", label: "Broad" },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("drops malformed requestUserInput during general structured payload sanitization", () => {
    expect(sanitizeChatStructuredPayload({
      requestUserInput: {
        questions: [
          {
            id: "scope",
            question: "Which scope?",
            options: [{ id: "only", label: "Only one option" }],
          },
        ],
      },
      summary: "keep this",
    })).toEqual({ summary: "keep this" });
  });

  it("rejects duplicate question ids and duplicate option ids", () => {
    const duplicateQuestionIds = chatAskUserRequestSchema.safeParse({
      questions: [
        {
          id: "scope",
          question: "Which scope?",
          options: [
            { id: "narrow", label: "Narrow" },
            { id: "broad", label: "Broad" },
          ],
        },
        {
          id: "scope",
          question: "Which fallback?",
          options: [
            { id: "wait", label: "Wait" },
            { id: "ship", label: "Ship" },
          ],
        },
      ],
    });

    expect(duplicateQuestionIds.success).toBe(false);
    if (!duplicateQuestionIds.success) {
      expect(duplicateQuestionIds.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: "Question ids must be unique within requestUserInput",
          path: ["questions", 1, "id"],
        }),
      ]));
    }

    const duplicateOptionIds = chatAskUserRequestSchema.safeParse({
      questions: [
        {
          id: "scope",
          question: "Which scope?",
          options: [
            { id: "narrow", label: "Narrow" },
            { id: "narrow", label: "Also narrow" },
          ],
        },
      ],
    });

    expect(duplicateOptionIds.success).toBe(false);
    if (!duplicateOptionIds.success) {
      expect(duplicateOptionIds.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: "Option ids must be unique within each question",
          path: ["questions", 0, "options", 1, "id"],
        }),
      ]));
    }

    expect(sanitizeChatStructuredPayload({
      requestUserInput: {
        questions: [
          {
            id: "scope",
            question: "Which scope?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "narrow", label: "Also narrow" },
            ],
          },
        ],
      },
      summary: "keep this",
    })).toEqual({ summary: "keep this" });
  });
});

describe("chat rich references", () => {
  it("keeps valid issue and comment references", () => {
    const refs = chatRichReferencesFromStructuredPayload({
      richReferences: [
        { type: "issue", identifier: "ZST-153", display: "card" },
        {
          type: "issue_comment",
          issueId: "11111111-1111-4111-8111-111111111111",
          commentId: "22222222-2222-4222-8222-222222222222",
          display: "card",
        },
      ],
    });

    expect(refs).toEqual([
      { type: "issue", identifier: "ZST-153", display: "card" },
      {
        type: "issue_comment",
        issueId: "11111111-1111-4111-8111-111111111111",
        commentId: "22222222-2222-4222-8222-222222222222",
        display: "card",
      },
    ]);
  });

  it("drops invalid references and caps the list", () => {
    const payload = {
      summary: "done",
      richReferences: [
        { type: "issue" },
        { type: "issue", identifier: "ZST-1", display: "card" },
        { type: "issue", identifier: "ZST-2", display: "card" },
        { type: "issue", identifier: "ZST-3", display: "card" },
        { type: "issue", identifier: "ZST-4", display: "card" },
        { type: "issue", identifier: "ZST-5", display: "card" },
        { type: "issue", identifier: "ZST-6", display: "card" },
      ],
    };

    expect(sanitizeChatStructuredPayload(payload)).toEqual({
      summary: "done",
      richReferences: [
        { type: "issue", identifier: "ZST-1", display: "card" },
        { type: "issue", identifier: "ZST-2", display: "card" },
        { type: "issue", identifier: "ZST-3", display: "card" },
        { type: "issue", identifier: "ZST-4", display: "card" },
        { type: "issue", identifier: "ZST-5", display: "card" },
      ],
    });
  });
});

describe("chat issue proposals", () => {
  it("accepts label ids when converting chat proposals into issues", () => {
    const labelId = "11111111-1111-4111-8111-111111111111";

    expect(convertChatToIssueSchema.safeParse({
      proposal: {
        title: "Classify agent-created issue",
        description: "The issue proposal already selected the best-fit label.",
        labelIds: [labelId],
      },
    })).toMatchObject({
      success: true,
      data: {
        proposal: expect.objectContaining({
          labelIds: [labelId],
        }),
      },
    });
  });
});
