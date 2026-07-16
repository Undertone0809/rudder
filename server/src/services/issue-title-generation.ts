import { buildTitlePrompt } from "./title-generation.js";

export const ISSUE_TITLE_REGENERATION_COMMENT_LIMIT = 12;

type IssueTitleSource = {
  title: string;
  description?: string | null;
};

type IssueTitleCommentSource = {
  body: string;
};

export function buildIssueTitlePrompt(
  issue: IssueTitleSource,
  newestComments: IssueTitleCommentSource[],
) {
  const sections = [`Current title: ${issue.title.trim()}`];
  const comments = newestComments
    .slice(0, ISSUE_TITLE_REGENERATION_COMMENT_LIMIT)
    .map((comment) => comment.body.trim())
    .filter(Boolean);
  if (comments.length > 0) {
    sections.push(`Recent comments (newest first):\n${comments.join("\n\n")}`);
  }

  const description = issue.description?.trim();
  if (description) sections.push(`Description: ${description}`);

  return buildTitlePrompt({
    instruction: "Generate a concise title for this issue.",
    sourceLabel: "Issue context",
    source: sections.join("\n\n"),
  });
}
