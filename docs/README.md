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

Generate and verify the private content map outputs:

```bash
pnpm docs:metadata:generate
pnpm docs:structure:test
pnpm docs:integrity
pnpm docs:alignment
```

`docs:alignment` is a warning-only reminder for bilingual and contract review.
It is not semantic validation.

Check the public docs surface after a deploy:

```bash
pnpm docs:health
```

Run the exported-site search workflow in Chromium:

```bash
pnpm test:docs-search
```

That suite also runs the manifest-complete static acceptance verifier. To run
the verifier against an already served export directly, use:

```bash
pnpm docs:static:verify -- http://127.0.0.1:4179
```

It requires every canonical route to return 200 with its canonical, hreflang,
and declared anchors. It also requires every generated active alias to return
one exact 301 or 308 redirect to a 200 destination.

The production site is deployed from Mintlify's offline export. The export
postprocessor generates `/rudder-search-index.json`, copies the self-contained
`/rudder-search.js` runtime, and injects it into every page so search does not
depend on a Mintlify-hosted deployment identifier. The public health check
requires both assets to be present after deployment.

By default this checks the canonical docs domain plus the public Vercel project
aliases. Use `DOCS_HEALTH_HOSTS=host.example.com pnpm docs:health` when you
need to check only one deployment channel.

## Deployment

The docs site has one production delivery workflow:

- `docs.rudderhq.dev` is published by the `Docs Release` workflow in
  `.github/workflows/docs-production.yml`, either manually from an immutable
  commit/tag or from the matching stable product tag inside `Release`.

`Test` owns docs structure, metadata, export, and search qualification. `Docs
Release` exports that exact qualified source, deploys it through the Vercel CLI,
binds the production domain and public aliases, verifies key public paths such
as `/contact`, `/home`, `/robots.txt`, `/sitemap.xml`, `/zh`, `/llms.txt`, and
favicons, and creates the immutable docs tag.

### Production authorization gate

Preparing or approving docs content does not authorize publishing it. Before a
production docs release, report the exact source ref and proposed tag, confirm
`pnpm docs:validate` and staging health, disclose known failing checks, and name
the rollback ref. Then stop and obtain explicit authorization to deploy
`docs.rudderhq.dev`.

Do not infer production authorization from `start`, `continue`, `proceed`, a
previously approved plan, permission to merge, or a staging approval. Automation
must not enter the production confirmation input until an operator explicitly
approves that exact release.

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
