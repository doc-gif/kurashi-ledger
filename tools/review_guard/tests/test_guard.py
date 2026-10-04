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
        p["boundaries"] = [
            {"id": "B1", "direction": "entry", "location": "storage/root.py open_root()",
             "data": "root path chosen by the user", "trust": "partially-trusted",
             "control": "resolve the real path and reject links before use"},
            {"id": "B2", "direction": "exit", "location": "locks/root.lock",
             "data": "lock file next to the root", "trust": "trusted",
             "control": "created exclusively by the app that holds the lock"}]
        p["variant_analysis"] = [
            {"invariant_id": "root", "pattern": "root identity decided by a spelling of the path",
             "places": [{"location": "storage/root.py", "result": "uses the resolved path"}]},
            {"invariant_id": "lock", "cause_key": "identity", "pattern": "a second lock for the same root",
             "places": [{"location": "locks/acquire.py", "result": "same lock across restore swaps"},
                        {"location": "storage/restore.py", "result": "keeps the lock during the swap"}]}]
        return p

    def legacy_plan(self):
        p = self.plan()
        p["schema_version"] = 1
        del p["boundaries"], p["variant_analysis"]
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

    def test_batch_duplicate_existing_and_new_causes_rejected(self):
        for cause in ("identity", "new-cause"):
            candidates = [{"invariant_id": "lock", "cause_key": cause, "evidence": evidence}
                          for evidence in ("first synthetic evidence", "second synthetic evidence")]
            with self.subTest(cause=cause), self.assertRaisesRegex(guard.Invalid, "duplicate candidate cause"):
                guard.triage(self.catalog, self.ledger, candidates)

    def test_distinct_causes_and_cross_invariant_causes_preserve_order(self):
        candidates = [
            {"invariant_id": "root", "cause_key": "shared", "evidence": "root evidence"},
            {"invariant_id": "lock", "cause_key": "shared", "evidence": "lock evidence"},
            {"invariant_id": "lock", "cause_key": "identity", "evidence": "known cause evidence"}]
        result = guard.triage(self.catalog, self.ledger, candidates)
        self.assertEqual([row["candidate"] for row in result], candidates)
        self.assertEqual([row["action"] for row in result], ["propose-new", "propose-new", "update-existing"])
        self.assertEqual([row["existing_id"] for row in result], [None, None, "PR2-R007"])

    def test_duplicate_batch_cli_emits_no_partial_result(self):
        candidates = [{"invariant_id": "lock", "cause_key": "new-cause", "evidence": evidence}
                      for evidence in ("first synthetic evidence", "second synthetic evidence")]
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            args = ["triage"]
            for option, value in (("catalog", self.catalog), ("ledger", self.ledger), ("candidates", candidates)):
                path = root / (option + ".json")
                path.write_text(json.dumps(value), encoding="utf-8")
                args.extend(["--" + option, str(path)])
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(guard.main(args), 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertIn("duplicate candidate cause", stderr.getvalue())

    def test_duplicate_root_cause_with_different_id_rejected(self):
        f = copy.deepcopy(self.ledger["findings"][0])
        f["id"] = "PR2-R099"
        self.ledger["findings"].append(f)
        with self.assertRaises(guard.Invalid):
            guard.validate(self.catalog, self.ledger)

    def test_shared_finding_ids_require_pr_namespace_and_positive_number(self):
        for fid in ("R-007", "arbitrary", "PR0-R007", "PR02-R007", "PR2-R000",
                    "PR2-R7", "PR2-R007 ", " PR2-R007", "PR2-R٠٠٧"):
            ledger = copy.deepcopy(self.ledger)
            ledger["findings"][0]["id"] = fid
            with self.subTest(fid=fid), self.assertRaisesRegex(guard.Invalid, "finding id"):
                guard.validate(self.catalog, ledger)
        for fid in ("PR2-R007", "PR123-R1000"):
            ledger = copy.deepcopy(self.ledger)
            ledger["findings"][0]["id"] = fid
            with self.subTest(fid=fid):
                self.assertIn(fid, guard.validate(self.catalog, ledger)[1])

    def test_ledger_cause_whitespace_cannot_bypass_duplicate_detection(self):
        for cause in (" identity ", "identity\n", "\tidentity", "identity\u00a0"):
            ledger = copy.deepcopy(self.ledger)
            finding = copy.deepcopy(ledger["findings"][0])
            finding.update(id="PR2-R099", cause_key=cause)
            ledger["findings"].append(finding)
            with self.subTest(cause=cause), self.assertRaisesRegex(guard.Invalid, "trimmed"):
                guard.validate(self.catalog, ledger)

    def test_triage_cause_whitespace_cannot_propose_duplicate_as_new(self):
        for cause in (" identity ", "identity\n", "\tidentity", "identity\u00a0"):
            candidate = {"invariant_id": "lock", "cause_key": cause, "evidence": "synthetic regression"}
            with self.subTest(cause=cause), self.assertRaisesRegex(guard.Invalid, "trimmed"):
                guard.triage(self.catalog, self.ledger, [candidate])
        candidate = {"invariant_id": "lock", "cause_key": "identity", "evidence": "synthetic regression"}
        self.assertEqual(guard.triage(self.catalog, self.ledger, [candidate])[0]["existing_id"], "PR2-R007")

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

    def test_single_plan_metadata_exemption_does_not_exempt_other_review_files(self):
        catalog = copy.deepcopy(self.catalog)
        catalog["invariants"][0]["paths"] = [".review/**"]
        plan = guard.prepare(catalog, self.ledger, [], self.base)
        plan["task_id"] = "OPS-1"
        paths = [".review/plans/OPS-1.json"]
        result = guard.check(catalog, self.ledger, plan, paths, self.base)
        self.assertEqual(result["result"], "metadata-complete")
        self.assertEqual(result["invariants"], [])
        self.assertIn("does not verify", result["notice"])
        plan["planned_paths"] = [".review/findings.json"]
        with self.assertRaisesRegex(guard.Invalid, "missing invariant assessments"):
            guard.check(catalog, self.ledger, plan, paths + [".review/findings.json"], self.base)

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

    def test_cli_checks_the_changed_plan_file_not_another_same_task_part(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            changed = root / ".review/plans/OPS-1-new.json"
            changed.parent.mkdir(parents=True)
            changed.write_text(json.dumps(self.plan()), encoding="utf-8")
            other = root / "elsewhere/OPS-1-new.json"
            other.parent.mkdir()
            old = changed.with_name("OPS-1-old.json")
            for path in (other, old):
                path.write_text(json.dumps(self.plan()), encoding="utf-8")
            for name, value in [("catalog", self.catalog), ("ledger", self.ledger),
                                ("paths", self.paths + [".review/plans/OPS-1-new.json"])]:
                (root / (name + ".json")).write_text(json.dumps(value), encoding="utf-8")
            args = ["check", "--catalog", "catalog.json", "--ledger", "ledger.json",
                    "--paths-file", "paths.json", "--base-sha", self.base]
            with contextlib.chdir(root):
                for specified in (str(old), str(other)):
                    with self.subTest(specified=specified):
                        output, errors = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                            self.assertEqual(guard.main(args + ["--plan", specified]), 1)
                        self.assertEqual(output.getvalue(), "")
                        self.assertIn("changed preflight plan path", errors.getvalue())
                for specified in (str(changed), ".review/plans/OPS-1-new.json",
                                  "./.review/plans/OPS-1-new.json"):
                    with self.subTest(specified=specified), contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(guard.main(args + ["--plan", specified]), 0)
                        self.assertEqual(json.loads(output.getvalue())["result"], "metadata-complete")

    def test_cli_can_recheck_an_unchanged_plan(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, value in [("catalog", self.catalog), ("ledger", self.ledger),
                                ("OPS-1-old", self.plan()), ("paths", self.paths)]:
                (root / (name + ".json")).write_text(json.dumps(value), encoding="utf-8")
            with contextlib.chdir(root), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(guard.main(["check", "--catalog", "catalog.json",
                    "--ledger", "ledger.json", "--plan", "OPS-1-old.json",
                    "--paths-file", "paths.json", "--base-sha", self.base]), 0)

    def test_prepare_writes_schema_2_tables_that_must_be_filled(self):
        p = guard.prepare(self.catalog, self.ledger, self.paths, self.base)
        self.assertEqual(p["schema_version"], 2)
        self.assertEqual([v["invariant_id"] for v in p["variant_analysis"]], ["lock", "root"])
        self.assertEqual(len(p["boundaries"]), 1)
        p["task_id"] = "OPS-1"
        p["assessments"] = self.plan()["assessments"]
        with self.assertRaisesRegex(guard.Invalid, "direction"):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        empty = guard.prepare(self.catalog, self.ledger, [], self.base)
        self.assertEqual((empty["boundaries"], empty["variant_analysis"]), ([], []))

    def test_schema_2_plan_with_tables_passes_and_lists_unanalyzed_causes(self):
        result = guard.check(self.catalog, self.ledger, self.plan(), self.paths, self.base)
        self.assertEqual(result["plan_tables"], "checked")
        self.assertEqual(result["causes_not_analyzed"], [])
        self.assertIn("does not verify", result["notice"])
        p = self.plan()
        p["variant_analysis"][1].pop("cause_key")
        result = guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        self.assertEqual(result["causes_not_analyzed"], ["PR2-R007"])

    def test_schema_2_missing_sections_rejected(self):
        for missing in (("boundaries",), ("variant_analysis",), ("boundaries", "variant_analysis")):
            p = self.plan()
            for key in missing:
                del p[key]
            with self.subTest(missing=missing), self.assertRaisesRegex(
                    guard.Invalid, "requires both boundaries and variant_analysis"):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        for key, value in (("boundaries", {}), ("variant_analysis", "none")):
            p = self.plan()
            p[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(guard.Invalid, key + " must be a list"):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_empty_inventory_rejected_for_a_boundary_touching_change(self):
        p = self.plan()
        p["boundaries"] = []
        with self.assertRaisesRegex(guard.Invalid, 'empty inventory.*"lock", "root"'):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        # A plan-only change selects no invariant, so it has no boundary to list.
        p = guard.prepare(self.catalog, self.ledger, [], self.base)
        p["task_id"] = "OPS-1"
        result = guard.check(self.catalog, self.ledger, p, [".review/plans/OPS-1.json"], self.base)
        self.assertEqual((result["invariants"], result["plan_tables"]), ([], "checked"))

    def test_boundary_rows_need_direction_trust_and_control(self):
        for field, value, message in [
                ("direction", "both", "direction must be one of entry, exit"),
                ("direction", None, "direction"),
                ("trust", "TODO", "trust must be one of untrusted, partially-trusted, trusted"),
                ("trust", "high", "trust"),
                ("location", "", "missing location"),
                ("data", "TBD", "missing data"),
                ("control", None, "missing control"),
                ("id", "", "boundaries: missing id")]:
            p = self.plan()
            if value is None:
                del p["boundaries"][0][field]
            else:
                p["boundaries"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(guard.Invalid, message):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        p = self.plan()
        p["boundaries"][1]["id"] = "B1"
        with self.assertRaisesRegex(guard.Invalid, "duplicate id"):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_cause_key_listed_without_checked_places_rejected(self):
        for places in ([], None, "storage/root.py", [{"location": "storage/root.py"}],
                       [{"location": "TODO", "result": "fine"}]):
            p = self.plan()
            if places is None:
                del p["variant_analysis"][1]["places"]
            else:
                p["variant_analysis"][1]["places"] = places
            with self.subTest(places=places), self.assertRaisesRegex(
                    guard.Invalid, r'variant_analysis\["lock"/"identity"\]: (no places checked|each place needs)'):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_variant_analysis_must_cover_selected_invariants(self):
        p = self.plan()
        p["variant_analysis"] = [v for v in p["variant_analysis"] if v["invariant_id"] != "root"]
        with self.assertRaisesRegex(guard.Invalid, 'missing selected invariants "root"'):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        p = self.plan()
        p["variant_analysis"][0]["pattern"] = "TODO"
        with self.assertRaisesRegex(guard.Invalid, "missing pattern"):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_variant_cause_keys_must_match_the_ledger_exactly_once(self):
        for row, message in [
                ({"invariant_id": "lock", "cause_key": "other"}, 'not in the ledger for "lock"'),
                ({"invariant_id": "root", "cause_key": "identity"}, 'not in the ledger for "root"'),
                ({"invariant_id": "lock", "cause_key": " identity"}, "trimmed"),
                ({"invariant_id": "lock", "cause_key": "identity\n"}, "trimmed"),
                ({"invariant_id": "lock", "cause_key": ""}, "trimmed"),
                ({"invariant_id": "lock", "cause_key": "identity"}, "duplicate entry"),
                ({"invariant_id": "missing"}, "unknown invariant_id"),
                ({"invariant_id": ["lock"]}, "unknown invariant_id")]:
            p = self.plan()
            p["variant_analysis"].append(dict(row, pattern="synthetic sibling", places=[
                {"location": "storage/other.py", "result": "not affected"}]))
            with self.subTest(row=row), self.assertRaisesRegex(guard.Invalid, message):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_untrusted_plan_values_cannot_forge_log_lines(self):
        p = self.plan()
        p["boundaries"][1]["id"] = "B1\n::error::forged"
        p["boundaries"].append(dict(p["boundaries"][1]))
        with self.assertRaises(guard.Invalid) as raised:
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        self.assertNotIn("\n", str(raised.exception))
        p = self.plan()
        p["assessments"].append(copy.deepcopy(p["assessments"][0]))
        p["assessments"][0]["id"] = p["assessments"][1]["id"] = "lock\n::warning::forged"
        with self.assertRaises(guard.Invalid) as raised:
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        self.assertNotIn("\n", str(raised.exception))

    def test_boundary_ids_must_be_trimmed(self):
        for value in (" B1", "B1 ", "B1\n"):
            p = self.plan()
            p["boundaries"][0]["id"] = value
            with self.subTest(value=value), self.assertRaisesRegex(guard.Invalid, "id must be trimmed"):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_catalog_ledger_and_json_key_values_cannot_forge_log_lines(self):
        forged = "x\n::error::forged"
        cases = []
        for field, value in [("condition", ""), ("paths", []), ("related", [forged + "-missing"]),
                             ("scenarios", [{"id": forged, "question": ""}])]:
            catalog = copy.deepcopy(self.catalog)
            catalog["invariants"][0]["id"] = forged
            catalog["invariants"][1]["related"] = []
            catalog["invariants"][0][field] = value
            cases.append((catalog, self.ledger))
        for field, value in [("id", "PR2-R007\n::error::forged"), ("invariant_id", forged),
                             ("cause_key", " identity\n::error::forged"), ("lesson", ""), ("sources", [])]:
            ledger = copy.deepcopy(self.ledger)
            ledger["findings"][0]["id"] = "PR2-R007\n::error::forged"
            if field != "id":
                ledger["findings"][0]["id"] = "PR2-R007"
                ledger["findings"][0][field] = value
            cases.append((self.catalog, ledger))
        ledger = copy.deepcopy(self.ledger)
        ledger["findings"].append(dict(ledger["findings"][0], id="PR2-R008"))
        for finding in ledger["findings"]:
            finding["cause_key"] = "a ::error::forged"
        cases.append((self.catalog, ledger))
        for catalog, ledger in cases:
            with self.subTest(catalog=catalog["invariants"][0], ledger=ledger["findings"]):
                with self.assertRaises(guard.Invalid) as raised:
                    guard.validate(catalog, ledger)
                message = str(raised.exception)
                self.assertNotIn("\n", message)
                self.assertTrue(message.isascii(), message)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "dup.json"
            path.write_text('{"a\\n::error::forged": 1, "a\\n::error::forged": 2}', encoding="utf-8")
            with self.assertRaisesRegex(guard.Invalid, "duplicate JSON key") as raised:
                guard.read_json(path)
            self.assertNotIn("\n", str(raised.exception))

    def test_ledger_and_catalog_versions_must_be_integers(self):
        for value in (True, 1.0, "1", None):
            ledger = copy.deepcopy(self.ledger)
            ledger["schema_version"] = value
            with self.subTest(ledger=value), self.assertRaisesRegex(guard.Invalid, "schema version"):
                guard.validate(self.catalog, ledger)
        guard.validate(self.catalog, self.ledger)

    def test_legacy_schema_1_plan_still_passes_and_is_reported(self):
        result = guard.check(self.catalog, self.ledger, self.legacy_plan(), self.paths, self.base)
        self.assertEqual(result["plan_tables"], "legacy-v1")
        self.assertIn("New plans must use schema 2", result["legacy_notice"])
        self.assertNotIn("causes_not_analyzed", result)
        # Every existing check still applies to schema 1.
        p = self.legacy_plan()
        p["assessments"][0]["reason"] = "TODO"
        with self.assertRaisesRegex(guard.Invalid, "rationale"):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_legacy_schema_1_plan_with_tables_is_checked_the_same_way(self):
        p = self.plan()
        p["schema_version"] = 1
        self.assertEqual(guard.check(self.catalog, self.ledger, p, self.paths, self.base)["plan_tables"], "checked")
        del p["variant_analysis"]
        with self.assertRaisesRegex(guard.Invalid, "plan schema 1 requires both"):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        p = self.plan()
        p["schema_version"] = 1
        p["boundaries"] = []
        with self.assertRaisesRegex(guard.Invalid, "empty inventory"):
            guard.check(self.catalog, self.ledger, p, self.paths, self.base)

    def test_unknown_or_non_integer_schema_versions_rejected(self):
        for value in (0, 3, "2", 2.0, True, None):
            p = self.plan()
            p["schema_version"] = value
            with self.subTest(value=value), self.assertRaisesRegex(guard.Invalid, "schema_version"):
                guard.check(self.catalog, self.ledger, p, self.paths, self.base)
        for value in (True, 1.0, "1"):
            catalog = copy.deepcopy(self.catalog)
            catalog["schema_version"] = value
            with self.subTest(catalog=value), self.assertRaisesRegex(guard.Invalid, "schema version"):
                guard.validate(catalog, self.ledger)

    def test_cli_check_reports_missing_tables_with_exit_1(self):
        p = self.plan()
        del p["boundaries"]
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, value in [("catalog", self.catalog), ("ledger", self.ledger),
                                ("OPS-1", p), ("paths", self.paths)]:
                (root / (name + ".json")).write_text(json.dumps(value), encoding="utf-8")
            args = ["check", "--catalog", str(root / "catalog.json"), "--ledger", str(root / "ledger.json"),
                    "--plan", str(root / "OPS-1.json"), "--paths-file", str(root / "paths.json"),
                    "--base-sha", self.base]
            output, errors = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(guard.main(args), 1)
            self.assertEqual(output.getvalue(), "")
            self.assertIn("requires both boundaries and variant_analysis", errors.getvalue())

    def test_old_name_in_rename_still_selects_storage(self):
        p = guard.prepare(self.catalog, self.ledger, ["storage/old.py", "other/new.py"], self.base)
        self.assertEqual(set(p["context"]), {"root", "lock"})



if __name__ == "__main__":
    unittest.main()
