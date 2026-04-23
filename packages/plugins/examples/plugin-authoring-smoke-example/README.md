# Plugin Authoring Smoke Example

A Rudder plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into Rudder

```bash
pnpm rudder plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@rudder/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
