# Plugin Authoring

Use this workflow for a Rudder Plugin source question or an explicit request to
scaffold, develop, or verify a Plugin. Reading authoring guidance is read-only.
Only an explicit user request to scaffold or modify a package authorizes writes,
and those writes must stay inside the requested repository or target directory.

The current fact sources are
`doc/engineering/PLUGIN_AUTHORING_GUIDE.md` and
`packages/plugins/sdk/README.md`. Use
`doc/engineering/PLUGIN_RUNTIME_CONTRACT.md` only to understand the implemented
runtime boundary, and label future ideas as non-current.

## Section Map

- [Confirm scope and package layout](#confirm-scope-and-package-layout)
- [Scaffold from the current package](#scaffold-from-the-current-package)
- [Implement within current boundaries](#implement-within-current-boundaries)
- [Wire a bundled example only when requested](#wire-a-bundled-example-only-when-requested)
- [Verify the package and host](#verify-the-package-and-host)

## Confirm Scope And Package Layout

Before writing, determine whether the Plugin is:

- a repository-local example under `packages/plugins/examples/`;
- another Rudder monorepo package under `packages/plugins/`; or
- an external npm package in an absolute target directory.

Repository-local examples are a development workflow. For deployable Plugins,
prefer an npm package installed from a public or private npm-compatible
registry. GitHub installs are not a first-class path today.

Treat both Plugin workers and Plugin UI as trusted code. Plugin UI runs as
same-origin JavaScript and is not sandboxed by manifest capabilities.
Worker-side host APIs are capability-gated. Keep these boundaries visible when
reviewing third-party code or selecting capabilities.

## Scaffold From The Current Package

Use `create-rudder-plugin` instead of hand-writing boilerplate. In a Rudder
checkout, first build the scaffold package, then run its generated CLI for the
requested npm package name and output root. `--output` names the parent
directory; the CLI appends the package basename, and that destination must not
already exist. Verify the exact commands in
the current authoring guide before execution.

For a repository-local package, the scaffold uses `workspace:*` for
`@rudderhq/plugin-sdk`. For an external package, pass `--sdk-path` pointing to
the checkout's `packages/plugins/sdk`; the scaffold snapshots the SDK/shared
packages into `.rudder-sdk/` so the Plugin can build and test before an npm
publication exists.

The generated package should include:

- `src/manifest.ts`;
- `src/worker.ts`;
- `src/ui/index.tsx` when UI is used;
- `tests/plugin.spec.ts`;
- `package.json` and current build configuration.

Scaffold only under the explicit output root and confirm the derived package
directory before execution. Do not install the generated Plugin into a running
Rudder instance unless the user also requested that host mutation.

## Implement Within Current Boundaries

Review the manifest, worker, UI, and tests together:

- Declare only capabilities used by the worker-side host APIs.
- Keep tool names Plugin-namespaced; they must not shadow core or other Plugin
  tools.
- Keep UI self-contained. Rudder does not provide a shared Plugin React
  component kit yet.
- Do not use `ctx.assets`; it is not supported in the current runtime.
- Use `routePath` only for a `page` slot. It must be one lowercase slug and may
  not collide with a reserved host route or another installed Plugin page.
- Use the SDK's declared worker, UI, testing, bundler, and dev-server surfaces
  rather than undocumented application internals.
- Treat jobs and webhooks as namespaced external execution surfaces and keep
  their capabilities, ownership, logs, and failure evidence explicit.

Local development installs must use an absolute filesystem path. The server
can watch a local-path Plugin and restart its worker after rebuilds, but that
does not make a repo-local checkout a production deployment artifact.

## Wire A Bundled Example Only When Requested

Only if the user explicitly asks for bundled example or discoverable host
wiring, update the host's bundled-example list and the documentation that
enumerates in-repo examples. A request to scaffold or develop a Plugin alone
does not authorize changing `server/src/routes/plugins.ts` or other host
registration surfaces.

If host runtime, SDK, capability validation, static UI serving, or lifecycle
code changes, follow the repository's Plugin engineering and Product Logic
rules in addition to the package workflow.

## Verify The Package And Host

At minimum, run the generated or existing Plugin package's:

- `typecheck`;
- `test`; and
- `build`.

Use the package scripts or the monorepo's `pnpm --filter <plugin-package>`
forms. For a new scaffold, execute them in a temporary or explicitly requested
target and confirm that its worker, manifest, UI bundle, and
`tests/plugin.spec.ts` compile against the selected SDK layout.

When host or SDK code changed, also run the relevant host integration tests,
repository typecheck, test suite, and build. If the user asked to install the
Plugin, verify the real host from its absolute local path and surface worker
health, logs, route behavior, and capability failures. Package creation alone
is not evidence that a Plugin is installed or active in Rudder.
