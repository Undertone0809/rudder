import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled rudder skill docs", () => {
  const readSkillDoc = async () =>
    fs.readFile(
      path.join(process.cwd(), "server/resources/bundled-skills/rudder/SKILL.md"),
      "utf8",
    );

  it("does not teach agent-authored Library entry display metadata in mention URLs", async () => {
    const docs = [
      "server/resources/bundled-skills/rudder/SKILL.md",
      "server/resources/bundled-skills/rudder/references/api-reference.md",
      "server/resources/bundled-skills/rudder/references/cli-reference.md",
    ];
    const legacyLibraryEntryTitleMetadataPattern = /library-entry:\/\/[^\s)`\]]+\?(?=[^)\]`\s]*t=)/;

    for (const doc of docs) {
      const contents = await fs.readFile(path.join(process.cwd(), doc), "utf8");
      expect(contents, doc).not.toMatch(legacyLibraryEntryTitleMetadataPattern);
      expect(contents, doc).toContain("Rudder-generated");
      expect(contents, doc).toContain("path hint");
    }
  });

  it("keeps the bundled skill framed as Rudder control-plane practice", async () => {
    const contents = await readSkillDoc();

    expect(contents).toContain("This is the control-plane practice skill for agents working under Rudder");
    expect(contents).toContain("Runtime-owned heartbeat prompts provide the fixed heartbeat execution flow");
    expect(contents).toContain("ownership, checkout, approvals, comments, reviews, Library handoffs, and");
    expect(contents).toContain("## Control-Plane Rails");
    expect(contents).toContain("## Essential Commands");
    expect(contents).toContain("Use `references/cli-reference.md` for the stable command catalog");
    expect(contents).toContain("read `references/organization-skills.md`");
  });

  it("keeps scene-independent control-plane rails", async () => {
    const contents = await readSkillDoc();

    const requiredPatterns = [
      /rudder agent me --json/,
      /rudder approval get "\$RUDDER_APPROVAL_ID" --json/,
      /rudder approval issues "\$RUDDER_APPROVAL_ID" --json/,
      /rudder agent inbox --json/,
      /rudder issue context "\$RUDDER_TASK_ID" --wake-comment-id "\$RUDDER_WAKE_COMMENT_ID" --json/,
      /rudder issue checkout "<issue-id-or-identifier>" --json/,
      /Never retry a `409` from checkout/,
      /Never look for unassigned work/,
      /rudder issue context "<issue-id-or-identifier>" --json/,
      /issue_passive_followup` as issue follow-up/,
      /issue_review_closeout_missing` as review follow-up/,
      /not assigned to you/,
      /user-owned\s+or unassigned issues/,
      /comment's actual content/,
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

  it("does not duplicate the runtime-owned heartbeat flow", async () => {
    const contents = await readSkillDoc();

    expect(contents).not.toContain("## Heartbeat Operating Loop");
    expect(contents).not.toContain("## Heartbeat Decision Model");
    expect(contents).not.toContain("## Heartbeat Procedure");
    expect(contents).not.toMatch(/\| Trigger or relationship \| Required first action \| Ownership rule \| Required close-out \|/);
  });
});
