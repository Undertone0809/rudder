#!/usr/bin/env python3
"""Improve a skill description based on eval results."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.model_backends import detect_backend, extract_tagged_text, generate_text
from scripts.utils import parse_skill_md


def improve_description(
    *,
    backend: str,
    skill_name: str,
    skill_content: str,
    current_description: str,
    eval_results: dict,
    history: list[dict],
    model: str | None = None,
    test_results: dict | None = None,
    log_dir: Path | None = None,
    iteration: int | None = None,
) -> str:
    """Call the selected backend to improve the description."""
    backend = detect_backend(backend)
    failed_triggers = [
        item for item in eval_results["results"]
        if item["should_trigger"] and not item["pass"]
    ]
    false_triggers = [
        item for item in eval_results["results"]
        if not item["should_trigger"] and not item["pass"]
    ]

    train_score = f"{eval_results['summary']['passed']}/{eval_results['summary']['total']}"
    if test_results:
        test_score = f"{test_results['summary']['passed']}/{test_results['summary']['total']}"
        scores_summary = f"Train: {train_score}, Test: {test_score}"
    else:
        scores_summary = f"Train: {train_score}"

    prompt = f"""You are optimizing a reusable AI skill description.

The skill system uses progressive disclosure:
- The model first sees only the skill name and description.
- If it chooses the skill, it reads the full SKILL.md and bundled resources.

Your job is to improve only the description so that the skill triggers for the right requests and stays quiet for adjacent or simpler ones.

Skill name: {skill_name}

Current description:
<current_description>
{current_description}
</current_description>

Current scores: {scores_summary}
"""
    if failed_triggers:
        prompt += "FAILED TO TRIGGER:\n"
        for item in failed_triggers:
            prompt += f'  - "{item["query"]}" (triggered {item["triggers"]}/{item["runs"]} times)\n'
        prompt += "\n"

    if false_triggers:
        prompt += "FALSE TRIGGERS:\n"
        for item in false_triggers:
            prompt += f'  - "{item["query"]}" (triggered {item["triggers"]}/{item["runs"]} times)\n'
        prompt += "\n"

    if history:
        prompt += "PREVIOUS ATTEMPTS. Avoid repeating the same structure:\n\n"
        for attempt in history:
            train_s = f"{attempt.get('train_passed', attempt.get('passed', 0))}/{attempt.get('train_total', attempt.get('total', 0))}"
            test_s = f"{attempt.get('test_passed', '?')}/{attempt.get('test_total', '?')}" if attempt.get('test_passed') is not None else None
            score_str = f"train={train_s}" + (f", test={test_s}" if test_s else "")
            prompt += f"<attempt {score_str}>\n"
            prompt += f'Description: "{attempt["description"]}"\n'
            if "results" in attempt:
                for result in attempt["results"]:
                    status = "PASS" if result["pass"] else "FAIL"
                    prompt += f'  [{status}] "{result["query"][:80]}" (triggered {result["triggers"]}/{result["runs"]})\n'
            prompt += "</attempt>\n\n"

    prompt += f"""Skill content for context:
<skill_content>
{skill_content}
</skill_content>

Write a new description that generalizes from the failures instead of listing lots of exact prompts.

Constraints:
- 100 to 200 words preferred
- Phrase it in terms of user intent, not internal implementation
- Make it distinctive enough to win against nearby skills
- Keep it portable across agents like Codex, Claude Code, and other tool-using assistants

Return only the description wrapped in <new_description> tags.
"""

    response_text = generate_text(prompt, backend=backend, model=model, timeout=300)
    description = extract_tagged_text(response_text, "new_description")

    transcript = {
        "iteration": iteration,
        "backend": backend,
        "prompt": prompt,
        "response": response_text,
        "final_description": description,
        "char_count": len(description),
    }

    if len(description) > 1024:
        shorten_prompt = (
            f"The description is {len(description)} characters. Rewrite it below 1024 characters without "
            "losing the key trigger intent. Return only <new_description>...</new_description>."
        )
        shortened_response = generate_text(
            "\n\n".join([prompt, response_text, shorten_prompt]),
            backend=backend,
            model=model,
            timeout=300,
        )
        description = extract_tagged_text(shortened_response, "new_description")
        transcript["rewrite_prompt"] = shorten_prompt
        transcript["rewrite_response"] = shortened_response
        transcript["rewrite_char_count"] = len(description)
        transcript["final_description"] = description

    if log_dir:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"improve_iter_{iteration or 'unknown'}.json"
        log_file.write_text(json.dumps(transcript, indent=2))

    return description


def main():
    parser = argparse.ArgumentParser(description="Improve a skill description based on eval results")
    parser.add_argument("--eval-results", required=True, help="Path to eval results JSON")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--history", default=None, help="Path to history JSON")
    parser.add_argument("--model", default=None, help="Optional backend model identifier")
    parser.add_argument("--backend", default="auto", choices=["auto", "claude", "codex"], help="Generation backend")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    skill_path = Path(args.skill_path)
    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    eval_results = json.loads(Path(args.eval_results).read_text())
    history = json.loads(Path(args.history).read_text()) if args.history else []

    name, _, content = parse_skill_md(skill_path)
    current_description = eval_results["description"]

    if args.verbose:
        print(f"Current: {current_description}", file=sys.stderr)
        print(f"Score: {eval_results['summary']['passed']}/{eval_results['summary']['total']}", file=sys.stderr)

    new_description = improve_description(
        backend=args.backend,
        skill_name=name,
        skill_content=content,
        current_description=current_description,
        eval_results=eval_results,
        history=history,
        model=args.model,
    )

    if args.verbose:
        print(f"Improved: {new_description}", file=sys.stderr)

    output = {
        "description": new_description,
        "history": history + [{
            "description": current_description,
            "passed": eval_results["summary"]["passed"],
            "failed": eval_results["summary"]["failed"],
            "total": eval_results["summary"]["total"],
            "results": eval_results["results"],
        }],
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
