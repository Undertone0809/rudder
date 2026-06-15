# Rudder Mintlify Docs

This directory contains the first Mintlify documentation site for Rudder.

## Local Development

From the repository root:

```bash
pnpm docs:dev
```

Validate the docs project:

```bash
pnpm docs:validate
```

Check the public docs surface after a deploy:

```bash
pnpm docs:health
```

By default this checks the canonical docs domain plus the public Vercel project
aliases. Use `DOCS_HEALTH_HOSTS=host.example.com pnpm docs:health` when you
need to check only one deployment channel.

## Deployment

The docs site has two Vercel-backed channels:

- `staging.doc.rudder.zeeland.studio`: automatically updated from `main` by
  `.github/workflows/docs-staging.yml`.
- `doc.rudder.zeeland.studio`: manually published by
  `.github/workflows/docs-production.yml`.

Both workflows validate the Mintlify project, export the static site, deploy it
through the Vercel CLI, assign the channel domain, and verify key public paths
such as `/robots.txt`, `/sitemap.xml`, `/zh`, `/llms.txt`, and favicons.
Production publishes also bind the public Vercel project aliases to the same
deployment and create a `docs/vYYYY.MM.DD` git tag for the source commit.
Those aliases are intentionally production-facing public entry points; the
staging channel uses `staging.doc.rudder.zeeland.studio` only. Staging pages are
still expected to emit production canonical URLs so preview traffic does not
compete with the canonical docs host in search indexes.

## Content Scope

The docs tree provides English and Simplified Chinese navigation through Mintlify language entries in `docs.json`. Product screenshots and screenshot-style assets used by the pages must keep visible product content in English so both language versions share the same reviewable visual evidence.
