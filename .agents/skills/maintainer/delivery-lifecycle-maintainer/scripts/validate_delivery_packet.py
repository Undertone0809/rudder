#!/usr/bin/env python3
"""Fail-closed structural and identity checks for a delivery packet."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SHA = re.compile(r"^[0-9a-f]{40}$")
STATUSES = {
    "draft",
    "in_progress",
    "review_ready",
    "acceptance_pending",
    "integration_pending",
    "delivered",
    "blocked",
    "invalidated",
}


def get(obj: dict, *keys):
    for key in keys:
        if not isinstance(obj, dict) or key not in obj:
            return None
        obj = obj[key]
    return obj


def require(packet: dict, path: str, errors: list[str]) -> object:
    value: object = packet
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            errors.append(f"missing {path}")
            return None
        value = value[key]
    if value is None or value == "":
        errors.append(f"empty {path}")
    return value


def check_sha(value: object, path: str, errors: list[str], *, allow_replace=True) -> None:
    if not isinstance(value, str):
        errors.append(f"{path} must be a 40-character lowercase SHA")
    elif not SHA.fullmatch(value) and not (allow_replace and value.startswith("replace-with-")):
        errors.append(f"{path} must be a 40-character lowercase SHA")


def receipt_matches(receipt: object, candidate: dict, errors: list[str], name: str) -> None:
    if not isinstance(receipt, dict):
        errors.append(f"receipts.{name} must be an object")
        return
    expected = {
        "candidate_fingerprint": candidate.get("dirty_fingerprint"),
        "source_sha": candidate.get("source_sha"),
        "build_id": get(candidate, "build", "id"),
        "runtime_id": get(candidate, "runtime", "id"),
        "data_id": get(candidate, "organization_data", "data_id"),
        "packet_version": get(candidate, "acceptance_packet", "version"),
    }
    for key, value in expected.items():
        if receipt.get(key) != value:
            errors.append(f"receipts.{name}.{key} does not match candidate identity")


def validate(packet: dict) -> list[str]:
    errors: list[str] = []
    for path in ("schema_version", "delivery_id", "status", "owner.root_id", "owner.agent_id", "intent.raw_request", "candidate.source_ref", "candidate.source_sha", "candidate.dirty_fingerprint", "candidate.build.id", "candidate.build.source_sha", "candidate.runtime.id", "candidate.runtime.source_sha", "candidate.organization_data.data_id", "candidate.acceptance_packet.version", "candidate.acceptance_packet.criteria", "candidate.acceptance_packet.state_inventory", "integration.target_ref", "integration.base_sha", "integration.remote_ref", "integration.observed_remote_sha", "integration.patch_tree_sha", "integration.expected_old_sha", "preservation.checked"):
        require(packet, path, errors)

    status = packet.get("status")
    if status not in STATUSES:
        errors.append(f"status must be one of {', '.join(sorted(STATUSES))}")

    candidate = packet.get("candidate")
    if not isinstance(candidate, dict):
        errors.append("candidate must be an object")
        candidate = {}
    for path in ("source_sha", "build.source_sha", "runtime.source_sha"):
        check_sha(get(candidate, *path.split(".")), f"candidate.{path}", errors)
    source_sha = candidate.get("source_sha")
    for path in ("build.source_sha", "runtime.source_sha"):
        if get(candidate, *path.split(".")) != source_sha:
            errors.append(f"candidate.{path} must match candidate.source_sha")

    receipts = packet.get("receipts")
    if not isinstance(receipts, dict):
        errors.append("receipts must be an object")
        receipts = {}
    for name in ("reviewer", "verifier", "final_review"):
        if name in receipts:
            receipt_matches(receipts[name], candidate, errors, name)

    drift = packet.get("drift", {})
    if not isinstance(drift, dict):
        errors.append("drift must be an object")
        drift = {}
    if drift.get("active") and status not in {"blocked", "invalidated"}:
        errors.append("active drift requires blocked or invalidated status")
    if drift.get("active") and not drift.get("invalidated_receipts"):
        errors.append("active drift requires invalidated_receipts")

    integration = packet.get("integration", {})
    if not isinstance(integration, dict):
        errors.append("integration must be an object")
        integration = {}
    if integration.get("authorized") and integration.get("mode") not in {"main_first", "isolated_conflict", "isolated_risk"}:
        errors.append("authorized integration has an invalid mode")
    if integration.get("index_update_mode") not in {"none", "alternate_index"}:
        errors.append("integration.index_update_mode must be none or alternate_index")
    cas = integration.get("cas")
    if not isinstance(cas, dict):
        errors.append("integration.cas must be an object")
        cas = {}
    if cas.get("succeeded"):
        if integration.get("expected_old_sha") != cas.get("observed_old_sha"):
            errors.append("successful CAS does not match expected_old_sha")
        if not cas.get("delivered_sha"):
            errors.append("successful CAS requires cas.delivered_sha")

    preservation = packet.get("preservation", {})
    if not isinstance(preservation, dict):
        errors.append("preservation must be an object")
        preservation = {}

    if status == "delivered":
        for path in (
            "candidate.source_sha",
            "candidate.build.source_sha",
            "candidate.runtime.source_sha",
            "integration.base_sha",
            "integration.observed_remote_sha",
            "integration.patch_tree_sha",
            "integration.expected_old_sha",
            "integration.cas.observed_old_sha",
            "integration.cas.delivered_sha",
            "terminal.delivered_sha",
            "terminal.delivered_tree_sha",
        ):
            check_sha(get(packet, *path.split(".")), path, errors, allow_replace=False)
        required_verdicts = {"reviewer": "accept", "verifier": "PASS", "final_review": "accept"}
        for name, verdict in required_verdicts.items():
            receipt = receipts.get(name, {})
            if receipt.get("verdict") != verdict:
                errors.append(f"delivered packet requires receipts.{name}.verdict={verdict}")
        if drift.get("active") or drift.get("invalidated_receipts"):
            errors.append("delivered packet cannot contain active or unrefreshed drift")
        if not cas.get("succeeded"):
            errors.append("delivered packet requires successful integration CAS")
        if not preservation.get("checked") or not preservation.get("unrelated_paths_preserved") or not preservation.get("index_preserved"):
            errors.append("delivered packet requires dirty-path and index preservation evidence")
        terminal = packet.get("terminal", {})
        for key in ("delivered_ref", "delivered_sha", "delivered_tree_sha", "timestamp"):
            if not terminal.get(key):
                errors.append(f"delivered packet requires terminal.{key}")
        if terminal.get("delivered_sha") and cas.get("delivered_sha") != terminal.get("delivered_sha"):
            errors.append("terminal.delivered_sha does not match CAS result")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packet", type=Path)
    args = parser.parse_args()
    try:
        packet = json.loads(args.packet.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INVALID: cannot read JSON packet: {exc}", file=sys.stderr)
        return 2
    if not isinstance(packet, dict):
        print("INVALID: packet root must be an object", file=sys.stderr)
        return 2
    errors = validate(packet)
    if errors:
        print("INVALID")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"VALID: {packet.get('status')} delivery packet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
