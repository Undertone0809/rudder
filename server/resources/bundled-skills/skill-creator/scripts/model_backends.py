#!/usr/bin/env python3
"""Helpers for running host-specific model backends.

This skill can be used from several agent environments. Some environments expose
real skill triggering, others only expose a model CLI. This module centralizes
those differences so the higher-level workflow can stay mostly host-neutral.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def detect_backend(preferred: str | None = None) -> str:
    if preferred and preferred != "auto":
        return preferred
    if command_exists("claude"):
        return "claude"
    if command_exists("codex"):
        return "codex"
    raise RuntimeError("No supported backend found. Install `claude` or `codex`, or pass --backend explicitly.")


def _run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    timeout: int = 300,
    strip_claudecode: bool = False,
    retries: int = 0,
    retry_timeout_scale: float = 1.5,
) -> str:
    env = dict(os.environ)
    if strip_claudecode:
        env.pop("CLAUDECODE", None)

    attempt = 0
    current_timeout = timeout
    while True:
        try:
            completed = subprocess.run(
                cmd,
                cwd=str(cwd) if cwd else None,
                env=env,
                capture_output=True,
                text=True,
                timeout=current_timeout,
                check=True,
            )
            return completed.stdout.strip()
        except subprocess.TimeoutExpired:
            if attempt >= retries:
                raise
            attempt += 1
            current_timeout = max(current_timeout + 1, int(current_timeout * retry_timeout_scale))


def generate_text(
    prompt: str,
    *,
    backend: str,
    model: str | None = None,
    cwd: Path | None = None,
    timeout: int = 300,
) -> str:
    backend = detect_backend(backend)
    if backend == "claude":
        cmd = ["claude", "-p", prompt]
        if model:
            cmd.extend(["--model", model])
        return _run(cmd, cwd=cwd, timeout=timeout, strip_claudecode=True)

    if backend == "codex":
        cmd = ["codex", "exec", "-s", "read-only"]
        if model:
            cmd.extend(["-m", model])
        if cwd:
            cmd.extend(["-C", str(cwd)])
            if not any((parent / ".git").exists() for parent in [cwd, *cwd.parents]):
                cmd.append("--skip-git-repo-check")
        cmd.append(prompt)
        # Codex routing judgments can occasionally run close to the timeout.
        return _run(cmd, cwd=cwd, timeout=timeout, retries=1)

    raise RuntimeError(f"Unsupported backend: {backend}")


def extract_tagged_text(text: str, tag: str) -> str:
    match = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    if match:
        return match.group(1).strip().strip('"')
    return text.strip().strip('"')


def extract_first_json_object(text: str) -> dict:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(text[index:])
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    raise ValueError(f"No JSON object found in backend output: {text[:200]}")
