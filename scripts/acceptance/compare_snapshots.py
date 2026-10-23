"""Compare captured N01 catalog/data snapshots after the one supported alias rename.

This is an offline acceptance helper, never a database writer. Journal changes
are checked separately by the runtime observer. Every other field stays exact.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path


def compare_n01_snapshots(before: dict, after: dict) -> bool:
    required = {"columns", "constraints", "indexes", "organizations", "sentinel"}
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    if not required.issubset(before) or not required.issubset(after):
        return False
    left, right = copy.deepcopy(before), copy.deepcopy(after)
    for snapshot in (left, right):
        for key in ("journal", "journal_columns"):
            snapshot.pop(key, None)
        columns = snapshot["columns"]
        if not isinstance(columns, list) or any(
            not isinstance(column, dict)
            or not isinstance(column.get("table"), str)
            or not isinstance(column.get("column"), str)
            for column in columns
        ):
            return False
        identities = [(column["table"], column["column"]) for column in columns]
        if len(set(identities)) != len(identities):
            return False

    old, new = "assignee_adapter_overrides", "assignee_agent_runtime_overrides"
    selected = []
    for snapshot, expected, absent in ((left, old, new), (right, new, old)):
        found = [c for c in snapshot["columns"] if c["table"] == "issues" and c["column"] == expected]
        if len(found) != 1 or any(
            c["table"] == "issues" and c["column"] == absent for c in snapshot["columns"]
        ):
            return False
        column = found[0]
        if not {"type", "nullable", "default"}.issubset(column):
            return False
        if column["type"] != "jsonb" or column["nullable"] != "YES" or column["default"] is not None:
            return False
        selected.append(column)
    selected[0]["column"] = new
    # The original SQL sorted by the old column name. Renaming the object can
    # change its ordering key, so sort both complete lists after normalization.
    for snapshot in (left, right):
        snapshot["columns"].sort(key=lambda column: (column["table"], column["column"]))
    return left == right


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    args = parser.parse_args()
    equal = compare_n01_snapshots(json.loads(args.before.read_text()), json.loads(args.after.read_text()))
    print(json.dumps({"equal_except_supported_alias_and_journal": equal}))
    return 0 if equal else 1


if __name__ == "__main__":
    raise SystemExit(main())
