# Rollback

Rollback changes npm `latest` to an already published consistent version. It
does not unpublish packages, rewrite stable tags, or erase canary history.

## Procedure

1. Resolve the exact target version and verify it exists for every public
   package.
2. Verify the target GitHub Release and Desktop assets are complete enough for
   the user-facing install path.
3. Dry-run:

```bash
./scripts/rollback-latest.sh X.Y.Z --dry-run
```

4. Under explicit rollback authority, execute:

```bash
./scripts/rollback-latest.sh X.Y.Z
```

5. Verify `latest` across the complete package map, direct GitHub Release
   assets, and an isolated user-facing install.
6. Report the previous version, rollback target, unchanged tags/Releases, and
   the required fix-forward version.

If local npm authentication is unavailable, use the repository dist-tag
workflow rather than pretending the local shell can repair state.

## Boundaries

- Do not roll back by npm unpublish.
- Do not retarget a stable tag.
- Do not move only `@rudderhq/cli` while leaving dependent packages inconsistent.
- Do not call rollback successful until the public install path resolves the
  intended version.
