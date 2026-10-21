import json
import os
import pathlib
import select
import sys
import uuid

home = pathlib.Path(os.environ['HERMES_HOME'])
state = home / 'synthetic-session'
events = home / 'provider-events.jsonl'
session = None

def out(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def record(method, params):
    with events.open('a') as stream:
        stream.write(json.dumps({'method': method, 'sessionId': session, 'text': (params.get('prompt') or [{}])[0].get('text')}) + '\n')

def update(value):
    out({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session, 'update': value}})

def progress_prompt(prompt_id, text):
    tool_call_id = 'fixture-private-tool-call'
    update({'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': 'PUBLIC HERMES THOUGHT'}})
    update({
        'sessionUpdate': 'tool_call',
        'toolCallId': tool_call_id,
        'title': 'Inspect workspace snapshot',
        'rawInput': {'sentinel': 'PRIVATE_HERMES_TOOL_ARGUMENTS_MUST_NOT_PROJECT'},
    })
    update({
        'sessionUpdate': 'tool_call_update',
        'toolCallId': tool_call_id,
        'status': 'completed',
        'content': [{'type': 'content', 'content': {'type': 'text', 'text': 'PRIVATE_HERMES_TOOL_RESULT_MUST_NOT_PROJECT'}}],
        'rawOutput': {'sentinel': 'PRIVATE_HERMES_TOOL_RESULT_MUST_NOT_PROJECT'},
    })
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Native Hermes answer: '}})
    (home / 'output-pending').write_text('ready')

    while True:
        if (home / 'release-output').exists():
            (home / 'release-output').unlink()
            update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}})
            out({'jsonrpc': '2.0', 'id': prompt_id, 'result': {'stopReason': 'end_turn'}})
            return

        ready, _, _ = select.select([sys.stdin], [], [], 0.05)
        if not ready:
            continue
        incoming_line = sys.stdin.readline()
        if not incoming_line:
            return
        incoming = json.loads(incoming_line)
        if incoming.get('method') != 'session/cancel':
            out({'jsonrpc': '2.0', 'id': incoming.get('id'), 'error': {'code': -32601, 'message': 'unexpected request while prompt is held'}})
            continue
        record(incoming['method'], incoming.get('params', {}))
        update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'LATE_HERMES_PROGRESS_AFTER_STOP_MUST_NOT_APPEAR'}})
        out({'jsonrpc': '2.0', 'id': prompt_id, 'result': {'stopReason': 'cancelled'}})
        return

for line in sys.stdin:
    message = json.loads(line)
    method, params = message.get('method'), message.get('params', {})
    if method == 'initialized':
        continue
    if method == 'initialize':
        out({'jsonrpc': '2.0', 'id': message['id'], 'result': {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}})
    elif method == 'session/new':
        session = str(uuid.uuid4())
        state.write_text(session)
        record(method, params)
        out({'jsonrpc': '2.0', 'id': message['id'], 'result': {'sessionId': session}})
    elif method == 'session/load':
        session = params['sessionId']
        if not state.exists() or state.read_text() != session:
            out({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32000, 'message': 'missing session'}})
            continue
        record(method, params)
        out({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session, 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'REPLAY MUST NOT APPEAR AS NEW OUTPUT'}}}})
        out({'jsonrpc': '2.0', 'id': message['id'], 'result': {}})
    elif method == 'session/prompt':
        assert params['sessionId'] == session
        record(method, params)
        text = params['prompt'][0]['text']
        if text == 'Hold this response until I stop it.':
            (home / 'output-pending').write_text('ready')
            incoming = json.loads(sys.stdin.readline())
            assert incoming['method'] == 'session/cancel'
            record(incoming['method'], incoming.get('params', {}))
            out({'jsonrpc': '2.0', 'id': message['id'], 'result': {'stopReason': 'cancelled'}})
        elif text.startswith('Show live Hermes progress') or text.startswith('Stop after Hermes emits public progress'):
            progress_prompt(message['id'], text)
        else:
            update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Native Hermes answer: ' + text}})
            out({'jsonrpc': '2.0', 'id': message['id'], 'result': {'stopReason': 'end_turn'}})
