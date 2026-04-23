# Instance-Level UI i18n with Simplified Chinese

## Summary

Add a lightweight UI i18n layer for the board app, expose an instance-global language setting in `System Settings > General`, and ship `en` plus `zh-CN` for the first pass.

## Key Changes

- Extend `InstanceGeneralSettings` with `locale: "en" | "zh-CN"` and default it to `en`.
- Persist locale inside the existing `instance_settings.general` JSON payload; no DB migration.
- Surface the active locale through `/api/health` so the app shell can read the instance language without requiring admin-only settings access.
- Add a small in-repo i18n provider and message dictionaries in `ui/`.
- Translate the first-pass surfaces:
  - app bootstrap / onboarding gate copy
  - system settings shell
  - organization settings shell
  - breadcrumb / mobile shell labels
  - system settings pages: general, profile, heartbeats, experimental

## API / Interface Changes

- `InstanceLocale` type: `"en" | "zh-CN"`
- `InstanceGeneralSettings.locale`
- `PatchInstanceGeneralSettings.locale?`
- `GET /api/health` response includes `uiLocale`

## Test Plan

- Validate locale schema accepts only `en` and `zh-CN`.
- Verify instance settings normalization defaults missing locale to `en`.
- Verify instance settings route GET/PATCH includes locale.
- Verify health route returns `uiLocale`.
- Verify UI translation lookup falls back to English for missing keys.

## Assumptions

- Locale is instance-global and configured in System Settings.
- Writing locale remains admin-only because it lives under general instance settings.
- Reading locale is safe for all board users through the health endpoint.
- First pass covers the shell and settings surfaces, not every page in the product.
