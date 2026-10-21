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
    answer = final_answer_item()
    return {
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": {
                "id": turn_id,
                "status": "interrupted" if mode in ("interrupted", "live-stop-cutoff") else "completed",
                "itemsView": "full",
                "items": [] if answer is None else [answer],
            },
        },
    }


def final_answer_item():
    if mode in ("empty-answer", "partial-empty-answer"):
        return None
    if mode == "output-flood":
        text = "x" * 4089 + "TAIL"
        item_id = "flood-answer"
    elif mode in ("stream-output", "live-stop-output-after-stop"):
        text = "same same answer"
        item_id = "streamed-answer"
    else:
        text = "synthetic answer"
        item_id = "answer-1"
    return {"id": item_id, "type": "agentMessage", "phase": "final_answer", "text": text}


def streamed_answer_item():
    if mode == "partial-empty-answer":
        return {
            "id": "partial-answer",
            "type": "agentMessage",
            "phase": "final_answer",
            "text": "same same answer",
        }
    return final_answer_item()


def final_item():
    answer = final_answer_item()
    if answer is None:
        return None
    return {
        "method": "item/completed",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "item": answer,
        },
    }


def streamed_output_events(include_item_snapshot=True):
    answer = streamed_answer_item()
    if answer is None:
        return []
    events = [
        {
            "method": "item/started",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "item": {key: answer[key] for key in ("id", "type", "phase")},
            },
        },
        *[
            {
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": answer["id"],
                    "delta": delta,
                },
            }
            for delta in ("same ", "same ", "answer")
        ],
    ]
    if include_item_snapshot:
        events.append(final_item())
    return events


def wait_for_output_release():
    home.joinpath("output-pending").write_text("pending", encoding="utf-8")
    release = home.joinpath("release-output")
    deadline = time.monotonic() + 30
    while not release.exists():
        if time.monotonic() >= deadline:
            os._exit(24)
        time.sleep(0.02)


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


def wait_for_flood_release(stage, batch):
    home.joinpath(f"output-flood-{stage}-pending-{batch}").write_text(
        "pending", encoding="utf-8"
    )
    release = home.joinpath(f"output-flood-{stage}-release-{batch}")
    deadline = time.monotonic() + 360
    while not release.exists():
        if time.monotonic() >= deadline:
            os._exit(24)
        time.sleep(0.005)


