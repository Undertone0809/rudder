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

Configure Mintlify to use this repository with `docs/` as the docs root, then attach the production custom domain:

```text
doc.rudder.zeeland.studio
```

There is no existing Vercel or Mintlify project metadata in this repository. Domain setup requires access to the Mintlify workspace and DNS provider.

## Content Scope

The docs tree provides English and Simplified Chinese navigation through Mintlify language entries in `docs.json`. Product screenshots and screenshot-style assets used by the pages must keep visible product content in English so both language versions share the same reviewable visual evidence.
