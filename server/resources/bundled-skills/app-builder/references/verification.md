# Verification

Use Rudder's run-scoped Browser integration for rendered verification. Do not
substitute a shell HTTP response for UI acceptance.

## Required Pass

1. Open the attested App Builder preview in a run-owned Browser tab.
2. Verify the health-ready primary route.
3. Complete the main create/read/update workflow with development or snapshot
   data.
4. Reload and verify the expected persistence.
5. Exercise one relevant edge case: empty state, invalid import, duplicate
   record, failed external API, missed job, permission denial, or migration
   failure.
6. Check console errors.
7. Verify desktop layout and a 390px viewport unless mobile is excluded.
8. Capture current screenshots of the useful final state.
9. Materialize screenshots in Chat, Run, or Library evidence.

Close temporary run-owned tabs after verification. Never use the user's
persistent app view as an Agent test fixture when that could mutate formal
data.
