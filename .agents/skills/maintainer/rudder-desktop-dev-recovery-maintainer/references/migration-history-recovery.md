# Desktop Migration-History Recovery Reference

Read this reference before changing a packaged or development instance when
the failure mentions migrations, the migration journal, schema history, an
upgrade, a rollback, a database backup, or a candidate that may have been
built from another history. The goal is to establish whether the named
candidate can move the same data forward safely; it is not a general database
repair recipe.

## Lock the identities first

Record non-secret identities before touching the database or installed app:

- the installed app path, exact version, platform/architecture, channel, and
  artifact checksum;
- the app's resolved runtime owner, `localEnv`, `instanceId`, profile, port,
  data directory, and sanitized API origin;
- the candidate's explicit version/ref, packaged migration manifest fingerprint,
  migration journal, SQL-file fingerprints, and compatibility declaration; and
- the live journal's applied order, identifiers, hashes, and data identity.

Do not infer a recovery target from `n-1`, a semver comparison, a nearby
worktree, or a healthy server. Keep the installed app and its exact runtime
release set available as the last-known-good backup candidate until the named
candidate has been accepted.

## Compare packaged manifest and live journal

Compare the candidate's packaged manifest (journal metadata plus every SQL
file) with the live database journal. The shared history must match by order,
file/identifier, and checksum. Then classify the relationship before any
mutation:

| Classification | Evidence | Action |
| --- | --- | --- |
| `forward-known` | The live journal is an exact prefix of the named candidate and every pending entry is an explicit, known candidate migration. For example, a `v0.7.2` baseline through `0148` is recognized by named `v0.7.3` migrations `0149_app_builder_verified_source_ready`, `0150_rudder_plugins_v1`, and `0151_agent_issue_creation_requests`. | Continue only through the backup and isolated-forward gates below. |
| `unknown` | A live identifier/hash is absent from the candidate manifest or compatibility declaration, or the candidate has no named fixture/forward relationship for this baseline. | `BLOCKED`; preserve the original data and do not guess a repair. |
| `checksum-mismatch` | A shared order/file has a different SQL or journal hash, or the packaged manifest fingerprint does not match its declared identity. | `BLOCKED`; treat published history as immutable and potentially tampered. |
| `fork` | The live and candidate histories share a prefix and then each has a different valid next entry, including a local hotfix branch. | `BLOCKED` unless a separately named candidate explicitly recognizes that fork; never choose one branch by recency or version number. |

An `unknown`, `checksum-mismatch`, or `fork` classification is not made safe by
deleting rows, editing `_journal.json`, replacing SQL in place, or starting an
older server. Migration history is append-only. Never delete journal entries,
rewrite published SQL, or downgrade in place against the original data.

## Require a verified backup before mutation

For a non-empty or potentially user-owned instance, capture a restorable
pre-migration backup before normalization, reconciliation, or pending
migrations. A backup is verified only when all of the following are recorded:

- source data identity: the exact `localEnv`, `instanceId`, profile/data root,
  organization/workspace sentinel, and candidate source version;
- a completed restore/readback check against an isolated database or an
  equivalent restorable target;
- backup path, byte size, checksum, and creation result; and
- sufficient free space for both the backup and the isolated validation copy.

An existing file with a plausible name, a partial dump, or a backup from a
different instance is not a recovery point. If backup creation, restore
verification, data identity, or free-space proof is missing, return
`BLOCKED` before changing the original database. Preserve any failed or
partially-created recovery artifact for diagnosis when safe.

The installed app itself also needs a recoverable release-set record: exact app
asset/path, version, runtime payload, profile, and checksum. Do not replace the
installed app until that backup or last-known-good record is retained.

## Validate the smallest forward runtime in isolation

For `forward-known` history, select the smallest explicitly named candidate
runtime that contains the live prefix and the required pending migrations. Use
an isolated copy of the backed-up database with a distinct Rudder home,
instance, port, profile, and PostgreSQL data directory. The copy must retain
the original data identity and representative size/sentinels; a fresh empty
database only proves boot.

Run the candidate's migration/boot path against that copy, then verify the
manifest and journal, core relationships and permissions, organization/workspace
sentinels, first usable Desktop view, and a controlled restart. Keep the
original instance stopped or untouched during this rehearsal. A successful
isolated candidate, a verified backup, or a booting server alone is
`candidate-only`/`backup-only` evidence, not Desktop recovery.

After the isolated gate passes, launch the named installed app against the
original same workspace and verify matching runtime identity, preserved data,
the requested Desktop behavior, and restart persistence when that was in
scope. Do not substitute a new workspace, another checkout, API health, or a
renderer-only screenshot for same-workspace proof.

## Terminal outcomes

- `RECOVERED` requires the named Desktop path to open, the expected candidate
  and runtime identity to match, the same organization/workspace data to be
  usable, and the requested behavior (plus restart persistence when requested)
  to be observed. State whether migration was forward-known and cite the
  backup, isolated-copy, and same-workspace evidence.
- `BLOCKED` is required for unknown history, checksum mismatch, fork without a
  recognized named candidate, missing/invalid backup, insufficient space,
  failed isolated validation, or absent same-workspace proof. Name the first
  failing layer and retain the diagnostic evidence.

Never promote `candidate-only`, `backup-only`, `health-only`, or
`same-runtime-but-different-workspace` evidence to `RECOVERED`.

When this route is used, append these fields to the normal recovery report:

```text
Migration history: forward-known | unknown | checksum-mismatch | fork
Candidate/manifest identity:
Live journal identity:
Installed-app backup:
Data backup and free-space gate:
Isolated forward validation:
Same-workspace Desktop proof:
```
