#!/usr/bin/env bash
set -euo pipefail

# Private staged entrypoint. Deployment wiring remains opt-in until Rust/Node
# parity and role-separated disposable-Postgres acceptance are complete.
: "${RUDDER_ANALYTICS_COLLECTOR_BIN:?RUDDER_ANALYTICS_COLLECTOR_BIN is required}"
exec "$RUDDER_ANALYTICS_COLLECTOR_BIN" "$@"
