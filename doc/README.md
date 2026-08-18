---
title: Internal Documentation Index
status: active
---

# Internal Documentation Index

Use this page to choose the current source of truth. Do not scan all of
`doc/` by default.

## Source Of Truth Matrix

| Area | Current source | Purpose | Allowed inbound references |
| --- | --- | --- | --- |
| Product behavior | `doc/product/**` | Current product contracts: why, object model, flow, evidence, and tests | AGENTS, plans, PRs, code comments when referencing product contracts |
| Contributor and operator how-to | `doc/engineering/**` | How to build, run, package, release, operate, and author plugins | AGENTS, scripts, code comments, SDK docs |
| Decision history | `doc/plans/**` | Dated proposals and implementation plans | Plans and product contracts may cite as historical context |
| Historical material | `doc/archive/**` | Superseded specs, old task models, and future target sketches kept for archaeology | Human research only; do not cite as current behavior |
| Public docs | `docs/**` | User-facing website docs | Website/docs work only |

## Start Here

- Product direction and definition: `doc/product/PRODUCT.md`
- Current product logic: `doc/product/README.md`, then the owning domain under
  `doc/product/domains/`
- Contributor workflow and verification policy: root `AGENTS.md`
- Local setup and worktree isolation: `doc/engineering/LOCAL-DEVELOPMENT.md`
- Architecture guardrails: `doc/engineering/ARCHITECTURE-GUARDRAILS.md`
- Performance and production-shaped data: `doc/engineering/PERFORMANCE.md`
- Database and migrations: `doc/engineering/DATABASE.md`
- CLI behavior: `doc/engineering/CLI.md`
- Desktop and packaging: `doc/engineering/DESKTOP.md`
- Release and publishing: `doc/engineering/RELEASING.md`,
  `doc/engineering/PUBLISHING.md`
- Plugin authoring: `doc/engineering/PLUGIN_AUTHORING_GUIDE.md`
- Plugin host/runtime technical anchors:
  `doc/engineering/PLUGIN_RUNTIME_CONTRACT.md`

## Archive Rule

Archived docs are not maintenance targets. If an archived doc contains a useful
idea, move the current behavior into `doc/product/**` or the current how-to into
`doc/engineering/**`, then cite the archive only as historical background.
