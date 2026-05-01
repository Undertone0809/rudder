---
title: Google Calendar OAuth settings
date: 2026-05-02
kind: implementation
status: completed
area: ui
entities:
  - google_calendar_oauth
issue:
related_plans:
  - 2026-04-15-local-app-langfuse-settings.md
supersedes: []
related_code:
  - ui/src/pages/Calendar.tsx
  - server/src/services/calendar.ts
  - server/src/routes/calendar.ts
  - packages/shared/src/validators/calendar.ts
  - tests/e2e/calendar-v1.spec.ts
commit_refs:
  - feat: add Google Calendar OAuth settings
updated_at: 2026-05-02
---

# Google Calendar OAuth Settings

## Goal

Let board operators configure Google Calendar OAuth from Rudder instead of
editing server environment variables and restarting the app.

## Problem

The current Calendar modal sends users to server environment variables when
Google OAuth credentials are missing. That breaks local and packaged production
usage because the operator is already inside the product flow and may not have a
practical way to edit runtime env. It also slows time-to-first-success for a
feature that should behave like a normal integration setup.

## Scope

- Add an organization-scoped Google Calendar OAuth config API.
- Persist client ID as configuration and client secret through the existing
  organization secret provider.
- Keep existing environment variables as an admin-managed fallback.
- Update the Calendar modal so missing config is recoverable in place.
- Update E2E coverage for the new setup flow.

## Out Of Scope

- Changing the Google callback URL shape.
- Supporting multiple Google OAuth clients per organization.
- Importing writable Google Calendar events.
- Showing or exporting stored client secret values.

## User Flow

1. The operator opens the Google Calendar modal.
2. If credentials are missing, Rudder shows client ID and client secret fields,
   plus the redirect URI to configure in Google Cloud.
3. The operator saves and connects.
4. Rudder stores the secret safely, creates or reuses the Google calendar
   source, and redirects to Google OAuth.
5. If credentials come from server environment variables, the modal shows a
   read-only managed state and still allows connect.

## Implementation Notes

- Reuse organization secret storage rather than storing secret material in
  calendar source JSON.
- Keep all routes board-only and organization-scoped.
- Never log or return the client secret.
- Preserve backward compatibility for existing env var deployments.

## Validation

- Typecheck the touched packages if possible.
- Run the calendar E2E slice or report any environment blocker.
- Run the existing targeted calendar/server tests if available.

## Result

- Added organization-scoped Google Calendar OAuth config routes.
- Stored OAuth client secret through the organization secret provider instead
  of calendar source JSON.
- Kept server environment variables as a read-only managed override.
- Updated the Calendar modal to collect, save, rotate, clear, and connect
  OAuth credentials in place.
- Updated Calendar E2E expectations for the new setup flow.

## Validation Run

- `pnpm --filter @rudderhq/shared typecheck`
- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/ui typecheck`
- `pnpm -r typecheck`
- `pnpm build`
- `pnpm test:e2e tests/e2e/calendar-v1.spec.ts` did not reach assertions
  because Chromium headless launch timed out after 180 seconds for each case.
- `pnpm test:run -- calendar` unexpectedly ran the full Vitest suite; 1301
  tests passed and one unrelated cost route test failed with `socket hang up`.
- Local API smoke verified env-managed config returns an authorization URL and
  rejects UI edits while server env credentials are active.
