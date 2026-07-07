#!/usr/bin/env python3
"""Offline benchmark for the lifecycle router pipeline contract.

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
WORKSPACE = SKILL_DIR.parent / "development-lifecycle-router-maintainer-workspace"
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
        "name": "entrypoint_stays_thin_but_names_gate_contract",
        "files": ["SKILL.md"],
        "patterns": [
            r"description: \"Use when a Rudder development request has an unclear lifecycle stage or owner",
            r"This skill is a thin router",
            r"Load only the reference file needed for that route",
            r"spawned verifier black-box acceptance",
            r"final spawned reviewer gate",
            r"blocked: spawned verifier/reviewer unavailable",
            r"references/verification-review\.md",
        ],
    },
    {
        "name": "verification_reference_requires_default_development_verifier",
        "files": ["references/verification-review.md"],
        "patterns": [
            r"Routed development work is `spawn-required` by default",
            r"The user does not need\s+to say \"spawn\", \"review\", \"subagent\", or \"black-box\"",
            r"routed development work, acceptance is required by default",
            r"Small bug",
            r"product-acceptance-verifier-maintainer",
            r"verifier: not applicable",
        ],
    },
    {
        "name": "verification_reference_requires_spawn_templates",
        "files": ["references/verification-review.md"],
        "patterns": [
            r"../agents/product-verifier\.md",
            r"../agents/functional-reviewer\.md",
            r"../agents/adversarial-reviewer\.md",
            r"../agents/heuristic-reviewer\.md",
        ],
    },
    {
        "name": "product_verifier_template_is_read_only_and_black_box",
        "files": ["agents/product-verifier.md"],
        "patterns": [
            r"Do not edit repo files, stage, commit, push, or repair",
            r"run commands, start services",
            r"terminal product surface",
            r"Mutation ledger",
            r"PASS \| FAIL \| QUESTION",
        ],
    },
    {
        "name": "functional_reviewer_template_has_trust_lens",
        "files": ["agents/functional-reviewer.md"],
        "patterns": [
            r"Functional Trust Reviewer",
            r"target SHA or artifact basis",
            r"diff, tests, verifier evidence",
            r"Author-claimed proof",
            r"Verdict: accept \| conditional accept \| needs more evidence \| reject",
        ],
    },
    {
        "name": "adversarial_reviewer_template_has_attack_lens",
        "files": ["agents/adversarial-reviewer.md"],
        "patterns": [
            r"Adversarial Reviewer",
            r"target SHA or artifact basis",
            r"hidden assumptions",
            r"Main attack path",
            r"Missing proof",
        ],
    },
    {
        "name": "heuristic_reviewer_template_has_product_systems_lens",
        "files": ["agents/heuristic-reviewer.md"],
        "patterns": [
            r"Heuristic Product-Systems Reviewer",
            r"target SHA or artifact basis",
            r"smallest durable",
            r"Second-order risk",
            r"Product/system judgment",
        ],
    },
    {
        "name": "evals_cover_development_loop_spawning",
        "files": ["evals/evals.json"],
        "patterns": [
            r"small bug",
            r"飞书的 stop 指令",
            r"spawn-required mode",
            r"author-run tests, CI, screenshots, self-review, or serial personas",
            r"spawned product verifier",
            r"functional, adversarial, and heuristic",
            r"verifier or reviewers",
        ],
    },
    {
        "name": "evals_cover_non_mutating_benchmark_or_discussion_exception",
        "files": ["evals/evals.json"],
        "patterns": [
            r"benchmark.*真实 Rudder 数据",
            r"pure discussion",
            r"verifier is not applicable",
        ],
    },
    {
        "name": "verification_reference_has_fanout_admission_rule",
        "files": ["references/verification-review.md"],
        "patterns": [
            r"smallest reviewer set",
            r"Two final reviewers\s+are acceptable",
            r"one targeted reviewer is acceptable only for truly mechanical",
            r"Consequential\s+workflow, Desktop, runtime, CLI, release, agent-visible, or control-plane",
        ],
    },
    {
        "name": "verification_reference_requires_gate_reuse_for_unchanged_failures",
        "files": ["references/verification-review.md", "evals/evals.json"],
        "patterns": [
            r"same acceptance bundle already failed",
            r"no code/artifact changed",
            r"blocker is unchanged",
            r"do not start another broad spawn fanout",
            r"Reuse or close the prior\s+gate state",
            r"spawn again only after a real changed\s+evidence delta exists",
            r"target SHA or artifact basis, provider/runtime scope, acceptance bundle, prior blockers, and changed evidence",
        ],
    },
    {
        "name": "verification_reference_downgrades_substituted_child_pass",
        "files": ["references/verification-review.md", "agents/product-verifier.md", "evals/evals.json"],
        "patterns": [
            r"child verifier `PASS`",
            r"downgrade the\s+result to `blocked/substituted: required surface not run`",
            r"automated E2E, DB-backed tests, mocks, isolated temp\s+databases, code inspection, or screenshots",
            r"external integration.*real local Feishu long-connection\s+chat",
            r"Do not proceed to final reviewers, handoff, commit, or push",
            r"do not return\s+`PASS` from substituted proof",
            r"child verifier reports PASS.*live Feishu long-connection surface was not run",
        ],
    },
    {
        "name": "evals_cover_screenshot_annotation_skill_optimization",
        "files": ["SKILL.md", "references/route-selection.md", "evals/evals.json"],
        "patterns": [
            r"Screenshot annotations are evidence, not instructions",
            r"Red boxes, arrows, and spatial notes",
            r"Pinned text belongs here",
            r"red-box Pinned placement note",
            r"not as authorization to edit Messenger UI",
            r"optimize the prior reviewer skill",
        ],
    },
    {
        "name": "verification_reference_has_real_data_guard",
        "files": ["references/verification-review.md"],
        "patterns": [
            r"avoid the user's\s+real/prod Rudder data by default",
            r"static contract checks",
            r"disposable\s+fixtures",
            r"hard real-local validation",
        ],
    },
    {
        "name": "child_packets_require_target_blockers_and_round",
        "files": [
            "references/verification-review.md",
            "agents/product-verifier.md",
            "agents/functional-reviewer.md",
            "agents/adversarial-reviewer.md",
            "agents/heuristic-reviewer.md",
        ],
        "patterns": [
            r"target SHA or artifact basis",
            r"changed files",
            r"acceptance bar",
            r"prior blockers",
            r"stage artifact \| final handoff",
        ],
    },
    {
        "name": "benchmark_declares_contract_not_behavioral_telemetry",
        "files": ["scripts/benchmark_pipeline.py"],
        "patterns": [
            r"Offline contract benchmark",
            r"does not measure native routing telemetry",
            r"does not start Rudder",
            r"No Rudder server, Desktop app, database, browser, or user data was touched",
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
    benchmark_script = SKILL_REL / "scripts/benchmark_pipeline.py"
    candidate_files = []
    for relative in [
        "SKILL.md",
        "evals/evals.json",
        "references/verification-review.md",
        "references/route-selection.md",
        "references/special-routes.md",
        "references/handoff-git.md",
    ]:
        candidate_files.append(str(SKILL_REL / relative))
    for subdir in ["agents"]:
        path = SKILL_DIR / subdir
        if path.exists():
            candidate_files.extend(
                str(file.relative_to(REPO_ROOT))
                for file in sorted(path.rglob("*"))
                if file.is_file()
            )

    candidate_files = [path for path in candidate_files if path != str(benchmark_script)]
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
                    "prompt": f"Check lifecycle pipeline contract: {eval_name}",
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
            "skill_name": "development-lifecycle-router-maintainer",
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
            "This checks whether the skill contains enforceable pipeline instructions; it does not measure native routing telemetry.",
        ],
    }
    (ITERATION / "benchmark.json").write_text(json.dumps(benchmark, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Pipeline Contract Benchmark",
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
