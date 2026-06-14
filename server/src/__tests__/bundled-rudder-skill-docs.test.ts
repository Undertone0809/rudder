import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled rudder skill docs", () => {
  const readSkillDoc = async () =>
    fs.readFile(
      path.join(process.cwd(), "server/resources/bundled-skills/rudder/SKILL.md"),
      "utf8",
    );

  it("do not teach Library entry display metadata in mention URLs", async () => {
    const docs = [
      "server/resources/bundled-skills/rudder/SKILL.md",
      "server/resources/bundled-skills/rudder/references/api-reference.md",
      "server/resources/bundled-skills/rudder/references/cli-reference.md",
    ];
    const legacyLibraryEntryMetadataPattern = /library-entry:\/\/[^\s)`\]]+\?(?=[^)\]`\s]*(?:t|p)=)/;

    for (const doc of docs) {
      const contents = await fs.readFile(path.join(process.cwd(), doc), "utf8");
      expect(contents, doc).not.toMatch(legacyLibraryEntryMetadataPattern);
    }
  });

  it("keeps the bundled skill framed as a Rudder operating contract", async () => {
    const contents = await readSkillDoc();

    expect(contents).toContain("This is the operating skill for agents working under Rudder");
    expect(contents).toContain("Goal -> Issue -> Agent run -> Review -> Feedback -> Learning -> Better future runs");
    expect(contents).toContain("## Heartbeat Operating Loop");
    expect(contents).toContain("## Heartbeat Decision Model");
    expect(contents).toContain("## Critical Operating Rules");
    expect(contents).toContain("Use `references/cli-reference.md` for the stable command catalog");
    expect(contents).toContain("read `references/organization-skills.md`");
  });

  it("guards the heartbeat procedural spine", async () => {
    const contents = await readSkillDoc();

    const requiredPatterns = [
      /rudder agent me --json/,
      /rudder approval get "\$RUDDER_APPROVAL_ID" --json/,
      /rudder approval issues "\$RUDDER_APPROVAL_ID" --json/,
      /rudder agent inbox --json/,
      /reviewer rows with `status:/,
      /rudder issue context "\$RUDDER_TASK_ID" --wake-comment-id "\$RUDDER_WAKE_COMMENT_ID" --json/,
      /rudder issue checkout "<issue-id-or-identifier>" --json/,
      /Never retry a `409` from checkout/,
      /Never look for unassigned work/,
      /rudder issue context "<issue-id-or-identifier>" --json/,
      /Before exiting an active `todo` or `in_progress` issue run, leave exactly one clear close-out signal/,
      /issue_passive_followup` as close-out governance/,
      /issue_review_closeout_missing` as review close-out governance/,
      /rudder issue create --org-id "\$RUDDER_ORG_ID"/,
      /Always set `parentId`/,
      /Set `goalId` unless you are intentionally creating top-level management work/,
    ];

    for (const pattern of requiredPatterns) {
      expect(contents).toMatch(pattern);
    }
  });

  it("guards structured reviewer decisions and artifact evidence rails", async () => {
    const contents = await readSkillDoc();

    for (const decision of ["approve", "request_changes", "needs_followup", "blocked"]) {
      expect(contents).toContain(`--decision ${decision}`);
    }

    expect(contents).toContain("Do not rely on free-form");
    expect(contents).toContain('Add `--image "<path>"');
    expect(contents).toContain('rudder library file ref "$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>" --json');
    expect(contents).toContain("`markdownLink`");
  });

  it("keeps organization skill details delegated and assignment semantics explicit", async () => {
    const contents = await readSkillDoc();

    expect(contents).toContain('rudder agent skills create "$RUDDER_AGENT_ID"');
    expect(contents).toContain("Use `skills enable` when adding one or more skills");
    expect(contents).toContain("Use `skills sync` only when you intend to");
    expect(contents).toContain("read `references/organization-skills.md` and follow");

    expect(contents).not.toMatch(/rudder skill (?:scan-local|scan-projects|import|list|get|file) --org-id/);
  });

  it("does not turn the main skill into an agent-v1 command catalog", async () => {
    const contents = await readSkillDoc();

    expect(contents).not.toMatch(/Agent V1 Commands/i);
    expect(contents).not.toMatch(/\|\s*`rudder (?:agent|approval|automation|chat|issue|library|project|runs|skill)/);
  });
});
