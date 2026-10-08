# Run and live-run SideChat privacy correction

This patch protects the two Run aliases, events, workspace operations, overview,
active selection, live-run lists, reference admission and direct workspace logs.
The Rust visibility decision also provides a signed capability for later
WebSocket transport integration. That integration is not claimed complete here.

The same-organization SideChat owner is the authenticated human principal in the
verified actor envelope. Agent actors do not inherit a human owner's private
access. Domain payload selection and native authorization remain Rust-owned.
Node identity admission prevents private short-reference matches and protects
remaining file-log transport; it does not supply Run payloads to Rust.

Known chat-origin runs whose conversation is missing fail closed. This includes
legacy SideChat runs persisted with context.scene='chat', whose foreign key is
cleared when a conversation is deleted. It also hides legacy runs of deleted
ordinary Chats because those rows cannot reliably be distinguished. Historical
data is retained. Generic issue/manual runs without a chat-origin marker remain
visible under organization access. A later durable provenance migration can
restore ordinary-chat history only with reliable evidence of its origin.

Unbound workspace cleanup operations are hidden when the workspace is also
referenced by an inaccessible Run. Otherwise a visible Run sharing that workspace
could expose a private cleanup log. This is an intentional conservative change.

Separate outstanding surfaces include the full Run Intelligence/Reader API,
issue run history, private realtime delivery, and durable private provenance at
new NativeChat creation. These must be accepted with the NativeChat integration;
this bounded patch does not claim every private Run payload surface is closed.

## Verification

Run the public Run and live-run real-entry suites with an explicit immutable
`RUDDER_SERVER_FOUNDATION_PATH`. The privacy regression includes two real board
API keys in the same organization plus an agent key, direct signed Rust probes,
private/public short-ID collisions, hidden latest-run fallback, linked and
unbound workspace operations, and deletion of marked and legacy chat-origin
conversations. The suites verify database and filesystem preservation.
