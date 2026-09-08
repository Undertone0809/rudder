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
| Product behavior | Implementation and tests | Executable behavior and regression evidence | Proposals, PRs, engineering and public docs |
| Contributor and operator how-to | `doc/engineering/**` | How to build, run, package, release, operate, and author plugins | AGENTS, scripts, code comments, SDK docs |
| Decision history | `doc/plans/**` | Dated proposals for meaningful design decisions | Proposals, PRs, and code comments |
| Retired product contracts | `doc/product/**` except `PRODUCT.md` | Historical reference; no maintenance or approval gate | Historical research only |
| Historical material | `doc/archive/**` | Superseded specs, old task models, and future target sketches kept for archaeology | Human research only; do not cite as current behavior |
| Public docs | `docs/**` | User-facing website docs | Website/docs work only |

## Start Here

- Product direction and definition: `doc/product/PRODUCT.md`
- Current product logic: relevant implementation and tests
- Design proposals: `doc/plans/`
- Development setup: `doc/engineering/DEVELOPING.md`
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
idea, use it in a proposal or implement and test it. Put current how-to guidance
in `doc/engineering/**`; cite the archive only as historical background.
