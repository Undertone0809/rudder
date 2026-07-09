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

- `staging.docs.rudderhq.dev`: automatically updated from `main` by
  `.github/workflows/docs-staging.yml`.
- `docs.rudderhq.dev`: manually published by
  `.github/workflows/docs-production.yml`.

Both workflows validate the Mintlify project, export the static site, deploy it
through the Vercel CLI, assign the channel domain, and verify key public paths
such as `/about`, `/contact`, `/home`, `/robots.txt`, `/sitemap.xml`, `/zh`,
`/llms.txt`, and favicons.
Production publishes also bind the public Vercel project aliases to the same
deployment and create a `docs/vYYYY.MM.DD` git tag for the source commit.
Those aliases are intentionally production-facing public entry points; the
staging channel uses `staging.docs.rudderhq.dev` only. Staging pages are
still expected to emit production canonical URLs so preview traffic does not
compete with the canonical docs host in search indexes.

## Public Edge Protection

The production Vercel project can receive high-volume generic crawler probes for
paths that are not part of the docs information architecture, such as WordPress,
admin, login, git, or dotenv paths. Do not convert those probes into broad
homepage redirects: that hides the 404 symptom, can create soft-404 signals, and
still lets invalid traffic reach the deployment.

Use `.github/workflows/docs-vercel-firewall.yml` to apply the docs firewall rule
that denies obvious non-doc attack paths before they hit the static docs
surface. Reserve Mintlify redirects in `docs.json` for real old URLs or expected
public entry points that have a close semantic replacement, such as `/home` to
`/`.

## Content Scope

The docs tree provides English and Simplified Chinese navigation through Mintlify language entries in `docs.json`. Product screenshots and screenshot-style assets used by the pages must keep visible product content in English so both language versions share the same reviewable visual evidence.
