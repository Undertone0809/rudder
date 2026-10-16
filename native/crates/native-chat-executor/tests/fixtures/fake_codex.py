import json
import os
import pathlib
import signal
import sys
import time


home = pathlib.Path(os.environ["HOME"])
home.joinpath("provider-started").write_text("started", encoding="utf-8")
home.joinpath("provider-pid").write_text(str(os.getpid()), encoding="utf-8")
mode = home.joinpath("mode.txt").read_text(encoding="utf-8").strip()
log_path = home.joinpath("provider-events.jsonl")
thread_id = " 线程-native-thread== "
turn_id = " turn/δ-native-turn== "


def stopping(signum, frame):
    home.joinpath("provider-stopped").write_text("stopped", encoding="utf-8")
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stopping)


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def record(value):
    with log_path.open("a", encoding="utf-8") as log:
        log.write(json.dumps(value, ensure_ascii=False) + "\n")


def wait_for_thread_start_release():
    home.joinpath("thread-start-pending").write_text("pending", encoding="utf-8")
    release = home.joinpath("release-thread-start")
    deadline = time.monotonic() + 30
    while not release.exists():
        if time.monotonic() >= deadline:
            os._exit(24)
        time.sleep(0.02)


def terminal():
    return {
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": {
                "id": turn_id,
                "status": "interrupted" if mode == "interrupted" else "completed",
                "itemsView": "full",
                "items": [] if mode == "empty-answer" else [
                    {"id": "answer-1", "type": "agentMessage", "phase": "final_answer", "text": "synthetic answer"}
                ],
            },
        },
    }


def final_item():
    if mode == "empty-answer":
        return None
    return {
        "method": "item/completed",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {
                "id": "answer-1",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": "synthetic answer",
            },
        },
    }


def usage_update():
    return {
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "tokenUsage": {
                "last": {
                    "totalTokens": 12,
                    "inputTokens": 5,
                    "cachedInputTokens": 2,
                    "outputTokens": 7,
                    "reasoningOutputTokens": 3,
                }
            },
        },
    }


def config_read():
    profile_file = str(pathlib.Path(os.environ["CODEX_HOME"]) / "config.toml")
    features = {
        "plugins": False,
        "hooks": False,
        "apps": False,
        "browser_use": False,
        "computer_use": False,
        "image_generation": False,
        "multi_agent": False,
        "skill_search": False,
        "skill_mcp_dependency_install": False,
        "skip_host_skill_discovery": True,
    }
    user_config = {
        "approval_policy": "on-request",
        "sandbox_mode": "read-only",
        "web_search": "disabled",
        "features": features,
        "mcp_servers": {},
    }
    return {
        "config": {
            "approval_policy": "on-request",
            "sandbox_mode": "read-only",
            "web_search": "disabled",
        },
        "layers": [
            {
                "name": {"type": "user", "file": profile_file, "profile": None},
                "config": user_config,
                "disabledReason": None,
            },
            {"name": {"type": "sessionFlags"}, "config": {"features": {"plugins": False}}},
        ],
    }


for raw in sys.stdin:
    frame = json.loads(raw)
    record({"received": frame})
    if "method" not in frame:
        continue
    method = frame["method"]
    request_id = frame.get("id")
    if request_id is None:
        continue
    if method == "initialize":
        user_agent = "rudder-native-chat/0.163.0-alpha.10.2 (test)"
        if mode == "wrong-version":
            user_agent = "rudder-native-chat/0.163.0-alpha.11.0 (test)"
        emit({
            "id": request_id,
            "result": {
                "userAgent": user_agent,
                "codexHome": os.environ["CODEX_HOME"],
            },
        })
    elif method == "config/read":
        result = config_read()
        if mode == "project-layer":
            result["layers"].append({
                "name": {"type": "project", "file": "/fixture/project/.codex/config.toml"},
                "config": {"sandbox_mode": "danger-full-access"},
                "disabledReason": None,
            })
        emit({"id": request_id, "result": result})
    elif method == "thread/start":
        if mode in ("g6-lease-revoke", "g6-cancel-drop"):
            wait_for_thread_start_release()
        emit({"id": request_id, "result": {"thread": {"id": thread_id, "ephemeral": False}}})
    elif method == "thread/resume":
        resumed_thread_id = "foreign-thread-mismatch" if mode == "mismatched-resume" else thread_id
        emit({"id": request_id, "result": {"thread": {"id": resumed_thread_id, "ephemeral": False}}})
    elif method == "turn/start":
        record({"turnStart": frame})
        if mode == "approval":
            approval = {"id": "approval-request-1", "method": "item/commandExecution/requestApproval", "params": {}}
            record({"sent": approval})
            emit(approval)
            continue
        if mode == "exit":
            os._exit(23)
        if mode == "early-terminal":
            if final_item() is not None:
                emit(final_item())
            emit(usage_update())
            emit(terminal())
            emit({"id": request_id, "result": {"turn": {"id": turn_id}}})
        else:
            emit({"id": request_id, "result": {"turn": {"id": turn_id}}})
            if final_item() is not None:
                emit(final_item())
            emit(usage_update())
            emit(terminal())
