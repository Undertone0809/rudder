"""Regression for Hermes' JSON-string args aborting a mixed completion batch.

Uses only stdlib and a formatter-shaped fixture. Real installed Hermes/ACP is
covered separately by terminal local acceptance; no profile/model is imported.
"""
import json
import runpy
import sys
from types import SimpleNamespace

install = runpy.run_path(sys.argv[1], run_name="transport_test")["_install_tool_argument_compat"]
seen = []


def coerce(value):
    if isinstance(value, str):
        value = json.loads(value)
    return value if isinstance(value, dict) else {}


def complete(tool_call_id, tool_name, result=None, function_args=None, snapshot=None):
    # Actual upstream failure: read_file invokes args.get, unlike the first two
    # formatters. One exception aborts the entire upstream step callback loop.
    if tool_name == "read_file":
        function_args.get("path")
    record = (tool_call_id, tool_name, result, function_args, snapshot)
    seen.append(record)
    return record


try:
    complete("read-regression", "read_file", "public", '{"path":"/tmp/file"}')
    raise AssertionError("fixture must reproduce the upstream formatter failure")
except AttributeError:
    pass
assert not seen

events = SimpleNamespace(build_tool_complete=complete)
install(events, coerce)
batch = [
    ("terminal-1", "terminal", "terminal public output", {"command":"printf marker"}),
    ("python-1", "execute_code", "python public output", {"code":"print(42)"}),
    ("read-1", "read_file", "read public success", {"path":"/tmp/file"}),
    ("read-2", "read_file", "read public failure", {"path":"/tmp/missing"}),
    ("search-1", "web_search", "search public results", {"query":"public query"}),
]
for call_id, name, result, args in batch:
    snapshot = object()
    record = events.build_tool_complete(call_id, name, result, json.dumps(args), snapshot)
    assert record == (call_id, name, result, args, snapshot)
assert len(seen) == 5
assert [row[0] for row in seen] == [row[0] for row in batch]
assert events.build_tool_complete("dict", "read_file", "result", {"path":"/tmp/dict"})[3] == {"path":"/tmp/dict"}
assert events.build_tool_complete("none", "terminal")[3] is None
try:
    install(SimpleNamespace(build_tool_complete=lambda incompatible: None), coerce)
    raise AssertionError("unexpected formatter signature must fail closed")
except SystemExit as error:
    assert error.code == 78
print("5 correlated completions preserved")

# Optional offline installed-source probe: exercise Hermes' real callback and
# curated formatters, with only its outgoing notifier replaced by a collector.
if len(sys.argv) > 2:
    from collections import deque
    sys.path.insert(0, sys.argv[2])
    from acp_adapter import events as real_events
    from acp_adapter.tools import coerce_tool_args

    sent = []
    real_events._send_update = lambda conn, session_id, loop, update: sent.append(update)
    rows = [
        ("tc-terminal", "terminal", {"output":"PUBLIC TERMINAL", "exit_code":0}, {"command":"printf public"}),
        ("tc-python", "execute_code", {"output":"PUBLIC PYTHON", "exit_code":0}, {"code":"print('public')"}),
        ("tc-read", "read_file", {"content":"PUBLIC READ", "total_lines":1}, {"path":"/tmp/public"}),
        ("tc-missing", "read_file", {"error":"PUBLIC MISSING"}, {"path":"/tmp/missing"}),
        ("tc-search", "web_search", {"results":[{"title":"PUBLIC SEARCH","url":"https://example.com","description":"public"}]}, {"query":"public query"}),
    ]
    def callback_batch():
        queues, meta = {}, {}
        for call_id, name, result, args in rows:
            queues.setdefault(name, deque()).append(call_id)
            meta[call_id] = {"args":args}
        callback = real_events.make_step_cb(None, "public-session", None, queues, meta)
        previous = [{"name":name,"result":json.dumps(result),"arguments":json.dumps(args)} for _, name, result, args in rows]
        return callback, previous

    callback, previous = callback_batch()
    try:
        callback(1, previous)
        raise AssertionError("installed callback must reproduce missing completions before compatibility repair")
    except AttributeError:
        pass
    assert len(sent) == 2
    sent.clear()
    install(real_events, coerce_tool_args)
    callback, previous = callback_batch()
    callback(1, previous)
    assert [update.tool_call_id for update in sent] == [row[0] for row in rows]
    assert [update.status for update in sent] == ["completed", "completed", "completed", "failed", "completed"]
    serialized = json.dumps([update.model_dump() for update in sent])
    for marker in ["PUBLIC TERMINAL", "PUBLIC PYTHON", "PUBLIC READ", "PUBLIC MISSING", "PUBLIC SEARCH"]:
        assert marker in serialized, marker
    print("installed Hermes callback: 2/5 before, 5/5 after; exact IDs and public results preserved")
