# Claude UI Redesign Plan

## Context

Rudder's UI currently mixes a generic shadcn/Tailwind visual system with one partially Claude-styled chat surface. That creates unnecessary drift across navigation, forms, lists, cards, and work surfaces. The goal of this redesign is to make the whole board feel like one coherent product by adopting a Claude App workspace sensibility with Anthropic brand warmth.

## Locked Decisions

- The target is a hybrid of Claude App workspace UI and Anthropic brand tone.
- The redesign applies to the full app, not a limited pilot slice.
- Both light and dark themes remain supported.
- No information architecture, API, or route changes are part of this work.

## Non-Goals

- Changing route structure or page hierarchy.
- Changing backend behavior, server contracts, or database schema.
- Reworking workflows, permissions, or product model semantics.
- Introducing a Figma-first design process before implementation.

## Implementation Order

1. Rebuild semantic design tokens and theme foundations.
2. Redesign the app shell and navigation surfaces.
3. Update UI primitives and reusable app components.
4. Restyle the core benchmark pages.
5. Bring secondary and settings/tooling pages into the same system.
6. Rewrite the design guide so it reflects the shipped system.

## Verification

- Run `pnpm -r typecheck`.
- Run `pnpm test:run`.
- Run `pnpm build`.
- Manually verify light and dark themes across dashboard, chat, issues, at least one detail page, one settings page, one onboarding/auth flow, and one mobile navigation flow.
- Manually verify hover, selected, focus-visible, disabled, destructive, loading, empty, error, dialog, sheet, and sidebar states.
- Manually verify responsive behavior for sidebar drawers, sticky headers, long lists, composer surfaces, and properties panel layouts.
