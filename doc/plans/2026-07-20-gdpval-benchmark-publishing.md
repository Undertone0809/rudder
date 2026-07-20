---
title: Publish the GDPval harness benchmark
date: 2026-07-20
kind: implementation
status: completed
area: benchmarks
entities:
  - gdpval_harness_benchmark
  - public_docs
  - landing_page
issue:
related_plans: []
supersedes: []
related_code:
  - docs/benchmarks/gdpval-harness.mdx
  - docs/zh/benchmarks/gdpval-harness.mdx
  - docs/docs.json
commit_refs:
  - "docs: publish GDPval harness benchmark"
updated_at: 2026-07-20
---

# Publish The GDPval Harness Benchmark

## Summary

Publish the reviewed GDPval-based harness comparison on the Rudder landing page
and in the bilingual public documentation. The landing page will place a compact
proof section immediately after the Intake section and will not include a
methodology CTA. The public documentation will carry the full methodology,
limitations, score definition, and corrected memory instrumentation account.

## Implementation

- Reuse the canonical 3200x1800 benchmark image without modifying its content.
- Add a landing-page benchmark section after Intake with concise supporting copy.
- Add English and Chinese benchmark methodology pages and navigation entries.
- Link the benchmark from both documentation home pages and `docs/llms.txt`.
- Keep the public claim scoped to a GDPval-based exploratory harness comparison,
  not an official GDPval leaderboard result.

## Verification And Release

- Verify the copied images match the canonical SHA-256.
- Run the landing-page tests and production build.
- Run Mintlify validation and inspect the rendered English and Chinese pages.
- Publish to staging first, then release documentation before the landing page
  so all public documentation URLs exist before the website change is live.
