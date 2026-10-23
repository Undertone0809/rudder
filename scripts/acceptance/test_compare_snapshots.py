import copy
import unittest

from compare_snapshots import compare_n01_snapshots


def snapshots():
    alias = {"table": "issues", "column": "assignee_adapter_overrides", "type": "jsonb", "nullable": "YES", "default": None}
    peer = {"table": "issues", "column": "assignee_agent_id", "type": "uuid", "nullable": "YES", "default": None}
    before = {"columns": [alias, peer], "constraints": [{"name": "issue_pk"}], "indexes": [{"name": "issue_idx"}], "organizations": [{"id": "org-a"}], "sentinel": [{"id": "sentinel-a", "value": 3}], "journal": [{"id": 1}]}
    after = copy.deepcopy(before)
    after["columns"][0]["column"] = "assignee_agent_runtime_overrides"
    after["columns"].reverse()
    after["journal"].append({"id": 2})
    return before, after


class SnapshotComparisonTests(unittest.TestCase):
    def test_supported_rename_after_sorting_does_not_mutate_captures(self):
        before, after = snapshots()
        untouched = copy.deepcopy((before, after))
        self.assertTrue(compare_n01_snapshots(before, after))
        self.assertEqual((before, after), untouched)

    def test_rejects_real_column_or_data_changes(self):
        def target(snapshot):
            return next(c for c in snapshot["columns"] if c["column"] == "assignee_agent_runtime_overrides")

        mutations = {
            "type": lambda s: target(s).update(type="text"),
            "default": lambda s: target(s).update(default="'{}'::jsonb"),
            "nullability": lambda s: target(s).update(nullable="NO"),
            "added column": lambda s: s["columns"].append({"table": "issues", "column": "extra", "type": "text"}),
            "dropped column": lambda s: s["columns"].pop(0),
            "index": lambda s: s["indexes"][0].update(name="changed_idx"),
            "constraint": lambda s: s["constraints"][0].update(name="changed_pk"),
            "wrong alias": lambda s: target(s).update(column="unknown_alias"),
            "sentinel": lambda s: s["sentinel"][0].update(value=4),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                before, after = snapshots()
                mutate(after)
                self.assertFalse(compare_n01_snapshots(before, after))

    def test_rejects_duplicate_column_identities_and_missing_captures(self):
        before, after = snapshots()
        after["columns"].append(copy.deepcopy(after["columns"][0]))
        self.assertFalse(compare_n01_snapshots(before, after))
        before, after = snapshots()
        before.pop("sentinel")
        after.pop("sentinel")
        self.assertFalse(compare_n01_snapshots(before, after))


if __name__ == "__main__":
    unittest.main()
