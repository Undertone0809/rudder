# Release Maintainer References

Load `shared.md` plus the smallest applicable release branch:

- `stable.md`
- `canary.md`
- `rollback.md`
- `partial-recovery.md`
- `setup.md`

For a hands-on stable release, also load `announcement.md` as the final manual
closeout step after the release surfaces, cleanup, and next-version handoff have
converged. It is not a CI or webhook procedure.

Canonical policy and command details remain in:

- `doc/engineering/RELEASING.md`
- `doc/engineering/PUBLISHING.md`
- `doc/engineering/RELEASE-AUTOMATION-SETUP.md`

Update canonical docs first when policy changes, then update the routing or
branch reference that operationalizes the policy.
