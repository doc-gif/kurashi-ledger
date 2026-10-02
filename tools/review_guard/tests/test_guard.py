import copy
import contextlib
import io
import importlib.util
import json
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
        for field in ("task_id", "reason", "method", "expected"):
            p = self.plan()
            if field == "task_id":
                p[field] = "TODO"
            elif field == "reason":
                p["assessments"][0][field] = "TODO"
            else:
                p["assessments"][0]["checks"][0][field] = "TODO"
            with self.subTest(field=field), self.assertRaisesRegex(guard.Invalid, {
                    "task_id": "task_id", "reason": "rationale", "method": "method/expected", "expected": "method/expected"}[field]):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

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

    def test_design_change_with_reference_is_reported_not_approved(self):
        p = self.plan()
        p["assessments"][0].update(disposition="change-proposed",
                                    decision_references=["docs/adr/0020-new-lock.md"])
        result = guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        self.assertEqual(result["result"], "metadata-complete")
        self.assertEqual(result["decisions_to_review"], [{"id": "lock", "decision_references": ["docs/adr/0020-new-lock.md"]}])
        for refs in ([], ["TODO"], "https://example.com/approval"):
            p["assessments"][0]["decision_references"] = refs
            with self.subTest(refs=refs), self.assertRaisesRegex(guard.Invalid, "decision_references"):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_recheck_base_does_not_require_rewriting_unchanged_assessments(self):
        p = self.plan()
        original = copy.deepcopy(p["assessments"])
        p["base_sha"] = "b" * 40
        guard.check(self.catalog, self.ledger, p, self.paths, "b" * 40)
        self.assertEqual(p["assessments"], original)

    def test_policy_removal_narrowing_and_rewording_are_visible(self):
        after = copy.deepcopy(self.catalog)
        after["invariants"].pop(1)
        after["invariants"][0].update(paths=["storage/only.py"], related=[], scenarios=[], condition="changed")
        changes = guard.policy_changes(self.catalog, after)
        self.assertEqual([(c["id"], c["field"]) for c in changes], [
            ("lock", "invariant"), ("root", "condition"), ("root", "paths"),
            ("root", "related"), ("root", "scenarios")])
        self.assertEqual(guard.policy_changes(self.catalog, self.catalog), [])

    def test_utf8_bom_and_cli_output_work_with_legacy_console(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            catalog = copy.deepcopy(self.catalog)
            catalog["invariants"][0]["condition"] = "保存先の確認"
            for name, value in [("catalog", catalog), ("ledger", self.ledger), ("paths", self.paths)]:
                (root / (name + ".json")).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8-sig")
            args = ["prepare", "--catalog", str(root / "catalog.json"), "--ledger", str(root / "ledger.json"),
                    "--paths-file", str(root / "paths.json"), "--base-sha", self.base]
            output = root / "plans/plan.json"
            # A console limited to ASCII must never have to encode Japanese output.
            stream = io.TextIOWrapper(io.BytesIO(), encoding="ascii")
            with contextlib.redirect_stdout(stream):
                self.assertEqual(guard.main(args + ["--output", str(output)]), 0)
                self.assertEqual(guard.main(args), 0)
            self.assertIn("保存先の確認", output.read_text(encoding="utf-8"))
            self.assertEqual(guard.read_json(output)["context"]["root"]["condition"], "保存先の確認")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(guard.main(args + ["--output", str(output)]), 1)

    def test_old_python_fails_with_actionable_error(self):
        with self.assertRaisesRegex(guard.Invalid, "3.11"):
            guard.require_runtime((3, 9))
        guard.require_runtime((3, 11))

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
        guard.check(self.catalog, self.ledger, self.plan(), self.paths + [".review/plans/OPS-1.json"], self.base)

    def test_multiple_plans_fail_in_core_and_documented_local_cli(self):
        paths = self.paths + [".review/plans/OPS-1.json", ".review/plans/other.json"]
        with self.assertRaisesRegex(guard.Invalid, "multiple changed preflight plans"):
            guard.check(self.catalog, self.ledger, self.plan(), paths, self.base)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, value in [("catalog", self.catalog), ("ledger", self.ledger),
                                ("plan", self.plan()), ("paths", paths)]:
                (root / (name + ".json")).write_text(json.dumps(value), encoding="utf-8")
            args = ["check", "--base-sha", self.base]
            for option in ("catalog", "ledger", "plan"):
                args += ["--" + option, str(root / (option + ".json"))]
            (root / "plan.json").rename(root / "OPS-1.json")
            args[args.index("--plan") + 1] = str(root / "OPS-1.json")
            args += ["--paths-file", str(root / "paths.json")]
            output, errors = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(guard.main(args), 1)
            self.assertEqual(output.getvalue(), "")
            self.assertIn("multiple changed preflight plans", errors.getvalue())

    def test_plan_filename_belongs_to_task_in_core_and_cli(self):
        plan = self.plan()
        for name in ("OPS-1.json", "OPS-1-storage.json"):
            with self.subTest(name=name):
                guard.check(self.catalog, self.ledger, plan,
                            self.paths + [".review/plans/" + name], self.base)
        for name in ("OTHER.json", "OPS-1-.json", "OPS-10.json", "OPS-1.txt"):
            with self.subTest(name=name), self.assertRaisesRegex(guard.Invalid, "filename"):
                guard.check_plan_name(plan, name)
        with self.assertRaisesRegex(guard.Invalid, "filename"):
            guard.check(self.catalog, self.ledger, plan,
                        self.paths + [".review/plans/OTHER.json"], self.base)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, value in [("catalog", self.catalog), ("ledger", self.ledger),
                                ("OTHER", plan), ("paths", self.paths)]:
                (root / (name + ".json")).write_text(json.dumps(value), encoding="utf-8")
            args = ["check", "--catalog", str(root / "catalog.json"),
                    "--ledger", str(root / "ledger.json"), "--plan", str(root / "OTHER.json"),
                    "--paths-file", str(root / "paths.json"), "--base-sha", self.base]
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(guard.main(args), 1)
            self.assertIn("filename", errors.getvalue())

    def test_old_name_in_rename_still_selects_storage(self):
        p = guard.prepare(self.catalog, self.ledger, ["storage/old.py", "other/new.py"], self.base)
        self.assertEqual(set(p["context"]), {"root", "lock"})



if __name__ == "__main__":
    unittest.main()
