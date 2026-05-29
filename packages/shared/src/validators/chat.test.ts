import { describe, expect, it } from "vitest";
import {
  chatAutomationCreateFromStructuredPayload,
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
        assigneeUnassignedReason: "No execution owner is known yet.",
        labelIds: [labelId],
      },
    })).toMatchObject({
      success: true,
      data: {
        proposal: expect.objectContaining({
          labelIds: [labelId],
          assigneeUnassignedReason: "No execution owner is known yet.",
        }),
      },
    });
  });

  it("requires an explicit owner decision when converting chat proposals into issues", () => {
    expect(convertChatToIssueSchema.safeParse({
      proposal: {
        title: "Missing owner",
        description: "This proposal does not say who owns the work.",
      },
    })).toMatchObject({
      success: false,
    });

    expect(convertChatToIssueSchema.safeParse({
      proposal: {
        title: "Intentionally unassigned",
        description: "This proposal explains why there is no owner yet.",
        assigneeUnassignedReason: "The operator needs to choose an execution owner after review.",
      },
    })).toMatchObject({
      success: true,
    });
  });
});

describe("chat automation creation payloads", () => {
  it("keeps a valid scheduled automation request with defaults", () => {
    const payload = {
      automationCreate: {
        title: "Daily AI HOT report",
        description: "Run aihot and send a short Chinese summary.",
        schedule: {
          cronExpression: "0 12 * * *",
          timezone: "Asia/Shanghai",
        },
      },
    };

    expect(chatAutomationCreateFromStructuredPayload(payload)).toMatchObject({
      title: "Daily AI HOT report",
      description: "Run aihot and send a short Chinese summary.",
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      outputMode: "chat_output",
      schedule: {
        cronExpression: "0 12 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
      },
    });
    expect(sanitizeChatStructuredPayload(payload)).toEqual({
      automationCreate: expect.objectContaining({
        title: "Daily AI HOT report",
        outputMode: "chat_output",
      }),
    });
  });

  it("drops malformed automationCreate payloads during sanitization", () => {
    expect(sanitizeChatStructuredPayload({
      summary: "keep this",
      automationCreate: {
        title: "Missing schedule",
      },
    })).toEqual({ summary: "keep this" });
  });

  it("requires automation schedules to declare timezone explicitly", () => {
    const payload = {
      automationCreate: {
        title: "Daily AI HOT report",
        schedule: {
          cronExpression: "0 12 * * *",
        },
      },
    };

    expect(chatAutomationCreateFromStructuredPayload(payload)).toBeNull();
    expect(sanitizeChatStructuredPayload(payload)).toBeNull();
  });
});
