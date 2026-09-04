# Stable Discord Announcement

Treat the Rudder Discord post as the final manual closeout surface for a stable
release. It does not belong in Release CI. Canary releases do not get a Discord
announcement.

## Destination

Use the existing authenticated maintainer browser session and verify all three
identifiers before drafting:

- server: `Rudder`
- channel: `#announcements`
- channel URL:
  `https://discord.com/channels/1529148109748306051/1529151730200350953`

Stop at a login wall and ask the user to take over. Never guess credentials,
create a webhook, or switch to a similarly named server or channel.

## Entry Gate

Announce only after the exact stable version has converged and been verified:

- npm `latest` resolves across the full public package map;
- the stable tag and non-draft, non-prerelease GitHub Release point to the locked
  source;
- the complete Desktop asset family and checksum marker are present;
- production English and Chinese changelogs resolve;
- public installation passes on the required platforms;
- obsolete same-line canary cleanup is verified;
- the next-version `main` handoff and its CI are verified.

If any required surface is missing, report `PARTIAL` and defer the announcement.
Do not use confident copy to hide an incomplete release.

## Duplicate Gate

Before writing, inspect or search `#announcements` for the exact `vX.Y.Z` token.

- No matching post: continue.
- One matching post with the canonical GitHub Release URL: read it back, adopt
  its direct message URL, and do not post again.
- A conflicting or ambiguous match: stop and report the conflict. Do not edit,
  delete, or replace an existing public message without explicit authority.

## Draft

Use the locked `releases/vX.Y.Z.md` and public GitHub Release body as factual
sources. Write plain international English and run a humanizing pass before
sending.

Use this shape:

```text
**[Rudder vX.Y.Z is out](GITHUB_RELEASE_URL)**

<one sentence describing what is better for users>

- <two or three concrete user-visible highlights>

Install or update:
`npx @rudderhq/cli@latest start`

[Read the full release notes](GITHUB_RELEASE_URL) · [Docs](https://docs.rudderhq.dev/releases)
```

Draft rules:

- target 70–110 words, but do not pad a small release;
- lead with user capability, reliability, or recovery rather than implementation;
- select at most three highlights instead of copying every changelog item;
- put `Action required` before the highlights only when users must migrate or
  change configuration;
- omit CI, source locking, workflow inputs, packaging mechanics, approvals,
  cleanup, and other maintainer plumbing;
- avoid hype, decorative emoji, and “we are excited to announce”;
- do not mention `@everyone`, `@here`, users, or roles.

## Send And Verify

1. Put the complete draft in the `#announcements` composer.
2. Read the composer back before sending. Confirm the version, release URL, docs
   URL, install command, and absence of mentions.
3. Send once.
4. Confirm the composer clears and a new message from the expected maintainer
   appears in `#announcements`.
5. Read the rendered message back. Confirm its version, summary, highlights,
   command, and both links match the approved draft.
6. Record the direct message URL in the release handoff. Its shape is
   `https://discord.com/channels/<server-id>/<channel-id>/<message-id>`.

A successful click or empty composer is not enough; the rendered channel
readback is the delivery receipt.

Discord announcement channels may offer a separate `Publish` control that
cross-posts to follower servers. Do not click it under ordinary release
authority. Cross-post only when the user explicitly requests that wider
distribution or approves it as standing release policy.

## Failure And Recovery

- Any send attempt without verified rendered readback becomes
  `delivery unknown`, even when the draft remains in the composer. Preserve the
  draft and do not send again yet; the UI may be stale after a committed send.
- Refresh or reopen the channel and search for the exact version plus canonical
  GitHub Release URL. Adopt a matching message and its direct URL. Retry once
  only after the destination has loaded and the message is confirmed absent.
- If the destination cannot be reconciled, stop without another mutation and
  report `PARTIAL` with `Announcement: delivery unknown`.
- If the message exists but its rendered content or destination is wrong, stop
  and ask before editing or deleting it.
- If Discord is unavailable or authentication cannot be restored before any
  send attempt, leave all published release artifacts unchanged and report
  `PARTIAL` with `Announcement: missing`. After a send attempt, use
  `delivery unknown` instead.

## Completion Evidence

Record all of the following before returning `RELEASED`:

```text
Announcement:
- server/channel: Rudder / #announcements
- version: vX.Y.Z
- author: <maintainer identity>
- message URL: https://discord.com/channels/<server>/<channel>/<message>
- ping: none | explicitly approved role
- follower cross-post: no | explicitly approved and verified
- readback: verified
```
