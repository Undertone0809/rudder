---
title: Desktop Startup Recovery
domain: control-plane
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - CONTROL.DESKTOP.STARTUP.RECOVERY.001
related_code:
  - desktop/src/boot-screen.ts
  - desktop/src/boot-preload.ts
  - desktop/src/desktop-startup-failure.ts
  - desktop/src/desktop-support-mail.ts
  - desktop/src/main.ts
related_tests:
  - desktop/src/boot-screen.test.ts
  - desktop/src/desktop-startup-failure.test.ts
  - desktop/src/desktop-support-mail.test.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-15-desktop-startup-loading-recovery.md
edit_policy: user_confirmed_only
---

# Desktop Startup Recovery

## CONTROL.DESKTOP.STARTUP.RECOVERY.001

## Contract Summary

Rudder Desktop keeps healthy managed-local startup quiet and reveals recovery
information only after startup fails. The failure surface lets the operator
retry, prepare an editable support email, or open the repository's public bug
report form while preserving operator control over everything that is sent or
published.

Support destinations, safe diagnostics, and operating-system handoffs are owned
by the Desktop main process. The startup renderer can request only fixed support
intents; it cannot choose a recipient, external URL, attachment, diagnostic
payload, or local path.

## Intent / User Job

An operator whose Desktop app cannot start must be able to understand the next
action, retry without opening another Rudder window, and prepare a useful report
without first locating internal logs or exposing private local data.

## Why / Design Reasoning

A healthy startup requires no decision, so stage names, runtime metadata, paths,
and recovery controls create noise without helping the operator. Once startup
fails, a generic error and support address do not give a maintainer enough
evidence to reproduce the failure.

The recovery surface therefore uses progressive disclosure. It shows actions
and a report checklist immediately, keeps technical values collapsed, and makes
the operator review an editable email or public GitHub form before submission.
Rudder contributes only a small allowlisted diagnostic summary and never
silently sends or uploads local material.

## Actors / Objects / State

- Actor: the local Desktop operator.
- Host: the Electron main process that owns startup state, support destinations,
  clipboard access, and operating-system handoff.
- Renderer: the isolated boot document and narrow boot preload.
- Startup state: `loading` or `failed`, with an attempt number and a safe failure
  view when failed.
- Support paths: an editable email draft to the fixed support recipient and the
  fixed repository bug-report template.
- Safe diagnostic: failure id, occurrence time, Rudder version,
  platform/architecture, startup stage/category, attempt, profile, and instance.

## Entry Points / Inputs

- Desktop creates the boot window for a managed local startup.
- Real startup stage changes may update internal and assistive state but do not
  add visible progress copy.
- Managed local startup rejects after the boot window and recovery IPC exist.
- The operator chooses `Try again`, `Email support`, `Report on GitHub`, a copy
  fallback, or an explicitly disclosed technical action.

## Product Logic Flow

1. During healthy startup, Desktop shows the Rudder mark and non-progress motion
   without visible stage text, runtime metadata, paths, support guidance, or
   actions.
2. When managed local startup rejects, the same window enters `failed`, stops
   presenting itself as busy, focuses the failure heading, and reveals recovery
   actions and reporting guidance.
3. `Try again` returns the same window to the quiet loading state and coalesces
   concurrent retry requests into one new startup attempt.
4. `Email support` asks the main process to open an editable draft addressed to
   `zeeland4work@gmail.com`. The draft includes bracketed prompts for summary,
   reproduction steps, actual and expected results, onset/change context, retry
   result, impact/workaround, evidence, and environment details, plus the safe
   diagnostic summary.
5. `Report on GitHub` asks the main process to open
   `https://github.com/Undertone0809/rudder/issues/new?template=bug_report.yml`.
   The UI states that the form is public and tells the operator to paste the
   copied diagnostic into `Environment details` when useful.
