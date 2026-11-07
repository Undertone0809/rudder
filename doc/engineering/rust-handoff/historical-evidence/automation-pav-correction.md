# D PAV correction r1 — fixture binding

**Overall verdict: QUESTION** for the requested native-188 public automation execution gate. The public selector passed, but its actual test database was the fixture's self-owned PostgreSQL instance using the 186-journal migration helper. It did not use the external native-188 database referenced by the environment variable.

This report supersedes the prior terminal report (SHA-256 4ff4036d1d399d33854f665b983183e511d562588f3749ef616075902cec59c7) and its manifest (SHA-256 76e06a067add29df0b17fb9ea5d8137299b4e9c04b540d2a4acd5c38448bbda9). Those receipts incorrectly bound the public Automation and Goal stop/retry selectors to an external native-188 database.

## Corrected fixture mapping

| Selector | Result | Database actually used |
|---|---|---|
| Public manual, signed-webhook, scheduler, Chat output | PASS | Self-owned loopback PostgreSQL started and stopped by the selector fixture. D fixture contract applies 186 journal migrations. It ignored the supplied RUDDER_NATIVE_AUTH_TEST_DATABASE_URL. The named external DB remained empty for organizations, automations, automation_runs, and automation_triggers. |
| Automation management permissions | PASS | External database automation_d_permissions_pav_20261028_test. No test-owned PostgreSQL startup appears in its stdout; post-run readback shows 2 organizations and 1 automation. Native preflight was current at 188 journal entries before and after. |
| Public Goal/generic stop-retry | PASS | Self-owned loopback PostgreSQL started and stopped by the selector fixture; 186-journal scope. The separately supplied external DB remained empty for organizations, automations, automation_runs, and automation_triggers. |
| D1 automation suite | PASS, 4/4 | Each case started and stopped its own PostgreSQL fixture. Per the frozen fixture contract these apply 186 journal migrations. |
| Six executor workflow groups | PASS, 11/11 | Isolated process/workflow fixtures; no provider UI or installed CLI execution. |

The corrected attribution uses the stdout lifecycle lines plus read-only database checks after the run. The external cluster ran on port 53567 and was stopped after each readback. That port belongs to the verifier-owned external cluster; it is not the ephemeral port used by the self-owned public or D1 test fixtures. The self-owned fixture logs do not retain their ephemeral port number.

## Public selector attempt history

The first public-selector attempt aborted before entering the route because its test fixture required RUDDER_SECRETS_MASTER_KEY_FILE. That setup failure is preserved. A retry with an isolated synthetic 64-hex key file passed, but the test itself used its self-owned 186-journal database. The 188-entry preflight in the retry receipt applies only to the separate external database and is not evidence for the route test.

The prior report's 188-migration claim for the public Automation and Goal stop/retry selectors is withdrawn. Native-188 was actually exercised by the Automation management permissions selector only. The main public execution selector still needs a reviewer decision on whether a separate native-188 runtime qualification is required, given the source has no SQL changes and the two additional SQL files are a SELECT 1 no-op and an ordinary index.

## Remaining boundaries

No distinct direct tenant/assignee-denial receipt is available in this packet; the automation management permissions selector passed, but I do not make a narrower denial claim. Provider UI, real user accounts, and installed Rudder CLI/provider commands remain untested. Root baseline, CI, final review, and publication remain separate.
