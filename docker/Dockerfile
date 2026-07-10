FROM node:lts-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/agent-runtime-utils/package.json packages/agent-runtime-utils/
COPY packages/agent-runtimes/claude-local/package.json packages/agent-runtimes/claude-local/
COPY packages/agent-runtimes/codex-local/package.json packages/agent-runtimes/codex-local/
COPY packages/agent-runtimes/cursor-local/package.json packages/agent-runtimes/cursor-local/
COPY packages/agent-runtimes/gemini-local/package.json packages/agent-runtimes/gemini-local/
COPY packages/agent-runtimes/openclaw-gateway/package.json packages/agent-runtimes/openclaw-gateway/
COPY packages/agent-runtimes/opencode-local/package.json packages/agent-runtimes/opencode-local/
COPY packages/agent-runtimes/pi-local/package.json packages/agent-runtimes/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @rudderhq/ui build
RUN pnpm --filter @rudderhq/plugin-sdk build
RUN pnpm --filter @rudderhq/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
WORKDIR /app
ARG CLAUDE_CODE_VERSION=2.1.206
ARG CODEX_VERSION=0.144.1
ARG OPENCODE_VERSION=1.17.18
# Copy the runtime closure explicitly. In particular, do not promote the whole
# build context into the final image, where local configuration files could
# otherwise become readable by image consumers.
COPY --chown=node:node --from=build /app/package.json /app/package.json
COPY --chown=node:node --from=build /app/node_modules /app/node_modules
COPY --chown=node:node --from=build /app/server /app/server
COPY --chown=node:node --from=build /app/packages /app/packages
COPY --chown=node:node --from=build /app/cli /app/cli
COPY --chown=node:node --from=build /app/ui/dist /app/ui/dist
RUN npm install --global --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
  && mkdir -p /rudder \
  && chown node:node /rudder

ENV NODE_ENV=production \
  HOME=/rudder \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  RUDDER_HOME=/rudder \
  RUDDER_INSTANCE_ID=default \
  RUDDER_CONFIG=/rudder/instances/default/config.json \
  RUDDER_DEPLOYMENT_MODE=authenticated \
  RUDDER_DEPLOYMENT_EXPOSURE=private

VOLUME ["/rudder"]
EXPOSE 3100

USER node
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