def output_flood_prelude_events():
    events = []
    for index in range(130):
        item = {"id": f"flood-tool-{index}", "type": "commandExecution"}
        events.extend(
            [
                usage_update(),
                {
                    "method": "item/started",
                    "params": {
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "item": item,
                    },
                },
                {
                    "method": "item/completed",
                    "params": {
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "item": {**item, "status": "completed"},
                    },
                },
            ]
        )
    return events


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
        if mode == "live-stop-config-pending":
            home.joinpath("config-read-pending").write_text("pending", encoding="utf-8")
            deadline = time.monotonic() + 30
            while not home.joinpath("release-config-read").exists():
                if time.monotonic() >= deadline:
                    os._exit(24)
                time.sleep(0.02)
        result = config_read()
        if mode == "project-layer":
            result["layers"].append({
                "name": {"type": "project", "file": "/fixture/project/.codex/config.toml"},
                "config": {"sandbox_mode": "danger-full-access"},
                "disabledReason": None,
            })
        emit({"id": request_id, "result": result})
    elif method == "thread/start":
        if mode in (
            "g6-lease-revoke", "g6-cancel-drop", "live-stop-late-thread",
            "live-stop-thread-unknown",
        ):
            wait_for_thread_start_release()
        emit({"id": request_id, "result": {"thread": {"id": thread_id, "ephemeral": False}}})
    elif method == "thread/resume":
        resumed_thread_id = "foreign-thread-mismatch" if mode == "mismatched-resume" else thread_id
        emit({"id": request_id, "result": {"thread": {"id": resumed_thread_id, "ephemeral": False}}})
    elif method == "turn/start":
        record({"turnStart": frame})
        if mode in ("live-stop-late-turn", "live-stop-input-unknown"):
            home.joinpath("turn-start-pending").write_text("pending", encoding="utf-8")
            deadline = time.monotonic() + 30
            while not home.joinpath("release-turn-start").exists():
                if time.monotonic() >= deadline:
                    os._exit(24)
                time.sleep(0.02)
        if mode == "live-stop-stale-terminal":
            stale = terminal()
            stale["params"]["turn"]["id"] = "previous-turn"
            emit(stale)
        if mode == "live-stop-cutoff":
            emit({"id": request_id, "result": {"turn": {"id": turn_id}}})
            answer = final_answer_item()
            emit({
                "method": "item/started",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {key: answer[key] for key in ("id", "type", "phase")},
                },
            })
            emit({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": answer["id"],
                    "delta": "prefix",
                },
            })
            wait_for_output_release()
            continue
        if mode.startswith("live-stop"):
            emit({"id": request_id, "result": {"turn": {"id": turn_id}}})
            continue
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
            if mode == "visible_checkpoint":
                # The browser can disconnect and reload after a durable prefix
                # without converting disconnect into Stop or another prompt.
                answer = final_answer_item()
                emit({
                    "method": "item/started",
                    "params": {
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "item": {key: answer[key] for key in ("id", "type", "phase")},
                    },
                })
                emit({
                    "method": "item/agentMessage/delta",
                    "params": {
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "itemId": answer["id"],
                        "delta": "synthetic ",
                    },
                })
                wait_for_output_release()
                emit(final_item())
            elif mode in ("stream-output", "partial-empty-answer"):
                for event in streamed_output_events(
                    include_item_snapshot=mode == "stream-output"
                ):
                    emit(event)
            elif mode in ("output-flood", "many-observations"):
                answer = final_answer_item()
                emit({
                    "method": "item/started",
                    "params": {
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "item": {key: answer[key] for key in ("id", "type", "phase")},
                    },
                })
                prelude = output_flood_prelude_events()
                # Keep the first notifications below the bounded early-turn
                # buffer while the turn/start response is being correlated.
                # The durable empty-delta marker lets the workflow release the
                # remaining large batches only after exact-turn capture begins.
                prelude_batch_sizes = (15, 64, 64, 64, 64, 64, 55)
                offset = 0
                for batch, batch_size in enumerate(prelude_batch_sizes):
                    for event in prelude[offset : offset + batch_size]:
                        emit(event)
                    offset += batch_size
                    # One empty final-answer delta gives the workflow test a
                    # durable receipt proving the preceding mixed notifications
                    # have drained before it releases another bounded batch.
                    emit({
                        "method": "item/agentMessage/delta",
                        "params": {
                            "threadId": thread_id,
                            "turnId": turn_id,
                            "itemId": answer["id"],
                            "delta": "",
                        },
                    })
                    wait_for_flood_release("many" if mode == "many-observations" else "prelude", batch)
                if offset != len(prelude):
                    os._exit(25)
                if mode == "many-observations":
                    home.joinpath("many-observations-counts.json").write_text(
                        json.dumps({"usage": 130, "toolStarted": 130, "toolCompleted": 130}),
                        encoding="utf-8",
                    )
                    if final_item() is not None:
                        emit(final_item())
                else:
                    home.joinpath("output-flood-prelude-counts.json").write_text(
                        json.dumps({"usage": 130, "toolStarted": 130, "toolCompleted": 130}),
                        encoding="utf-8",
                    )
                    output_count = 4089
                    for index in range(output_count):
                        emit({
                            "method": "item/agentMessage/delta",
                            "params": {
                                "threadId": thread_id,
                                "turnId": turn_id,
                                "itemId": answer["id"],
                                "delta": "x",
                            },
                        })
                        if (index + 1) % 64 == 0 or index + 1 == output_count:
                            wait_for_flood_release("output", index // 64)
                    # The 4097th receipt and subsequent terminal snapshot are a
                    # deliberate uncommitted tail. The workflow test never
                    # releases this gate; D1 must reject the tail before publish.
                    home.joinpath("output-flood-terminal-pending").write_text(
                        "pending", encoding="utf-8"
                    )
                    emit({
                        "method": "item/agentMessage/delta",
                        "params": {
                            "threadId": thread_id,
                            "turnId": turn_id,
                            "itemId": answer["id"],
                            "delta": "TAIL",
                        },
                    })
                    release_terminal = home.joinpath("output-flood-terminal-release")
                    deadline = time.monotonic() + 360
                    while not release_terminal.exists():
                        if time.monotonic() >= deadline:
                            os._exit(24)
                        time.sleep(0.005)
                    if final_item() is not None:
                        emit(final_item())
            elif final_item() is not None:
                emit(final_item())
            emit(usage_update())
            emit(terminal())

    elif method == "turn/interrupt":
        assert frame["params"]["threadId"] == thread_id
        assert frame["params"]["turnId"] == turn_id
        emit({"id": request_id, "result": {}})
        if mode == "live-stop-ack-only":
            continue
        if mode == "live-stop-output-after-stop":
            for event in streamed_output_events():
                emit(event)
        value = terminal()
        value["params"]["turn"]["status"] = "completed" if mode == "live-stop-completed" else "interrupted"
        emit(value)
