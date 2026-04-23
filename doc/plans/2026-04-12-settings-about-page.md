# Settings About Page

## Summary

- Primary diagnosis: settings information architecture gap.
- Secondary diagnosis: desktop integration gap for app-lifecycle actions.
- The product already exposes version information in scattered places, but it does not provide a clear About surface for version, update, and feedback actions.
- This pass should add a compact `About` page under instance settings rather than overloading `General`.

## Professional Translation

- “setting 里加一个 About” means the app needs a conventional home for identity and lifecycle actions, not another generic preference row.
- “显示当前版本” means version should be first-class, easy to scan, and sourced from the actual running desktop/runtime state.
- “check for update” means the UI needs an explicit desktop action hook, even if the current implementation only performs a best-effort/manual update check.
- “Send Feedback” means the app should route to the operator’s default mail client with a prefilled recipient, not open an internal form.

## Evaluation Criteria

- The new page is clearly discoverable from the settings nav as `About`.
- The page reads like a compact operator tool surface, not a marketing/about dialog.
- Version data is concrete and stable in desktop mode, with graceful fallback in web/dev mode.
- Both actions are explicit buttons with immediate understandable behavior.
- The change preserves existing settings density and hierarchy rules from `doc/DESIGN.md`.

## Implementation Changes

- Add an `About` route under `/instance/settings/about`.
- Add `About` navigation entries anywhere instance settings routes are normalized or remembered.
- Build a dedicated `InstanceAboutSettings` page using the existing settings scaffold.
- Expose desktop shell methods for:
  - checking for updates
  - opening a feedback mailto link
- Wire the About page buttons to the desktop shell when available, with safe browser fallback for mail feedback.
- Keep `General` focused on preferences; do not turn it into the About page.

## Test Plan

- Run `pnpm -r typecheck`.
- Run the relevant unit tests for settings path normalization.
- Add or update E2E coverage for the desktop settings About page and its visible actions.
- Run the affected E2E spec.
- If desktop IPC behavior changes affect packaged startup/shell behavior, run `pnpm desktop:verify`.

## Assumptions

- `Check for update` can be a best-effort action that triggers Electron’s updater/manual-check hook without requiring a fully custom update UI in this pass.
- `Send Feedback` should open the default mail client to `zeeland4work@gmail.com`.
- The page belongs to instance/admin settings, alongside General, Experimental, and Plugins.
