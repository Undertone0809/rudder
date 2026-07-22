#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Supports two modes:
- `claude`: uses `claude -p` and detects whether the temporary skill/command was
  actually consulted.
- `codex`: approximates triggering by asking Codex to judge, using only the skill
  name, description, and user query.

The Codex path is an approximation because Codex's local skill mechanism is not
the same as Claude Code's command discovery. It is still useful for measuring
whether your description clearly communicates when the skill should be used.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import subprocess
import sys
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.model_backends import detect_backend, extract_first_json_object, generate_text
from scripts.utils import parse_skill_md


def find_project_root() -> Path:
    """Find the nearest plausible project root."""
    current = Path.cwd()
    markers = (".claude", ".git", ".codex", ".agents")
    for parent in [current, *current.parents]:
        if any((parent / marker).exists() for marker in markers):
            return parent
    return current


def run_single_query_claude(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
) -> bool:
    """Run a single query against Claude Code and detect real skill usage."""
    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    project_commands_dir = Path(project_root) / ".claude" / "commands"
    command_file = project_commands_dir / f"{clean_name}.md"

    try:
        project_commands_dir.mkdir(parents=True, exist_ok=True)
        indented_desc = "\n  ".join(skill_description.split("\n"))
        command_content = (
            f"---\n"
            f"description: |\n"
            f"  {indented_desc}\n"
            f"---\n\n"
            f"# {skill_name}\n\n"
            f"This skill handles: {skill_description}\n"
        )
        command_file.write_text(command_content)

        cmd = [
            "claude",
            "-p", query,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]
        if model:
            cmd.extend(["--model", model])

        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
            env=env,
        )

        triggered = False
        start_time = time.time()
        buffer = ""
        pending_tool_name = None
        accumulated_json = ""

        try:
            while time.time() - start_time < timeout:
                if process.poll() is not None:
                    remaining = process.stdout.read()
                    if remaining:
                        buffer += remaining.decode("utf-8", errors="replace")
                    break

                ready, _, _ = select.select([process.stdout], [], [], 1.0)
                if not ready:
                    continue

                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if event.get("type") == "stream_event":
                        stream_event = event.get("event", {})
                        stream_type = stream_event.get("type", "")

                        if stream_type == "content_block_start":
                            content_block = stream_event.get("content_block", {})
                            if content_block.get("type") == "tool_use":
                                tool_name = content_block.get("name", "")
                                if tool_name in ("Skill", "Read"):
                                    pending_tool_name = tool_name
                                    accumulated_json = ""
                                else:
                                    return False

                        elif stream_type == "content_block_delta" and pending_tool_name:
                            delta = stream_event.get("delta", {})
                            if delta.get("type") == "input_json_delta":
                                accumulated_json += delta.get("partial_json", "")
                                if clean_name in accumulated_json:
                                    return True

                        elif stream_type in ("content_block_stop", "message_stop"):
                            if pending_tool_name:
                                return clean_name in accumulated_json
                            if stream_type == "message_stop":
                                return False

                    elif event.get("type") == "assistant":
                        message = event.get("message", {})
                        for content_item in message.get("content", []):
                            if content_item.get("type") != "tool_use":
                                continue
                            tool_name = content_item.get("name", "")
                            tool_input = content_item.get("input", {})
                            if tool_name == "Skill" and clean_name in tool_input.get("skill", ""):
                                triggered = True
                            elif tool_name == "Read" and clean_name in tool_input.get("file_path", ""):
                                triggered = True
                            return triggered

                    elif event.get("type") == "result":
                        return triggered
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

        return triggered
    finally:
        if command_file.exists():
            command_file.unlink()


def run_single_query_judge(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    backend: str,
    model: str | None = None,
) -> bool:
    """Ask a model to judge whether the skill should trigger."""
    prompt = f"""You are evaluating skill routing.

Use only the skill name, the skill description, and the user query below.
Ignore hidden context, filesystem contents, tool availability, and implementation details.

Return strict JSON only:
{{"trigger": true, "reason": "one short sentence"}}

Mark "trigger": true only if this skill is clearly the best specialized workflow for the request.
Mark "trigger": false for simple requests, adjacent requests, or requests better handled by another workflow.

Skill name: {skill_name}
Skill description:
{skill_description}

User query:
{query}
"""
    output = generate_text(
        prompt,
        backend=backend,
        model=model,
        cwd=Path(project_root),
        timeout=timeout,
    )
    parsed = extract_first_json_object(output)
    return bool(parsed.get("trigger"))


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    backend: str = "auto",
) -> dict:
    """Run the full eval set and return results."""
    backend = detect_backend(backend)
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                if backend == "claude":
                    future = executor.submit(
                        run_single_query_claude,
                        item["query"],
                        skill_name,
                        description,
                        timeout,
                        str(project_root),
                        model,
                    )
                else:
                    future = executor.submit(
                        run_single_query_judge,
                        item["query"],
                        skill_name,
                        description,
                        timeout,
                        str(project_root),
                        backend,
                        model,
                    )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as exc:
                print(f"Warning: query failed: {exc}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        did_pass = trigger_rate >= trigger_threshold if should_trigger else trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for item in results if item["pass"])
    total = len(results)
    mode = "observed" if backend == "claude" else "judged"

    return {
        "skill_name": skill_name,
        "description": description,
        "backend": backend,
        "evaluation_mode": mode,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=60, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Optional backend model identifier")
    parser.add_argument("--backend", default="auto", choices=["auto", "claude", "codex"], help="Evaluation backend")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, _ = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating with backend={args.backend}: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
        backend=args.backend,
    )

    if args.verbose:
        summary = output["summary"]
        print(
            f"Results ({output['evaluation_mode']} via {output['backend']}): "
            f"{summary['passed']}/{summary['total']} passed",
            file=sys.stderr,
        )
        for item in output["results"]:
            status = "PASS" if item["pass"] else "FAIL"
            rate_str = f"{item['triggers']}/{item['runs']}"
            print(f"  [{status}] rate={rate_str} expected={item['should_trigger']}: {item['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
