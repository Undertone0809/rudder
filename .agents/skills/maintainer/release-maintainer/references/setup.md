# One-Time Release Setup

Use only for setup or setup diagnosis.

1. Confirm release, Desktop, dist-tag, docs, and CODEOWNERS workflows are on
   `main`.
2. List every public package with `scripts/release-package-map.mjs`.
3. For existing packages, configure npm trusted publishing with repository
   `Undertone0809/rudder` and workflow filename `release.yml`.
4. Bootstrap missing package names before attaching trusted publishing.
5. Configure:
   - `npm-canary`: selected branch `main`, no routine reviewer.
   - `npm-stable`: selected branch `main`, no interactive reviewer or wait
     timer; immutable source/CI/preflight are machine gates.
6. Use `NPM_TOKEN` only as an explicit temporary bootstrap fallback; remove it
   from steady state after trusted publishing is proven.
7. Verify GitHub workflow permissions, environment branch policy, npm package
   ownership, and a dry-run from `main`.

Setup does not itself authorize a real publish.
