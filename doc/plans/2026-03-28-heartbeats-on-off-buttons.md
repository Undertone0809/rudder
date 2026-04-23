# Heartbeats On/Off Buttons Plan

## Summary

- First implementation step: write this plan into `doc/plans/2026-03-28-heartbeats-on-off-buttons.md`.
- Change the row-level control in `System Settings > Heartbeats` from a status badge plus action button into directly clickable `On` / `Off` buttons.
- Treat `On` / `Off` as the `heartbeat.enabled` configuration state, not a promise that scheduler execution is currently active.

## Key Changes

### 1. Heartbeats settings row control

- Replace the current `On` / `Off` badge and `Enable/Disable Timer Heartbeat` action with a local two-button control in `ui/src/pages/InstanceSettings.tsx`.
- Make `On` the emphasized selected state when `heartbeatEnabled === true`.
- Make `Off` the secondary selected state when `heartbeatEnabled === false`.
- Disable both buttons while the row update is pending so duplicate requests cannot be queued.

### 2. Explicit heartbeat updates

- Replace the current row mutation that flips state with `!agentRow.heartbeatEnabled`.
- Introduce an explicit `setHeartbeatEnabled(agentRow, enabled)` helper so the row controls can set `true` or `false` directly.
- Reuse the same helper for `Disable All` so all heartbeat-enabled rows still update through the same `runtimeConfig.heartbeat.enabled` patch path.

### 3. Separate config state from scheduler state

- Remove the ambiguous row badge that currently reflects `schedulerActive`.
- Show a distinct scheduler status label instead:
  - `Scheduled` when `schedulerActive === true`
  - `Configured, inactive` when `heartbeatEnabled === true && schedulerActive === false`
  - `Disabled` when `heartbeatEnabled === false`
- Keep interval and last heartbeat values unchanged.
- Do not auto-write a fallback interval when turning `On`; only `heartbeat.enabled` changes.

## Public Interfaces / Contracts

- No API route changes.
- No shared type, database schema, or migration changes.
- Continue using the existing instance heartbeat list endpoint and agent patch endpoint.
- UI updates must preserve all existing `runtimeConfig.heartbeat.*` fields except the targeted `enabled` value.

## Test Plan

- Verify a heartbeat-enabled row renders `On` selected and switches to `Off` after clicking `Off`.
- Verify a heartbeat-disabled row renders `Off` selected and switches to `On` after clicking `On`.
- Verify only the active row control locks during a single-row update.
- Verify `Disable All` still disables every currently enabled timer heartbeat.
- Verify rows with `heartbeatEnabled=true` and `schedulerActive=false` show `On` plus `Configured, inactive`.
- Run:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Assumptions

- This change is limited to the system Heartbeats settings page.
- Agent detail and agent form heartbeat toggles stay unchanged.
- The requested UX is direct state control via `On` / `Off` buttons, not a deeper scheduler-policy redesign.
