# Issue Board And Org Goals Polish

## Summary

- Add subtle status-tinted depth to each issue board lane so empty and populated columns remain scannable.
- Tighten `Issue views` and related board surfaces onto a smaller, consistent radius system.
- Move `Goals` out of the primary rail and into the organization workspace navigation while keeping `/goals` routes unchanged.

## Implementation Changes

- Update the issues board toolbar and lane/card surfaces to use compact shared radii instead of oversized, mixed rounding.
- Add per-status lane surface styling for `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, and `cancelled`.
- Treat `/goals` as part of the org workspace shell and show `Goals` in the org context sidebar between `Structure` and `Skills`.
- Remove the top-level `Goals` entry from the primary rail and legacy sidebar work group.

## Verification

- Add or update Playwright coverage for:
  - org workspace sidebar showing `Goals`
  - `/goals` rendering in the org three-column shell
  - inbox shell no longer exposing a primary-rail `Goals` link
  - issues board lanes rendering tinted surfaces with compact radii
- Run:
  - `pnpm test:e2e`
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Assumptions

- `Goals` remains a standalone page and detail route; only navigation ownership changes.
- Lane color depth is subtle surface tinting, not saturated fills.
