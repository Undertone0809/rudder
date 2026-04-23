# Chat Skill Tokens: Immediate Insert + Non-Editable Rendering

## Summary

Treat chat skill references as inline skill tokens rather than generic markdown links.

Success criteria:

- clicking a skill row inserts it immediately into the composer
- the skill menu no longer requires a second confirmation action
- inserted skills render as obvious inline skill tokens using the public ref label
- clicking a skill token does not expose raw path editing or link interaction UI

## Implementation Changes

- Update the chat composer skill picker to insert a single skill immediately on row click, then close and reset the menu state.
- Keep the stored markdown wire format unchanged as `[$public/ref](/path/to/SKILL.md)` for downstream skill resolution.
- Introduce a shared skill-reference recognizer so message rendering and editor decoration use the same rules.
- Render recognized skill references as non-interactive inline tokens in `MarkdownBody`.
- Decorate recognized skill links as non-editable tokens inside `MarkdownEditor`, and suppress pointer interaction that would open link-edit affordances.
- Add compact shared CSS for skill tokens that makes them visually distinct without reading as navigable links.

## Test Plan

- Add unit tests for skill-reference recognition and insertion deduplication behavior.
- Update markdown rendering tests to verify skill references render as non-link tokens.
- Update E2E chat skill flows to verify immediate insertion, preserved markdown storage, and visible token rendering in the conversation.

## Assumptions

- Single-click insertion is the approved interaction.
- Skill tokens should be visually obvious but quieter than existing mention chips.
- No API, DB, or markdown storage contract changes are required.
