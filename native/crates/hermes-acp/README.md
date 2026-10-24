# Hermes ACP transport

Rust owns the process/session fences, bounded progress projection, tool-ID folding,
status, persistence and permission decisions. Public ACP text, diff and location
blocks are display data; private raw protocol payloads are not copied.

## Launch-only Python compatibility boundary

`src/acp_instruction_bootstrap.py` is embedded by Rust and executed with Python
isolated mode in the Rudder-owned Hermes child. It does not change installed
Hermes files, profiles, credentials or history. Besides the existing ephemeral
instruction bridge, it normalizes `function_args` with Hermes' own
`coerce_tool_args` before the ACP completion formatter runs.

Hermes 0.21's step callback otherwise forwards JSON-string arguments to a
read-file formatter expecting a dictionary. That raises before the notification
is sent, aborting the rest of a mixed tool batch. The wrapper changes only that
representation: original names, IDs, result bytes, status and ordering remain
upstream values. It neither infers output from assistant prose nor runs tools.
The Rust launcher fingerprints `acp_adapter/events.py` and `tools.py`, rechecks
its launch revision, and the shim verifies the formatter signature and callback
module binding. Unsupported layouts fail closed.

The persisted session identity retains the original six-source-file
`binding_revision`. The full launch `revision` also pins the two completion
formatters and is revalidated before spawning. Adding transport integrity checks
therefore preserves existing chats without weakening launch validation or
rotating their bindings.

Retire this coercion when the selected supported Hermes ACP version performs the
same normalization itself and the mixed-batch regression passes without it.
This is a protocol compatibility adapter, not a Python backend authority path.

## Verification

`cargo test -p rudder-hermes-acp` includes a Python-3 stdlib-only regression for
all five correlated completions, dict/None arguments and signature rejection.
Set `RUDDER_TEST_PYTHON` to select the test interpreter; otherwise the test uses
`python3` on Unix or `python` on Windows. Missing Python fails this test.

For an offline probe against a named trusted Hermes installation, run its
interpreter with `-I -B tests/bootstrap_tool_arguments.py
src/acp_instruction_bootstrap.py <Hermes source root>`. This imports only the ACP
callback/formatters and collects notifications without a model or profile. It
proves the installed callback emits 2/5 before coercion and 5/5 afterward, with
exact IDs, success/error statuses and public output. Actual provider behavior
still requires real installed-app acceptance.