6. Email and GitHub handoffs are independently single-flight within their
   current failure context. If startup is retried, results from the earlier
   failure cannot overwrite the new state. Replaying the same failure state does
   not cancel a current handoff or leave its button disabled.
7. If the operating system rejects either handoff, the same surface offers the
   fixed support address or fixed issue URL as a copy fallback.
8. Technical details remain closed by default. When disclosed, they show safe
   failure fields and the local instance folder and permit copying a public-safe
   diagnostic or opening the instance folder.
9. Before either report path, the UI asks for a concise summary, smallest
   reproduction, actual versus expected behavior, onset and preceding change,
   retry result, impact/workaround, and reviewed screenshot or short log excerpt.
10. The UI warns the operator to remove secrets and private context. Rudder does
    not automatically send email, submit an issue, upload a file, or attach logs.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Healthy startup | Managed local startup has not failed | Only branded non-progress loading is visible | Visible stage copy, support controls, paths, profile, instance, or fake percentage appears | Boot markup test and real Electron visual check |
| Startup failure | Managed local startup rejects after the boot window exists | The same window reveals retry, email, GitHub, detailed reporting guidance, and collapsed technical details | A second window opens or raw technical detail becomes the visual default | Startup-recovery Electron smoke |
| Concurrent retry | Retry is clicked repeatedly while a restart is in flight | One new startup attempt runs and the existing window returns to loading | Duplicate local runtimes or duplicate windows start | Startup-recovery Electron smoke |
| Email report | Failed state is active and the operator chooses email | The OS receives one bounded editable `mailto:` draft with safe fields and human prompts | Rudder sends mail, adds cc/bcc/attachment parameters, or includes raw error/log/config contents | Support-mail tests and Electron smoke |
| GitHub report | Failed state is active and the operator chooses GitHub | The OS receives only the fixed repository bug-template URL | The renderer supplies an arbitrary URL or Rudder submits a public issue automatically | Narrow preload and Electron smoke |
| Handoff rejection | Mail or browser handoff rejects for the current failure | The failed action is re-enabled and a fixed address/link copy fallback appears | An old failure changes the new failure UI or repeated clicks create concurrent OS handoffs | Startup-recovery Electron smoke |
| Same-state replay | Desktop rebroadcasts the current failure, such as after window focus | Current handoff state remains valid and its button recovers when the handoff settles | An unchanged failure is treated as a new generation and strands a disabled action | Startup-recovery Electron smoke |
| Technical disclosure | The operator opens `Technical details` | Safe fields and explicit technical actions become visible | Raw secrets, config contents, environment contents, or database contents enter the renderer | Failure-view allowlist tests |

## Actor-Visible Input

The operator does not enter data inside the boot window. Email prompts and the
GitHub template remain editable in the external client. The visible checklist
asks the operator to provide:

- a short summary and affected workflow;
- the smallest numbered reproduction;
- actual and expected behavior;
- when the failure began and what changed beforehand;
- whether retry changed the result;
- impact, severity, and any workaround;
- an optional reviewed screenshot or only the relevant log lines;
- OS version and install/launch method when the destination does not already
  contain those details.

## Operator-Visible Output

- Healthy startup: one centered Rudder mark with no visible startup wording.
- Failed startup: a plain-language failure summary, three recovery actions,
  detailed report guidance, privacy warning, and collapsed technical details.
- Email success: confirmation that an editable draft was handed to the mail app.
- GitHub success: confirmation that GitHub opened plus a reminder to review the
  public issue before submitting.
- Handoff failure: a non-blocking status and a copy fallback for the fixed
  address or URL.

## Persisted Evidence

This workflow creates no Rudder business record and persists no diagnostic
bundle. The main process keeps the current failure record only in memory for
recovery and support construction. The original exception remains in the
main-process log and never enters the boot renderer, copied diagnostic, or
support draft.

Email and issue content remain in the external client only if the operator
chooses to keep or submit it. Automated evidence comes from pure failure/mail
tests and the isolated real Electron startup-recovery smoke.

