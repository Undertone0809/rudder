# Chat Options Popover Menu

Date: 2026-04-02
Status: Approved

## Summary

- Replace the chat composer `Options` inline expansion panel with a Claude-style floating menu.
- Keep the change UI-only and desktop-first. Do not change chat data contracts, runtime behavior, or backend APIs.

## Implementation Changes

- Update the composer in `ui/src/pages/Chat.tsx` so the `Options` chip becomes a real menu trigger.
- Remove the current inline `optionsOpen` expansion region that pushes the composer taller when opened.
- Rebuild the options interaction with the existing Radix dropdown primitives already wrapped in `ui/src/components/ui/dropdown-menu.tsx`.
- Use a two-level menu:
  - top level shows `Preferred agent`, `Issue creation`, and `Operation mode`
  - each item shows the current summary value
  - selecting an item opens a submenu with the available choices
  - selecting a value applies it immediately and closes the menu
- Preserve the current state semantics:
  - before a conversation exists, option changes only update local draft state
  - after a conversation exists, option changes persist through the existing chat update mutation
- Keep the runtime badge separate from the options menu.
- Keep mobile behavior uncustomized for this pass; the same dropdown remains available, but no mobile-specific drawer/sheet treatment is introduced.

## Public Interfaces / Types

- No API, schema, shared types, validators, or route changes.
- No chat payload changes.

## Test Plan

- Add a Playwright E2E that:
  - creates an organization and a chat conversation
  - opens the `Options` menu from the composer
  - changes `Preferred agent`, `Issue creation`, and `Operation mode`
  - verifies the menu closes after selection
  - refreshes and confirms the selected summaries persist
- Run `pnpm -r typecheck`.
- Run `pnpm test:run`.
- Run `pnpm build`.
- Run the relevant E2E coverage for chat options.
- Manually verify the chat composer visually to confirm:
  - the menu anchors to the `Options` chip
  - submenu positioning is stable
  - the composer height no longer jumps when opening options
  - summaries remain readable and aligned with the existing Rudder visual system

## Assumptions

- The goal is to match Claude's interaction pattern, not to clone Claude's exact visual styling.
- Scope is limited to the chat composer `Options` control.
- `Add files`, `RuntimeBadge`, and the rest of the composer layout remain structurally unchanged.
