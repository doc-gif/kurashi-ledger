import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("guard", Path(__file__).parents[1] / "guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ReviewGuardTests(unittest.TestCase):
    def setUp(self):
        self.base = "a" * 40
        self.catalog = {"schema_version": 1, "invariants": [
            {"id": "root", "condition": "root keeps identity", "paths": ["storage/*"],
             "related": ["lock"], "scenarios": [{"id": "new", "question": "new root?"}]},
            {"id": "lock", "condition": "lock survives swaps", "paths": ["locks/*"],
             "related": ["root"], "scenarios": [{"id": "swap", "question": "restore swap?"}]}]}
        self.ledger = {"schema_version": 1, "findings": [
            {"id": "PR2-R007", "invariant_id": "lock", "cause_key": "identity",
             "lesson": "keep a stable lock", "sources": ["https://example.com/review/7"]}]}
        self.paths = ["storage/root.py"]

    def plan(self):
        p = guard.prepare(self.catalog, self.ledger, self.paths, self.base)
        p["task_id"] = "OPS-1"
        for a in p["assessments"]:
            a["reason"] = "Same file identity before and after restore"
            for c in a["checks"]:
                c.update(method="two processes using synthetic roots", expected="second process refuses the lock")
        return p

    def test_related_invariants_cycle_is_finite_and_history_retrieved(self):
        p = self.plan()
        self.assertEqual([a["id"] for a in p["assessments"]], ["lock", "root"])
        self.assertEqual(p["context"]["lock"]["history"][0]["id"], "PR2-R007")

    def test_valid_plan_is_only_metadata_complete(self):
        result = guard.check(self.catalog, self.ledger, self.plan(), self.paths, self.base)
        self.assertEqual(result["result"], "metadata-complete")
        self.assertIn("does not verify", result["notice"])

    def test_draft_plan_does_not_pass(self):
        with self.assertRaises(guard.Invalid):
            guard.check(self.catalog, self.ledger, guard.prepare(self.catalog, self.ledger, self.paths, self.base), self.paths, self.base)

    def test_changed_base_or_added_path_requires_replan(self):
        for paths, base in [(self.paths, "b" * 40), (self.paths + ["new/file.py"], self.base)]:
            with self.subTest(paths=paths, base=base), self.assertRaises(guard.Invalid):
                guard.check(self.catalog, self.ledger, self.plan(), paths, base)

    def test_missing_related_rule_or_scenario_cannot_pass(self):
        for mode in ("rule", "scenario"):
            p = self.plan()
            if mode == "rule":
                p["assessments"].pop(0)
            else:
                p["assessments"][0]["checks"] = []
            with self.subTest(mode=mode), self.assertRaises(guard.Invalid):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_unknown_and_duplicate_ids_rejected(self):
        for mode in ("unknown", "duplicate"):
            c = copy.deepcopy(self.catalog)
            if mode == "unknown":
                c["invariants"][0]["related"] = ["missing"]
            else:
                c["invariants"].append(copy.deepcopy(c["invariants"][0]))
            with self.subTest(mode=mode), self.assertRaises(guard.Invalid):
                guard.validate(c, self.ledger)

    def test_unresolved_conflict_and_self_approved_rule_change_do_not_pass(self):
        for mode in ("conflict", "rule-change"):
            p = self.plan()
            if mode == "conflict":
                p["conflicts"] = [{"description": "lock moves during restore", "state": "open"}]
            else:
                p["assessments"][0]["disposition"] = "change-proposed"
            with self.subTest(mode=mode), self.assertRaises(guard.Invalid):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_not_applicable_needs_reason_and_scenario_explanation(self):
        p = self.plan()
        p["assessments"][0].update(disposition="not-applicable", reason="")
        with self.assertRaises(guard.Invalid):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_same_cause_reuses_id_even_for_new_evidence(self):
        result = guard.triage(self.catalog, self.ledger, [
            {"invariant_id": "lock", "cause_key": "identity", "evidence": "new head reproduces the problem"},
            {"invariant_id": "lock", "cause_key": "other", "evidence": "different failure"}])
        self.assertEqual(result[0]["existing_id"], "PR2-R007")
        self.assertEqual(result[0]["action"], "update-existing")
        self.assertEqual(result[1]["action"], "propose-new")

    def test_duplicate_root_cause_with_different_id_rejected(self):
        f = copy.deepcopy(self.ledger["findings"][0])
        f["id"] = "PR2-R099"
        self.ledger["findings"].append(f)
        with self.assertRaises(guard.Invalid):
            guard.validate(self.catalog, self.ledger)

    def test_paths_are_data_not_commands_and_traversal_rejected(self):
        self.assertEqual(guard.paths_list(["src/$(echo harmless).py"]), ["src/$(echo harmless).py"])
        for path in ("../secret", "/absolute", "C:/secret", "a\\b", "a\nb", "a//b"):
            with self.subTest(path=path), self.assertRaises(guard.Invalid):
                guard.paths_list([path])

    def test_duplicate_json_key_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bad.json"
            p.write_text('{"schema_version": 1, "schema_version": 2}', encoding="utf-8")
            with self.assertRaises(guard.Invalid):
                guard.read_json(p)

    def test_plan_metadata_does_not_need_to_list_itself(self):
        guard.check(self.catalog, self.ledger, self.plan(), self.paths + [".review/plans/task.json"], self.base)

    def test_old_name_in_rename_still_selects_storage(self):
        p = guard.prepare(self.catalog, self.ledger, ["storage/old.py", "other/new.py"], self.base)
        self.assertEqual(set(p["context"]), {"root", "lock"})


if __name__ == "__main__":
    unittest.main()
