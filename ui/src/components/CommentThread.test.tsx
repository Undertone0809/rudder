// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentThread } from "./CommentThread";

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <div>Markdown editor</div>,
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({
    children,
    agentMentions,
    skillReferences,
  }: {
    children: ReactNode;
    agentMentions?: Array<{ name?: string | null }>;
    skillReferences?: Array<{ displayName?: string | null }>;
  }) => (
    <div
      data-agent-mention-count={agentMentions?.length ?? 0}
      data-agent-mention-name={agentMentions?.[0]?.name ?? ""}
      data-skill-reference-count={skillReferences?.length ?? 0}
      data-skill-reference-name={skillReferences?.[0]?.displayName ?? ""}
    >
      {children}
    </div>
  ),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, title }: { children: ReactNode; title?: string }) => (
    <button title={title}>{children}</button>
  ),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({
    emptyMessage,
    streaming,
  }: {
    emptyMessage?: string;
    streaming?: boolean;
  }) => <div data-streaming={streaming ? "true" : "false"}>{emptyMessage ?? "Transcript details"}</div>,
}));

describe("CommentThread", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers a general file attachment control for comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          onAdd={async () => undefined}
          imageUploadHandler={async () => "/api/attachments/attachment-1/content"}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("application/pdf");
    expect(html).toContain("text/csv");
    expect(html).toContain('title="Attach file"');
    expect(html).toContain("chat-composer");
    expect(html).not.toContain("Assignee");
  });

  it("passes skill mention metadata into rendered comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Use [build-advisor](/skills/build-advisor/SKILL.md).",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          mentions={[
            {
              id: "skill:build-advisor",
              name: "build-advisor",
              kind: "skill",
              skillRefLabel: "build-advisor",
              skillMarkdownTarget: "/skills/build-advisor/SKILL.md",
              skillDisplayName: "Build Advisor",
              skillDescription: "Professional diagnosis.",
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-skill-reference-count="1"');
    expect(html).toContain('data-skill-reference-name="Build Advisor"');
  });

  it("passes agent mention metadata into rendered comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "@Holden please review this.",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          mentions={[
            {
              id: "agent:agent-1",
              name: "Holden",
              kind: "agent",
              agentId: "agent-1",
              agentIcon: "code",
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-agent-mention-count="1"');
    expect(html).toContain('data-agent-mention-name="Holden"');
  });

  it("uses the operator nickname for board-authored comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Looks good.",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          operatorDisplayName="Zee"
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Zee");
    expect(html).not.toContain("You");
  });

  it("falls back to You for board-authored comments without a nickname", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Looks good.",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          operatorDisplayName="   "
        />
      </MemoryRouter>,
    );

    expect(html).toContain("You");
  });

  it("mixes activity items and comments in chronological order", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Middle comment.",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              updatedAt: new Date("2026-05-07T00:02:00.000Z"),
            },
          ]}
          activityItems={[
            {
              id: "activity-1",
              createdAt: new Date("2026-05-07T00:01:00.000Z"),
              node: <div>First activity</div>,
            },
            {
              id: "activity-2",
              createdAt: new Date("2026-05-07T00:03:00.000Z"),
              node: <div>Last activity</div>,
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html.indexOf("First activity")).toBeLessThan(html.indexOf("Middle comment."));
    expect(html.indexOf("Middle comment.")).toBeLessThan(html.indexOf("Last activity"));
  });

  it("presents linked run transcript rows as collapsible agent runs", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "completed",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              startedAt: new Date("2026-05-07T00:02:00.000Z"),
              finishedAt: new Date("2026-05-07T00:34:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Run");
    expect(html).not.toContain("Not an issue comment");
    expect(html).toContain('aria-label="Agent run"');
    expect(html).toContain('data-run-id="55555555-5555-4555-8555-555555555555"');
    expect(html).toContain("Ran for 32m");
    expect(html).toContain('aria-label="Show details"');
    expect(html).toContain('data-size="sm"');
    expect(html).not.toContain("No run output captured.");
  });

  it("shows recent activity timestamps as relative labels while preserving exact titles", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T01:12:00.000Z"));

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Fresh update.",
              createdAt: new Date("2026-05-07T00:36:00.000Z"),
              updatedAt: new Date("2026-05-07T00:36:00.000Z"),
            },
          ]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "succeeded",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:12:00.000Z"),
              startedAt: new Date("2026-05-07T00:12:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain(">36m ago</time>");
    expect(html).toContain(">1h ago</time>");
    expect(html).toMatch(/title="May 7, 2026, \d{2}:36"/);
    expect(html).toMatch(/title="May 7, 2026, \d{2}:12"/);
    expect(html).not.toContain(">May 7, 2026, 00:36</a>");
    expect(html).not.toContain(">May 7, 2026, 00:12</time>");
  });

  it("collapses inactive linked run details by default", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "failed",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              startedAt: new Date("2026-05-07T00:02:00.000Z"),
            },
            {
              runId: "66666666-6666-4666-8666-666666666666",
              status: "succeeded",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:03:00.000Z"),
              startedAt: new Date("2026-05-07T00:03:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Agent run"');
    expect(html).toContain("succeeded");
    expect(html).toContain('aria-label="Show details"');
    expect(html).not.toContain("No run output captured.");
    expect(html).not.toContain('data-streaming="false"');
  });

  it("renders active linked run details in streaming mode", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "running",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              startedAt: new Date("2026-05-07T00:02:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Agent run"');
    expect(html).toContain('aria-label="Hide details"');
    expect(html).toContain("Run running. Waiting for output...");
    expect(html).toContain('data-streaming="true"');
  });
});
