"""Kurashi-specific routing checks; retained here when the generic tool is extracted."""
import importlib.util
from pathlib import Path
import unittest

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("guard", root / "tools/review_guard/guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class RepositoryRoutingTests(unittest.TestCase):
    def assert_required_assessment(self, path, invariant, scenarios):
        catalog = guard.read_json(root / ".review/invariants.json")
        ledger = guard.read_json(root / ".review/findings.json")
        base = "a" * 40
        plan = guard.prepare(catalog, ledger, [path], base)
        selected = {a["id"]: a for a in plan["assessments"]}
        self.assertIn(invariant, selected)
        self.assertEqual({c["id"] for c in selected[invariant]["checks"]}, scenarios)
        plan["task_id"] = "OPS-ROUTING"
        for assessment in plan["assessments"]:
            assessment["reason"] = "Synthetic routing fixture preserves the selected condition"
            for check in assessment["checks"]:
                check.update(method="inspect synthetic routing fixture", expected="condition remains covered")
        self.assertEqual(guard.check(catalog, ledger, plan, [path], base)["result"], "metadata-complete")
        plan["assessments"] = [a for a in plan["assessments"] if a["id"] != invariant]
        with self.assertRaisesRegex(ValueError, "missing invariant assessments:.*" + invariant):
            guard.check(catalog, ledger, plan, [path], base)

    def test_readme_requires_tasks_and_both_entrypoint_scenarios(self):
        self.assert_required_assessment("README.md", "INV-TASKS", {"dependencies", "entrypoints"})

    def test_ui_design_and_application_require_record_semantics_and_history(self):
        for path in ["src/ui/AmountInput.tsx", "design/components.md", "src/application/cashflow/project.ts"]:
            with self.subTest(path=path):
                self.assert_required_assessment(path, "INV-RECORDS", {"meaning", "history"})

    def test_planned_test_oracle_rules_and_workflow_paths_select_conditions(self):
        root = Path(__file__).resolve().parents[2]
        rules, _ = guard.validate(guard.read_json(root / ".review/invariants.json"),
                                  guard.read_json(root / ".review/findings.json"))
        for path, expected in [("tests/fixtures/records.json", "INV-RECORDS"),
                               ("docs/test-oracles/tax.md", "INV-RECORDS"),
                               ("docs/rules/2026.md", "INV-RECORDS"),
                               ("e2e/records.test.ts", "INV-HTTP"),
                               (".github/workflows/ci.yml", "INV-RELEASE")]:
            with self.subTest(path=path):
                self.assertIn(expected, guard.affected(rules, [path]))

    def test_t26_http_directory_selects_http_and_release_conditions(self):
        root = Path(__file__).resolve().parents[2]
        catalog = guard.read_json(root / ".review/invariants.json")
        ledger = guard.read_json(root / ".review/findings.json")
        rules, _ = guard.validate(catalog, ledger)
        selected = guard.affected(rules, ["src/infrastructure/http/server.ts"])
        self.assertTrue({"INV-HTTP", "INV-RELEASE", "INV-LOCK"} <= set(selected))

    def test_pr4_lessons_are_retrievable_without_renumbering(self):
        catalog = guard.read_json(root / ".review/invariants.json")
        ledger = guard.read_json(root / ".review/findings.json")
        candidates = [
            {"invariant_id": "INV-TASKS", "cause_key": "draft-open-entrypoint-coherence", "evidence": "new template evidence"},
            {"invariant_id": "INV-REVIEW", "cause_key": "batch-cause-duplication", "evidence": "new batch evidence"}]
        result = guard.triage(catalog, ledger, candidates)
        self.assertEqual([(r["existing_id"], r["action"]) for r in result],
                         [("PR4-R022", "update-existing"), ("PR4-R023", "update-existing")])
        plan = guard.prepare(catalog, ledger, ["tools/review_guard/guard.py"], "a" * 40)
        history = {f["id"] for context in plan["context"].values() for f in context["history"]}
        self.assertTrue({"PR4-R014", "PR4-R018", "PR4-R022", "PR4-R023"} <= history)

    def test_npm_install_policy_selects_release_conditions(self):
        root = Path(__file__).resolve().parents[2]
        catalog = guard.read_json(root / ".review/invariants.json")
        ledger = guard.read_json(root / ".review/findings.json")
        rules, _ = guard.validate(catalog, ledger)
        self.assertIn("INV-RELEASE", guard.affected(rules, [".npmrc"]))


if __name__ == "__main__":
    unittest.main()
