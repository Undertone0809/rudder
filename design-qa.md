# Chat Work Manifest Subagents — Design QA

## Reference and implementation evidence

- Codex list reference:
  `/var/folders/5l/j5_nt6_x45bbmygxn444r24r0000gn/T/codex-clipboard-d6bf2e65-7a74-40c6-89e8-a01f8a19dae3.png`
- Codex manifest reference:
  `/var/folders/5l/j5_nt6_x45bbmygxn444r24r0000gn/T/codex-clipboard-e505e39d-77cd-457b-80c4-6d4216ea3195.png`
- Rudder light manifest:
  `/tmp/rudder-chat-work-manifest-subagents-final/manifest-subagents-light-1440x900.png`
- Rudder light list:
  `/tmp/rudder-chat-work-manifest-subagents-final/subagents-list-light-1440x900.png`
- Rudder dark list:
  `/tmp/rudder-chat-work-manifest-subagents-final/subagents-list-dark-1440x900.png`
- Rudder narrow manifest:
  `/tmp/rudder-chat-work-manifest-subagents-final/manifest-subagents-dark-narrow.png`
- Full-view list comparison:
  `/tmp/rudder-chat-work-manifest-subagents-final/reference-vs-rudder-list.png`
- Focused manifest comparison:
  `/tmp/rudder-chat-work-manifest-subagents-final/reference-vs-rudder-summary.png`

The implementation evidence was captured from a real local Rudder API,
embedded PostgreSQL database, Vite UI, and Chromium. Desktop captures use a
1440×900 viewport; the compact capture uses 900×900. Reference crops were
scaled to the implementation height only for side-by-side visual inspection.

## State coverage

- Light: 2 Active and 4 Done, four Oreo avatars, long accessible name,
  failed/interrupted terminal states, and list-to-detail navigation.
- Live transition: an Active detail reaches Completed inside the same source
  message and displays its final transcript response.
- Dark: 0 Active and 6 Done after transition, with a stable Side Panel width.
- Narrow: the compact `Subagents 6` manifest entry remains usable.
- Persistence: reload, Side Panel hide/restore, and canonical detail-tab
  deduplication were exercised.

## Fidelity assessment

- Information architecture matches the Codex references: compact avatar/count
  summary, then `Active · N` and `Done · N` groups with avatar, readable name,
  status, and relative time.
- Typography, spacing, radii, surfaces, shadows, and scrolling use Rudder's
  existing design tokens. The Rudder shell remains intentionally rounder than
  the Codex panel rather than introducing a foreign card style.
- Existing Oreo avatar assets are used; no placeholder or approximated assets
  were introduced.
- Terminal failures and interruptions keep semantic visual treatment while
  remaining inside the Done group.
- Truncated labels retain the full value through title/accessibility text.

## Comparison history

1. Initial dark capture was taken during the Side Panel width transition and
   clipped the tab/list edge.
2. The E2E capture now waits for the panel to exceed 300px and settle before
   taking the screenshot.
3. The post-fix dark capture is stable and the independent verifier returned
   PASS.

No unresolved P0, P1, or P2 design-fidelity issues remain. The only visible
difference from Codex is the intentional use of Rudder's established shell
radius, width, and surface tokens.

final result: passed
