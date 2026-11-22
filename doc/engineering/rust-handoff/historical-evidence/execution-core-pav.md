VERDICT: PASS

Verification lease:
- Git candidate: `64800e00ffda3affaaa0e04ee79e8a9a6787548b` on `codex/rust-agent-execution-core-20261028`; native source matches checkpoint `ea2f74e5d6fd16175171c7738e260ade3852069b` exactly. The diff from base `cd3efbf` over `native/` hashes to `51f1d49305c30a995bca87ff51816c345482eda16a1bc1f37a641f281040ee1a`. Only pre-existing untracked `node_modules` remains.
- Build/runtime: frozen test binary `ca7223b8ace364baf738d445e07dbae9aecde3ab7a7cbcd2221e3ad81783e023`; PostgreSQL 18.4. No Cargo or source edits during acceptance.
- Organization/data: disposable external DB `rudder_ci_public_test` at `127.0.0.1:53739`, UTF8. The Goal Stop test separately started its own journal database `postgres` at `127.0.0.1:56659`, also UTF8. No formal Rudder data was touched; both fixture processes were stopped.
- Acceptance packet: stage report `1f18755c796cc153b01d9a51fb87cf35e8a181029a671605b9c420c375785ed4`, verdict ACCEPT.

Criterion-to-proof ledger:

| Criterion | Public action | Terminal observation | Evidence |
|---|---|---|---|
| Issue Steer/reopen and adjacent safeguards | `public_issue_reads_and_agent_board_checkout_use_rust_without_node_fallback` | Exit 0; test result 1 passed. The test opened loopback HTTP listeners at 53804, 53805; PostgreSQL counters advanced. | [`selector-01.log`](/private/tmp/rudder-c-steer-pav-r4.8yuPIg/logs/selector-01.log) |
| 12 requested public selectors | Run each exact selector from the approved workflow block against `rudder_ci_public_test` | 12/12 exit 0; UTF8 verified before migration and execution. | [`initial-utf8-selector-run.json`](/private/tmp/rudder-c-steer-pav-r4.8yuPIg/initial-utf8-selector-run.json), [`logs/`](/private/tmp/rudder-c-steer-pav-r4.8yuPIg/logs) |
| Goal Stop/retry/failure adjacency | `public_goal_and_generic_execution_stream_stop_retry_and_failures_are_native` with frozen process-host binary and isolated `RUN_LOG_BASE_PATH` | Exit 0; test result 1 passed; internal journal PG observed live at port 56659 with UTF8 and stopped by test cleanup. | [`goal-stop-retry-rerun.log`](/private/tmp/rudder-c-steer-pav-r4.8yuPIg/logs/goal-stop-retry-rerun.log), [`goal-stop-retry-rerun.json`](/private/tmp/rudder-c-steer-pav-r4.8yuPIg/goal-stop-retry-rerun.json), [`internal-db-56659.log`](/private/tmp/rudder-c-steer-pav-r4.8yuPIg/logs/internal-db-56659.log) |

Adjacent risk checked:
- The Goal test’s own journal PostgreSQL was distinguished from external fixture URL/port 53739. Runtime process snapshots captured `initdb`, `pg_ctl`, the live listener, and a successful SQL identity/encoding readback on port 56659.
- The first two Goal attempts stopped before the workflow due to missing isolated test prerequisites (`RUDDER_POSTGRES_BIN_DIR`, then `RUN_LOG_BASE_PATH`); after both were set to disposable local paths, the selector passed.

The earlier SQL_ASCII fixture failure remains a separate prior fixture identity; this run used a fresh UTF8 fixture and read back `SHOW server_encoding = UTF8`.

Lease recheck: current. The final HEAD adds release documentation/workflow material after the checkpoint; the Rust source diff is empty from the checkpoint, the approved 12-selector workflow block is unchanged, and the frozen artifact SHA is unchanged. The unrelated newPRCI failure remains outside this acceptance claim.

Machine-readable receipt: [`pav-final.json`](/private/tmp/rudder-c-steer-pav-r4.8yuPIg/pav-final.json).
