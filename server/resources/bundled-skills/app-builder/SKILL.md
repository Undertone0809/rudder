---
name: app-builder
description: "Create and iteratively improve local web products from natural-language requests, then prepare them to run as Rudder Apps. Use Rudder's maintained scaffold for new websites and preserve the existing stack for Next.js, React, Vue, Astro, SvelteKit, Nuxt, and other local web projects."
---

# App Builder

Create or improve a useful local web product without making a non-technical
user choose a framework, database, package manager, or process topology.

A Rudder App is an ordinary local website presented as an App inside Rudder.
This Skill owns requirements, source changes, and product verification. Rudder
Desktop owns folder selection, launch-definition review, process lifecycle,
loopback attestation, and embedded opening.

## Build Workflow

1. Capture a compact brief in the conversation: user/job, primary workflow,
   essential screens, durable data, external integrations, constraints, and
   exclusions. Ask at most three grouped questions, and only when an answer
   materially changes behavior, real-data safety, or external authority.
2. Choose the source path:
   - For a new App, use the maintained scaffold in `assets/scaffold/`. Prefer
     the Apps workspace flow when it is available. Otherwise run
     `scripts/scaffold.mjs` with an explicit workspace root and target. Never
     recreate the foundation from memory or overwrite a non-empty directory.
   - For an existing web project, inspect its current framework, package
     manager, development script, data boundary, and tests before editing.
     Preserve its stack and conventions; never replace it with the maintained
     scaffold merely to make it a Rudder App.
3. Read [references/scaffold-contract.md](references/scaffold-contract.md)
   before changing the runtime, database foundation, manifest, health endpoint,
   import/export contract, or background-job runner.
4. Implement the user's domain model and workflows. Keep the generated project
   conventional and independently runnable.
5. Follow [references/data-safety.md](references/data-safety.md) whenever an app
   already has data, imports user data, changes its schema, or needs a real-data
   diagnosis.
6. Follow [references/design-guidelines.md](references/design-guidelines.md)
   for visible UI work. Prefer coherent workflow screens over a generic
   dashboard assembled from decorative cards.
7. Run migrations against development or snapshot data, then run typecheck,
   unit tests, build, and relevant app E2E tests.
8. Prepare the website for its Rudder Apps handoff:
   - A new managed App created from Apps Home keeps its typed manifest and
     returns to that App's **Register & preview** action. Do not load the same
     source again through the manual Local App path.
   - An independently authored existing project keeps a direct supported
     development script. Add the `package.json` `rudder` readiness or open-path
     fields only when discovery cannot infer them safely, then direct the
     operator to **Apps + > Add local web project** to select the folder and
     review the launch definition.
   The Agent writes and verifies source; Desktop alone owns runtime approval and
   process start. Do not invent a public URL, tunnel, cloud deployment, or
   unreviewed launch command.
9. Read [references/verification.md](references/verification.md), then verify
   the rendered app with Rudder Browser. Exercise the main workflow plus at
   least one production-shaped edge case and inspect console errors.
10. Materialize final screenshots and validation evidence in the originating
    Chat or Run. A localhost URL or tool-only screenshot is not durable output.

## Real Data Decision

- New app with no user data: use the scaffold's development database and
  synthetic fixtures.
- UI or ordinary logic change on an app with user data: verify against a
  temporary database snapshot by default.
- Diagnosis that genuinely depends on user records: ask whether to use the
  original database, a snapshot, or a redacted copy. State that relevant data
  may be sent to the configured model provider.
- Schema change: snapshot first and rehearse the migration on the snapshot.
  Applying it to user data is an application-specific action and requires
  explicit user intent.
- A direct operation on the formal database requires explicit user intent.

Never claim the Agent is sandboxed from files it can access. Use product
controls and least-data workflow choices; explain the boundary honestly.

## Runtime Boundary

- App source, data, builds, and execution stay on the user's device.
- The app may use outbound APIs only when requested and configured.
- Background tasks implemented by the App run only with that managed App
  process. V1 does not provide a separate Rudder job scheduler or catch-up UI.
- Never place secret values in source, `rudder.app.json`, tool arguments, Chat,
  screenshots, test fixtures, or logs. V1 does not provide a Rudder Secret
  binding UI, so ask the user how the App should obtain any required
  integration credential.
- Opening Chat, Apps, an App tab, or a saved view must not passively start an app.
- Cloud builds, hosted runtimes, public preview links, custom domains, managed
  cloud databases, and cross-device synchronization are outside this skill.

## Completion Gate

Do not call the app complete until:

- source and any required manifest or `package.json` Rudder configuration are durable;
- typecheck, unit tests, and build pass;
- the reviewed readiness path is ready on an attested loopback process;
- Browser verification covers the primary workflow and a relevant edge case;
- persistence behavior is verified against development or snapshot data;
- current screenshot evidence is attached to the work;
- user data was not modified without explicit intent; and
- stop/cleanup leaves no owned process behind.
