#!/usr/bin/env python3
"""Offline benchmark for the lifecycle router pipeline contract.

This benchmark is intentionally non-mutating: it reads the skill files and eval
prompts, then writes benchmark artifacts under the sibling workspace directory.
It does not start Rudder, touch user data, or call external services.
"""

from __future__ import annotations

import json
import re
import statistics
from datetime import datetime, timezone
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
WORKSPACE = SKILL_DIR.parent / "development-lifecycle-router-maintainer-workspace"
ITERATION = WORKSPACE / "iteration-pipeline-contract"


CHECKS = [
    {
        "name": "entrypoint_names_full_development_loop",
        "files": ["SKILL.md"],
        "patterns": [
            r"implementation, writer checks, verifier, final reviewers, reconciliation, and\s+handoff",
            r"spawned verifier",
            r"spawned final reviewer",
        ],
    },
    {
        "name": "verification_reference_requires_default_development_verifier",
        "files": ["references/verification-review.md"],
        "patterns": [
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


def read_file(relative: str) -> str:
    return (SKILL_DIR / relative).read_text(encoding="utf-8")


def evaluate_check(check: dict) -> dict:
    text = "\n".join(read_file(path) for path in check["files"])
    expectation_results = []
    for pattern in check["patterns"]:
        passed = re.search(pattern, text, re.IGNORECASE | re.DOTALL) is not None
        expectation_results.append(
            {
                "text": f"{check['name']} includes /{pattern}/",
                "passed": passed,
                "evidence": "matched" if passed else "pattern not found",
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


def main() -> int:
    ITERATION.mkdir(parents=True, exist_ok=True)
    runs = []

    for idx, check in enumerate(CHECKS):
        eval_name = check["name"]
        eval_dir = ITERATION / f"eval-{idx}-{eval_name}"
        run_dir = eval_dir / "with_skill" / "run-1"
        outputs_dir = run_dir / "outputs"
        outputs_dir.mkdir(parents=True, exist_ok=True)

        result = evaluate_check(check)
        (eval_dir / "eval_metadata.json").write_text(
            json.dumps(
                {
                    "eval_id": idx,
                    "eval_name": eval_name,
                    "prompt": f"Check lifecycle pipeline contract: {eval_name}",
                    "assertions": [item["text"] for item in result["expectations"]],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (run_dir / "grading.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        (run_dir / "timing.json").write_text(
            json.dumps({"total_tokens": 0, "duration_ms": 0, "total_duration_seconds": 0.0}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        summary_md = [
            f"# {eval_name}",
            "",
            f"Pass rate: {result['summary']['pass_rate']:.2f}",
            "",
            "## Expectations",
        ]
        for expectation in result["expectations"]:
            marker = "PASS" if expectation["passed"] else "FAIL"
            summary_md.append(f"- {marker}: {expectation['text']} ({expectation['evidence']})")
        (outputs_dir / "summary.md").write_text("\n".join(summary_md) + "\n", encoding="utf-8")

        runs.append(
            {
                "eval_id": idx,
                "eval_name": eval_name,
                "configuration": "with_skill",
                "run_number": 1,
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
        )

    pass_rates = [run["result"]["pass_rate"] for run in runs]
    benchmark = {
        "metadata": {
            "skill_name": "development-lifecycle-router-maintainer",
            "skill_path": str(SKILL_DIR),
            "executor_model": "offline-contract-check",
            "analyzer_model": "offline-contract-check",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "evals_run": [run["eval_name"] for run in runs],
            "runs_per_configuration": 1,
        },
        "runs": runs,
        "run_summary": {
            "with_skill": {
                "pass_rate": stats(pass_rates),
                "time_seconds": stats([0.0 for _ in runs]),
                "tokens": stats([0 for _ in runs]),
            },
            "delta": {
                "pass_rate": "+0.00",
                "time_seconds": "+0.0",
                "tokens": "+0",
            },
        },
        "notes": [
            "Offline contract benchmark: reads only skill files and eval prompts.",
            "No Rudder server, Desktop app, database, browser, or user data was touched.",
            "This checks whether the skill contains enforceable pipeline instructions; it does not measure native routing telemetry.",
        ],
    }
    (ITERATION / "benchmark.json").write_text(json.dumps(benchmark, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Pipeline Contract Benchmark",
        "",
        f"Skill: `{SKILL_DIR.name}`",
        f"Pass rate mean: {benchmark['run_summary']['with_skill']['pass_rate']['mean']:.2f}",
        "",
        "This is an offline contract/static check. It does not measure native",
        "routing behavior, spawned-agent telemetry, or live Rudder product behavior.",
        "",
        "| Eval | Pass rate | Result |",
        "|---|---:|---|",
    ]
    for run in runs:
        passed = run["result"]["passed"]
        total = run["result"]["total"]
        status = "PASS" if passed == total else "FAIL"
        lines.append(f"| {run['eval_name']} | {run['result']['pass_rate']:.2f} | {status} ({passed}/{total}) |")
    lines.extend(
        [
            "",
            "No local Rudder environment was mutated.",
            "No Rudder server, Desktop app, database, browser, or user data was touched.",
        ]
    )
    (ITERATION / "benchmark.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    failures = [run for run in runs if run["result"]["passed"] != run["result"]["total"]]
    print(f"Wrote {ITERATION}")
    print(f"pass_rate_mean={benchmark['run_summary']['with_skill']['pass_rate']['mean']:.4f}")
    if failures:
        print("failed_evals=" + ",".join(run["eval_name"] for run in failures))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