## Canonical Scenarios

1. Useful email after a migration failure:
   - Trigger: managed startup rejects during the database stage.
   - Expected state/action: Desktop reveals recovery; the operator chooses
     email and completes the bracketed reproduction and impact prompts.
   - Visible output: the mail client shows an editable draft with safe technical
     fields already present and no automatic attachment.
   - Evidence: `desktop/src/desktop-support-mail.test.ts` and
     `desktop/scripts/smoke.mjs`.
2. Public GitHub report:
   - Trigger: the operator prefers a trackable public report.
   - Expected state/action: Desktop opens the fixed bug-report template; the
     operator reviews private data, optionally copies the safe diagnostic into
     Environment details, and submits manually.
   - Visible output: the repository bug form opens without renderer-supplied URL
     data or a copied local instance path.
   - Evidence: `desktop/scripts/smoke.mjs`.
3. No default mail client or browser handoff:
   - Trigger: the OS rejects the requested external handoff.
   - Expected state/action: Desktop keeps recovery usable and reveals a copy
     fallback for that fixed destination.
   - Visible output: the operator can paste the address or link into another
     client and can separately copy the safe diagnostic.
   - Evidence: `desktop/scripts/smoke.mjs`.

## Invariants / Non-Goals

- Healthy startup has no visible `Starting Rudder` wording or rotating technical
  phase copy.
- The boot preload exposes fixed intents, not generic external navigation,
  arbitrary clipboard writes, arbitrary path opening, or support payload input.
- The main process owns the support recipient, bug-report URL, diagnostics, and
  failure-scoped handoff single-flight state.
- Automatically drafted or copied support content excludes raw errors, stacks,
  logs, URLs, paths, config/env contents, databases, credentials, tokens,
  cookies, prompts, command output, and workspace contents unless the operator
  deliberately reviews and adds material outside Rudder. The local technical
  disclosure may show the instance folder for recovery, but `Copy diagnostic`
  does not include it.
- No email is sent, GitHub issue is submitted, file is uploaded, or attachment
  is added automatically.
- The email draft remains within the bounded `mailto:` length supported by this
  implementation.
- Retry and support handoffs are single-flight in the relevant state. Duplicate
  state broadcasts and older handoff completion cannot strand or overwrite the
  current recovery surface.
- Loading motion respects reduced-motion preferences. The long guidance is a
  labelled region; only the short failure summary is an alert.
- This contract covers managed local startup failure after the boot window and
  recovery IPC exist. It does not promise recovery for pre-window bootstrap,
  Electron process crashes, unresponsive renderers, React render errors, or a
  startup operation that never settles.
- Server resource cleanup and restartability remain governed by
  `CONTROL.SERVER.LIFECYCLE.001`.

## Drift Boundaries

Update this contract when the visible healthy/failure split, retry semantics,
support destinations, report fields, privacy boundary, diagnostic allowlist,
IPC trust boundary, external handoff behavior, or copy fallbacks change.

Internal CSS values, motion timing within the Desktop design guardrails, helper
names, and exact plain-language copy may change without a contract update when
the observable hierarchy and safety guarantees remain intact.

## Traceability

Related plan:

- `doc/plans/2026-07-15-desktop-startup-loading-recovery.md`

Related code:

- `desktop/src/boot-screen.ts`
- `desktop/src/boot-preload.ts`
- `desktop/src/desktop-startup-failure.ts`
- `desktop/src/desktop-support-mail.ts`
- `desktop/src/main.ts`

Related tests:

- `desktop/src/boot-screen.test.ts`
- `desktop/src/desktop-startup-failure.test.ts`
- `desktop/src/desktop-support-mail.test.ts`
- `desktop/scripts/smoke.mjs`

Known gaps:

- Reliable cross-client email attachments are unavailable through `mailto:`.
- A redacted diagnostic bundle, automatic issue prefill, pre-window recovery,
  and never-settling startup watchdog require separate product and security
  designs.
