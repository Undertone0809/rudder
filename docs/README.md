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

## Deployment

The docs site has two Vercel-backed channels:

- `staging.doc.rudder.zeeland.studio`: automatically updated from `main` by
  `.github/workflows/docs-staging.yml`.
- `doc.rudder.zeeland.studio`: manually published by
  `.github/workflows/docs-production.yml`.

Both workflows validate the Mintlify project, export the static site, deploy it
through the Vercel CLI, and then assign the channel domain. Production publishes
also create a `docs/vYYYY.MM.DD` git tag for the source commit.

## Content Scope

The docs tree provides English and Simplified Chinese navigation through Mintlify language entries in `docs.json`. Product screenshots and screenshot-style assets used by the pages must keep visible product content in English so both language versions share the same reviewable visual evidence.
