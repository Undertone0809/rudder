# HTTP POST fixture

Run the fixture from this directory with a log path and a port:

```sh
RUDDER_PLUGIN_HTTP_FIXTURE_PORT=4311 \
RUDDER_PLUGIN_HTTP_FIXTURE_LOG=/tmp/rudder-plugin-http-fixture.jsonl \
node http-post-fixture.mjs
```

It accepts `POST /plugin-http`, appends the request method, URL, selected
headers, and body to the JSONL log, and returns the received request as JSON.
The Rudder runtime must be started with
`RUDDER_PLUGIN_HTTP_ALLOWLIST=http://127.0.0.1:4311` when this local fixture is
used through the plugin host.
