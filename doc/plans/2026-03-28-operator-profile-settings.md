# Operator Profile Settings (`Your nickname` / `More about you`)

## Overview

- Add a user-level `Profile` page in the system settings, with the fields `Your nickname` and `More about you`.
- Do **not** change the onboarding flow on first launch; if the user hasn't filled in these fields, the chat assistant's system prompt should inject no profile info by default.
- Profile data is stored per-user; under `local_trusted`, treat `local-board` as the user, so the local experience still stores one profile per user.

## API and Data Changes

- Add a new user-level `profile` table, using `user_id: text` as the primary/unique key. **Do not** add a foreign key constraint to the Better Auth `user` table; this is required for `local-board` compatibility.
- Only keep the fields: `nickname`, `more_about_you`, `created_at`, and `updated_at`. This is instance-level user profile data and should **not** include `org_id`.
- Add `OperatorProfileSettings` and `PatchOperatorProfileSettings` types and validation in the shared layer.
- Add `GET /api/instance/settings/profile` and `PATCH /api/instance/settings/profile` endpoints:
  - Require only `board` role/identity, not `instance_admin`.
  - API responses should always use strings for the UI; blank input is `trim`med, persisted as `null`, and mapped back to `""` on read.
- Keep `user.name` in Better Auth as the login identity field; the new `nickname` should **not** write back to the auth username.

## Implementation

- **System Settings UI:**
  - Add a new page under `/instance/settings/profile` with a `Profile` nav item in `InstanceSidebar`.
  - Use the existing settings scaffold to show loading, saving, and error states.
  - Add a query for the current board access state, preferably by reusing `/api/cli-auth/me`. This allows authenticated, non-admin users to default to the `Profile` page and hides/disables admin-only setting entries, preventing a default redirect to `/instance/settings/general` and an unnecessary 403.
- **Server:**
  - Add a profile service to read and write the current user's profile using `req.actor.userId`. For `local_trusted`, use `local-board` directly.
  - Profile updates should still log to the activity log; scope log entries according to organizations visible to the user. If there are no organizations, skip the log without error.
- **Chat Injection:**
  - Only adjust the built-in chat assistant: before generating an assistant reply with `POST /api/chats/:id/messages`, read the current board user's profile and pass it to `chatAssistantService`.
  - Prompt rules are as follows:
    - If `nickname` is present, use it as the preferred form of address.
    - If `more_about_you` is present, inject it as background context.
    - If both fields are blank, add no profile information at all.
  - Do **not** change agent heartbeat prompts, agent instructions, issue proposal schema, organization default chat config, or other AI surfaces.
- **Documentation:**
  - When implementation is complete, add a short note to `doc/SPEC-implementation.md` describing that system settings now provide a user-level chat profile.

## Testing

- **Data/Service:**
  - `local-board` can create, read, and update a profile.
  - Two authenticated users have separate, non-overlapping profiles.
  - Blank input is trimmed and normalized.
- **Routes/Permissions:**
  - `GET/PATCH /api/instance/settings/profile` are available to both local board and non-admin board users.
  - Agent and anonymous access are rejected.
  - Activity logging on update behaves as expected and does not throw if there is no organization.
- **Chat:**
  - If there is profile data, the assistant prompt includes nickname and/or more-about-you sections.
  - If profile is empty, assistant prompt does not include any profile injection.
  - Only affects the built-in `/chat` assistant.
- **UI:**
  - Profile page loads and saves correctly.
  - Authenticated, non-admin users default to a page they can access in system settings, rather than landing on a forbidden page (403).

## Assumptions and Defaults

- This is "your own user profile", not an organization-level or global instance shared config.
- Only used for chat assistant system prompt injection—**does not** affect UI display name, comment author, exports, or auth username display.
- Onboarding is unchanged; these fields are managed only later through system settings.
