import json
import os
import pathlib
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
        else:
            out({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session, 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Native Hermes answer: ' + text}}}})
            out({'jsonrpc': '2.0', 'id': message['id'], 'result': {'stopReason': 'end_turn'}})
