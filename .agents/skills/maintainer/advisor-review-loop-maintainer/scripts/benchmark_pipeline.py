#!/usr/bin/env python3
"""Offline benchmark for the advisor review loop contract.

This benchmark is intentionally non-mutating: it reads the skill files and eval
prompts, then writes benchmark artifacts under the sibling workspace directory.
It does not start Rudder, touch user data, or call external services.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
from datetime import datetime, timezone
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
WORKSPACE = SKILL_DIR.parent / "advisor-review-loop-maintainer-workspace"
ITERATION = WORKSPACE / "iteration-pipeline-contract"


def find_repo_root() -> Path:
    current = SKILL_DIR
    for parent in [current, *current.parents]:
        if (parent / ".git").exists():
            return parent
    raise RuntimeError(f"Could not find repo root above {SKILL_DIR}")


REPO_ROOT = find_repo_root()
SKILL_REL = SKILL_DIR.relative_to(REPO_ROOT)


CHECKS = [
    {
        "name": "entrypoint_uses_writing_skills_template",
        "files": ["SKILL.md"],
        "patterns": [
            r"## Overview",
            r"## When to Use",
            r"## Core Pattern",
            r"## Quick Reference",
            r"## Implementation",
            r"## Common Mistakes",
        ],
    },
    {
        "name": "entrypoint_declares_advisor_review_loop_boundary",
        "files": ["SKILL.md"],
        "patterns": [
            r"decision-grade advisor-to-reviewer loop",
            r"does not replace implementation, black-box product verification,\s+or release execution skills",
            r"advisor artifact -> reviewer lens gate",
            r"functional trust, adversarial, and heuristic/product-systems",
        ],
    },
    {
        "name": "runbook_loads_source_skill_boundaries",
        "files": ["references/runbook.md"],
        "patterns": [
            r"`build-advisor`",
            r"`agent-work-reviewer-maintainer`",
            r"`product-acceptance-verifier-maintainer`",
            r"prove black-box acceptance\s+before final review",
        ],
    },
    {
        "name": "runbook_requires_three_lenses_for_consequential_work",
        "files": ["references/runbook.md"],
        "patterns": [
            r"Use three distinct reviewer lenses",
            r"functional trust",
            r"adversarial",
            r"heuristic/product-systems",
            r"wrong abstraction level",
            r"smallest\s+durable slice",
        ],
    },
    {
        "name": "runbook_allows_smallest_two_lens_set_with_reason",
        "files": ["references/runbook.md"],
        "patterns": [
            r"two reviewers are acceptable",
            r"Record\s+which lens was omitted and why",
            r"omitted reviewer lens and reason",
        ],
    },
    {
        "name": "runbook_requires_distinct_reviewer_packets",
        "files": ["references/runbook.md"],
        "patterns": [
            r"Functional trust reviewer",
            r"Adversarial reviewer",
            r"Heuristic/product-systems reviewer",
            r"target artifact basis",
            r"prior blockers",
            r"changed evidence",
            r"stage review or a\s+final handoff review",
        ],
    },
    {
        "name": "runbook_reuses_gate_when_no_delta",
        "files": ["references/runbook.md"],
        "patterns": [
            r"same blocker is\s+unchanged",
            r"no artifact or proof changed",
            r"reuse the prior gate state",
            r"route only the lens that can judge\s+that delta",
        ],
    },
    {
        "name": "runbook_blocks_duplicate_checklist_reviews",
        "files": ["references/runbook.md"],
        "patterns": [
            r"multiple reviewers run the same checklist",
            r"distinct functional,\s+adversarial, and heuristic pressure",
            r"reviewers are asked to rubber-stamp",
        ],
    },
    {
        "name": "evals_cover_three_lens_adversarial_heuristic_request",
        "files": ["evals/evals.json"],
        "patterns": [
            r"functional trust",
            r"adversarial",
            r"heuristic/product-systems",
            r"hidden assumptions",
            r"smallest durable slice",
            r"same checklist",
        ],
    },
    {
        "name": "evals_preserve_review_only_and_spawn_boundaries",
        "files": ["evals/evals.json"],
        "patterns": [
            r"review-only",
            r"does not edit or rewrite",
            r"spawned reviewer gates",
            r"serial fallback",
            r"does not claim the explicit reviewer-agent acceptance gate passed",
        ],
    },
]


def run_git(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def latest_contract_commit() -> str:
    candidate_files = []
    for relative in [
        "SKILL.md",
        "evals/evals.json",
        "references/runbook.md",
    ]:
        candidate_files.append(str(SKILL_REL / relative))

    result = run_git(["log", "-1", "--format=%H", "--", *candidate_files])
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"Could not resolve latest contract commit: {result.stderr.strip()}")
    return result.stdout.strip()


def default_baseline_ref() -> str:
    return f"{latest_contract_commit()}^"


def read_current_file(relative: str) -> tuple[str, str]:
    path = SKILL_DIR / relative
    if not path.exists():
        return "", f"missing current file: {relative}"
    return path.read_text(encoding="utf-8"), f"current file: {relative}"


def read_git_file(ref: str, relative: str) -> tuple[str, str]:
    object_name = f"{ref}:{SKILL_REL / relative}"
    result = run_git(["show", object_name])
    if result.returncode != 0:
        return "", f"missing in {ref}: {relative}"
    return result.stdout, f"{ref}:{relative}"


def evaluate_check(check: dict, config: dict) -> dict:
    parts = []
    sources = []
    for path in check["files"]:
        text, source = config["reader"](path)
        parts.append(text)
        sources.append(source)
    text = "\n".join(parts)
    expectation_results = []
    for pattern in check["patterns"]:
        passed = re.search(pattern, text, re.IGNORECASE | re.DOTALL) is not None
        source_text = "; ".join(sources)
        expectation_results.append(
            {
                "text": f"{check['name']} includes /{pattern}/",
                "passed": passed,
                "evidence": f"matched in {source_text}" if passed else f"pattern not found in {source_text}",
            }
        )
    passed_count = sum(1 for item in expectation_results if item["passed"])
    total = len(expectation_results)
    return {
        "expectations": expectation_results,
        "summary": {
            "passed": passed_count,
            "failed": total - passed_count,
            "total": total,
            "pass_rate": round(passed_count / total if total else 0.0, 4),
        },
        "execution_metrics": {
            "tool_calls": {},
            "total_tool_calls": 0,
            "total_steps": 1,
            "errors_encountered": 0,
            "output_chars": len(text),
            "transcript_chars": 0,
        },
        "timing": {"total_duration_seconds": 0.0},
    }


def stats(values: list[float]) -> dict:
    if not values:
        return {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0}
    return {
        "mean": round(sum(values) / len(values), 4),
        "stddev": round(statistics.stdev(values), 4) if len(values) > 1 else 0.0,
        "min": round(min(values), 4),
        "max": round(max(values), 4),
    }


def write_run(eval_dir: Path, config_name: str, result: dict, eval_name: str) -> dict:
    run_dir = eval_dir / config_name / "run-1"
    outputs_dir = run_dir / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "grading.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (run_dir / "timing.json").write_text(
        json.dumps({"total_tokens": 0, "duration_ms": 0, "total_duration_seconds": 0.0}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    summary_md = [
        f"# {eval_name}",
        "",
        f"Configuration: `{config_name}`",
        f"Pass rate: {result['summary']['pass_rate']:.2f}",
        "",
        "## Expectations",
    ]
    for expectation in result["expectations"]:
        marker = "PASS" if expectation["passed"] else "FAIL"
        summary_md.append(f"- {marker}: {expectation['text']} ({expectation['evidence']})")
    (outputs_dir / "summary.md").write_text("\n".join(summary_md) + "\n", encoding="utf-8")
    return {
        "configuration": config_name,
        "result": {
            "pass_rate": result["summary"]["pass_rate"],
            "passed": result["summary"]["passed"],
            "failed": result["summary"]["failed"],
            "total": result["summary"]["total"],
            "time_seconds": 0.0,
            "tokens": 0,
            "tool_calls": 0,
            "errors": 0,
        },
        "expectations": result["expectations"],
        "notes": [],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--baseline-ref",
        default=default_baseline_ref(),
        help="Git ref for previous skill version. Defaults to the parent of the latest commit touching this skill.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    baseline_ref = args.baseline_ref
    ITERATION.mkdir(parents=True, exist_ok=True)
    runs = []
    configs = [
        {"name": "current_skill", "reader": read_current_file},
        {"name": "previous_skill", "reader": lambda path: read_git_file(baseline_ref, path)},
    ]

    for idx, check in enumerate(CHECKS):
        eval_name = check["name"]
        eval_dir = ITERATION / f"eval-{idx}-{eval_name}"
        eval_dir.mkdir(parents=True, exist_ok=True)
        (eval_dir / "eval_metadata.json").write_text(
            json.dumps(
                {
                    "eval_id": idx,
                    "eval_name": eval_name,
                    "prompt": f"Check advisor review loop contract: {eval_name}",
                    "assertions": [
                        f"{eval_name} includes /{pattern}/" for pattern in check["patterns"]
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        for config in configs:
            result = evaluate_check(check, config)
            run = write_run(eval_dir, config["name"], result, eval_name)
            run.update({"eval_id": idx, "eval_name": eval_name, "run_number": 1})
            runs.append(run)

    pass_rates_by_config = {
        config["name"]: [run["result"]["pass_rate"] for run in runs if run["configuration"] == config["name"]]
        for config in configs
    }
    current_mean = stats(pass_rates_by_config["current_skill"])["mean"]
    previous_mean = stats(pass_rates_by_config["previous_skill"])["mean"]
    benchmark = {
        "metadata": {
            "skill_name": "advisor-review-loop-maintainer",
            "skill_path": str(SKILL_DIR),
            "executor_model": "offline-contract-check",
            "analyzer_model": "offline-contract-check",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "evals_run": [check["name"] for check in CHECKS],
            "runs_per_configuration": 1,
            "baseline_ref": baseline_ref,
            "comparison": "current_skill vs previous_skill",
        },
        "runs": runs,
        "run_summary": {
            "current_skill": {
                "pass_rate": stats(pass_rates_by_config["current_skill"]),
                "time_seconds": stats([0.0 for _ in pass_rates_by_config["current_skill"]]),
                "tokens": stats([0 for _ in pass_rates_by_config["current_skill"]]),
            },
            "previous_skill": {
                "pass_rate": stats(pass_rates_by_config["previous_skill"]),
                "time_seconds": stats([0.0 for _ in pass_rates_by_config["previous_skill"]]),
                "tokens": stats([0 for _ in pass_rates_by_config["previous_skill"]]),
            },
            "delta": {
                "pass_rate": f"{current_mean - previous_mean:+.2f}",
                "time_seconds": "+0.0",
                "tokens": "+0",
            },
        },
        "notes": [
            "Offline contract benchmark: reads only skill files and eval prompts.",
            f"Baseline is {baseline_ref}, the version before the latest contract commit touching this skill.",
            "No Rudder server, Desktop app, database, browser, or user data was touched.",
            "This checks whether the skill contains enforceable advisor/reviewer-loop instructions; it does not measure native routing telemetry.",
        ],
    }
    (ITERATION / "benchmark.json").write_text(json.dumps(benchmark, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Advisor Review Loop Contract Benchmark",
        "",
        f"Skill: `{SKILL_DIR.name}`",
        f"Current pass rate mean: {current_mean:.2f}",
        f"Previous pass rate mean: {previous_mean:.2f}",
        f"Delta: {current_mean - previous_mean:+.2f}",
        f"Baseline ref: `{baseline_ref}`",
        "",
        "This is an offline contract/static check. It does not measure native",
        "routing behavior, spawned-agent telemetry, or live Rudder product behavior.",
        "",
        "| Eval | Current | Previous | Delta |",
        "|---|---:|---:|---:|",
    ]
    for idx, check in enumerate(CHECKS):
        current = next(
            run for run in runs if run["eval_id"] == idx and run["configuration"] == "current_skill"
        )
        previous = next(
            run for run in runs if run["eval_id"] == idx and run["configuration"] == "previous_skill"
        )
        delta = current["result"]["pass_rate"] - previous["result"]["pass_rate"]
        lines.append(
            f"| {check['name']} | {current['result']['pass_rate']:.2f} "
            f"({current['result']['passed']}/{current['result']['total']}) | "
            f"{previous['result']['pass_rate']:.2f} "
            f"({previous['result']['passed']}/{previous['result']['total']}) | {delta:+.2f} |"
        )
    lines.extend(
        [
            "",
            "No local Rudder environment was mutated.",
            "No Rudder server, Desktop app, database, browser, or user data was touched.",
        ]
    )
    (ITERATION / "benchmark.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    failures = [
        run
        for run in runs
        if run["configuration"] == "current_skill" and run["result"]["passed"] != run["result"]["total"]
    ]
    print(f"Wrote {ITERATION}")
    print(f"current_pass_rate_mean={current_mean:.4f}")
    print(f"previous_pass_rate_mean={previous_mean:.4f}")
    print(f"delta={current_mean - previous_mean:+.4f}")
    if failures:
        print("failed_evals=" + ",".join(run["eval_name"] for run in failures))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
