# Skill Reference Cleanup

## Summary
Make the skill key users see readable and scope-aware, without breaking existing stored refs. The visible form will be context-aware, `org/<orgUrlKey>/<skillSlug>` for org-wide skills and `org/<orgUrlKey>/<agentUrlKey>/<skillSlug>` when the skill is shown in an agent context. `rudder/<skillSlug>` replaces the ugly `rudder/rudder/<skillSlug>` on the public side. Source stays separate.

## Key Changes
- Add a stable `organization.urlKey` in [packages/db/src/schema/organizations.ts](/Users/zeeland/projects/rudder/packages/db/src/schema/organizations.ts), backfill existing orgs once, and keep it immutable so public refs do not drift when names change.
- Add a shared skill-reference formatter/parser in [server/src/services/organization-skills.ts](/Users/zeeland/projects/rudder/server/src/services/organization-skills.ts) so the app can render public refs, accept old refs, and normalize back to the current internal key on save/sync.
- Change the picker data source in [ui/src/pages/Chat.tsx](/Users/zeeland/projects/rudder/ui/src/pages/Chat.tsx) to use the installed organization skill catalog, not the agent skill snapshot, and use the new public ref as the visible label.
- Keep the markdown link target pointing at the real `SKILL.md` path, so clicking still opens the skill file, while the label itself shows the readable ref and the UI shows `sourceBadge` / `sourceLabel` separately.
- Reuse the same formatting/search logic in the shared picker used by Chat and New Agent, so both surfaces show the same key grammar and search by `name`, `slug`, `sourceLabel`, and public ref.
- Document the public grammar in the repo spec so this does not get re-litigated later.

## Test Plan
- Add unit tests for public ref formatting and parsing, including round-trips for old internal refs, raw slugs, `github/*`, `url/*`, and `rudder/<skillSlug>`.
- Add API tests that prove `resolveRequestedSkillKeys` still canonicalizes old and new forms back to the current internal key.
- Update the chat skill insertion E2E to verify search, multi-select, and inserted markdown using the new readable label, with no dependency on the agent snapshot for the picker.
- Add regression coverage for the org URL-key backfill and collision handling.

## Assumptions
- `organization.urlKey` is the new stable org segment, not `issuePrefix`.
- Agent scope in the public ref is a presentation/context layer for the current pass, not a new agent-owned skill table.
- Existing stored skill keys stay valid and resolvable, so this is a compatibility-first change, not a destructive rewrite.
