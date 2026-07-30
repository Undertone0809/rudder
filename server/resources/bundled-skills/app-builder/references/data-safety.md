# Data Safety

## Choose The Least-Risky Data Mode

| Situation | Default |
| --- | --- |
| New app | Synthetic fixtures in `data/development/dev.sqlite` |
| UI or ordinary logic change | Snapshot of existing data |
| Real-record diagnosis | Ask for original, snapshot, or redacted copy |
| Schema change | Backup and migration rehearsal on a snapshot |
| User explicitly requests a formal-data mutation | State scope and ask at action time |

Do not read user records merely to make sample UI realistic. Prefer schema,
counts, synthetic records, or a redacted subset.

## SQLite Rules

- Never copy a live SQLite file with an ordinary byte copy while it may be
  writing. Use SQLite's backup API.
- Keep formal data, development data, uploads, exports, and snapshots distinct.
- Put migrations in source control; never hand-edit a formal database schema.
- Validate imports completely before beginning the transaction.
- Use stable external ids or idempotency keys for repeated imports and jobs.
- Stop or roll back the whole transaction on one invalid import record.

## Model Boundary

A local app is not automatically confidential. The configured model may be
remote, and source or records included in prompts may leave the device. Before
using real records for diagnosis, name this boundary and obtain the user's
choice. Never put secret values, OAuth tokens, private keys, or session cookies
in model context.

## Evidence

Record which data mode was used, the snapshot identity when applicable,
migration result, row-count checks, and known limitations. Do not attach the
database itself to Chat unless the user explicitly requests that transfer.
