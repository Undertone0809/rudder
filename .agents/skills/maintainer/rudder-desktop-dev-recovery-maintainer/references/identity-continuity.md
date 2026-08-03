# Desktop Identity Continuity Reference

Use this reference only when a Desktop recovery request crosses the account,
device, local-session, or credential-storage boundary.

## State ledger

Capture a small non-secret ledger. Values may be statuses, timestamps, process
identities, local instance identifiers, and artifact/config hashes that are not
derived from credentials. URLs must be reduced to a sanitized origin/path with
userinfo, query, and fragment removed. External identifiers should be redacted
to a type plus a short suffix only when needed for correlation. Never record
raw callback or authorization URLs, device/user/account codes or identifiers,
credential/session-derived hashes, tokens, cookies, email addresses, or
passwords.

| Stage | Acceptable evidence | Not sufficient |
| --- | --- | --- |
| Target identity | checkout/app path, instance, profile, port | a nearby healthy server |
| API health | matching health payload and owner | HTTP 200 from another instance |
| Account authorization | signed-in account state or explicit account-required state | `local-board` compatibility session |
| Device approval | approved device event tied to this attempt | a device code merely being displayed |
| Server exchange | this attempt consumed exchange | old exchange event |
| Local claim | this installation's local claim completed | Identity service health |
| Renderer session | visible signed-in renderer state | Electron process exists |
| Main session | authenticated main-process request | anonymous `/api/orgs` 401 |
| Storage capability | compiled policy plus signing identity | `app.isPackaged` alone |
| Usable workspace | first requested workspace rendered and usable | login page or blank shell |
| Restart persistence | controlled restart and same-state observation | in-process success |

Do not skip an earlier stage that is applicable to the selected branch because
a later API happens to respond. An existing durable session does not require a
new device authorization; a fixture, OAuth, email, or dev-bypass flow may not
use every exchange/claim stage. When a device authorization is pending or
expired, report the missing approval and stop. Do not retry by reading or
exporting credentials. Never request, print, expose, or persist secrets. When
a transcript is available, inspect tool-call arguments and outputs for
secret-bearing values and treat any exposure as a safety failure.

## Dev versus real login

When the user only needs a local development workspace, the supported shortcut
may be `RUDDER_DESKTOP_AUTH_BYPASS=1 pnpm dev`. Label this as a dev auth bypass.
It proves neither production login nor the device-approval path.

When the user asks to verify real login, use the fixture/Identity flow intended
by the target environment. For a fresh account flow, require fresh approval,
exchange, and claim only when that flow uses them, plus a post-login window. A
browser session at the local API does not automatically authenticate the
Electron shell.

## Update/session boundary

For update blockers, check both:

1. runtime readiness: server handle, boot stage, health, and target instance;
2. account-session readiness: the Electron main process can make the protected
   request using its own session store.

Do not collapse a protected-request `401` into “runtime not ready”. Treat
cookie reuse, expired session, wrong Electron partition, cookie scope, claim
or readiness, and permission/organization binding as competing hypotheses.
Verify the main-process authenticated request and preserve the distinction in
the report even when the eventual fix is a single fetch injection or readiness
gate.

## macOS packaged storage

For a Keychain alert or persistence claim:

1. resolve the exact packaged candidate and rebuild it if the artifact is stale;
2. inspect `codesign -dvv` and the compiled storage policy from that artifact;
3. run repeated launches through the same packaged path;
4. observe the native dialog surface with System Events/Computer Use or state
   that the required observation authority is unavailable; without that
   authority, return `BLOCKED` for a native-dialog absence claim;
5. restart and record whether credentials/Offline Grant survive.

An ad-hoc/unsigned app may intentionally use memory-only storage. If so, the
absence of a Keychain alert is not a persistence success; report the tradeoff.
