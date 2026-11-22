# Independent backend PAV — Assistance Request writes

**Verdict: PASS** for the two frozen public workflow selectors on candidate 1fb6da01d23e63ad39fafbe396f97b46fd0a7bfb.

## Candidate and fixture

Acceptance packet SHA-256: 708d215cd57bd582f398e40559cd771a624dcc7d3f0c80a8a625bd21ca3075b4. Stage-rebind review SHA-256: 603c0863672cd3189f686a4869ae2a8e61cd6605c1a12663b5a488fbfa3b61e9. The candidate worktree was clean. Frozen test binary SHA-256: 6639cd96f485b91eb0fe2106ab06c53a6dc1458d6c5645c7ff0e204dad7e47db. Owned-process host SHA-256: 4518b01db2e1466c96e12e474fa0dee719415a609aad8e443c17d3f7f93173ef.

Both selectors ran against a new private PostgreSQL 18.4 cluster and database request_writes_pav_20261028_test on port 52609, using migration fingerprint 8f9f17479c660b3e84973fc7ce7491ae559a8be24d64ce58a7527de1c07dd50e. Preflight moved from bootstrap to current, with 188 journal entries. Each selector exited 0 without timeout. Both passed their per-fixture no-Node-call assertion (count 0).

## Results

- public_ingress::tests::request_write_http_tests::native_assistance_writes_unblock_audit_wake_replay_and_fail_closed — PASS; public resolve/cancel, readback, sanitization, authentication and cross-organization denial, idempotency, transactional audit/outbox, and unavailable-Agent behavior per the frozen packet.
- public_ingress::tests::request_write_http_tests::public_assistance_resolution_executes_owned_process_and_settles_native_run — PASS; public Request resolution ran the owned /bin/sh process and settled the native run.

Independent readback shows Request cab63674-6b3f-4e1d-9215-986528217a92 resolved; its unique wake key completed; original run 129f5a9f-8bfc-4e08-a296-de6d383aa132 succeeded with exit code 0 and the process exited. Issue 53f857ef-1261-4556-870e-1f7a844c7b78 remains in_progress. A distinct passive Issue follow-up run 3c11c0d1-4ad4-4027-863e-64f4fd1a36ee was queued and is not claimed complete.

The owned PostgreSQL cluster shut down cleanly by pg_ctl fast stop; its PID file was removed and post-stop status reported no server running. Detailed stdout, migration, readback, and cleanup evidence is retained here and hash-indexed in manifest.json.

## Scope limits

This is backend acceptance for the two named selectors only. It does not establish global zero Node processes, complete Node retirement, a full Issue follow-up completion loop, Rudder CLI/provider execution, installed-release behavior, or PR/CI status.
