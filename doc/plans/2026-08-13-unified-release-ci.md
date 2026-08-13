---
title: Unified Test, Release, and Docs Release workflows
date: 2026-08-13
kind: implementation
status: completed
area: deployment
entities:
  - release_pipeline
  - desktop_release
  - docs_release
issue:
related_plans:
  - 2026-07-22-release-pipeline-latency.md
supersedes: []
related_code:
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - .github/workflows/docs-production.yml
commit_refs: []
updated_at: 2026-08-13
---

# Unified Test, Release, and Docs Release workflows

## Goal

Reduce Rudder's product delivery pipeline to three visible workflows while
moving every packaged Desktop gate before the first irreversible publish
mutation.

## Delivery model

1. `Test` qualifies an immutable source SHA and runs a fast packaged macOS arm64
   account-gate smoke in addition to the existing source, docs, and platform
   checks.
2. `Release` builds and smokes the final four-platform Desktop candidates,
   stores them as run artifacts, and only then publishes npm, tags, the GitHub
   Release, and those exact Desktop artifacts.
3. `Docs Release` deploys production docs from the immutable stable tag. The
   stable Release calls it after publication while public install smoke runs as
   final jobs in the same Release workflow.

Automatic canaries remain enabled. Docs staging is removed. Recovery and
monitoring workflows remain available under an `Ops:` display-name prefix and
are not part of the product delivery chain.

## Acceptance

- No npm package, git tag, GitHub Release, or Desktop asset is published before
  the final Desktop candidate matrix succeeds.
- Release uploads the Desktop artifacts produced by that matrix and never
  dispatches a second Desktop workflow.
- Stable completion requires Docs Release, public install smoke on Linux,
  Windows, and macOS, public-surface verification, cleanup, and the next-version
  handoff.
- Dry runs remain read-only and partial recovery never republishes an existing
  immutable npm version.
