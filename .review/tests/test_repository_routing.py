"""Kurashi-specific routing checks; retained here when the generic tool is extracted.

Stage 4 of mekiki (design 8): the routing is checked with both ledgers until stage 5 removes the old one.
- old: .review/invariants.json and .review/findings.json (PR<N>-R<NNN> IDs; kept until the new ledger is rebuilt, although the old dispatcher is gone).
- new: the project ledger .review/causes/, the global ID catalogue .review/mekiki/global-ids.json and
  [causes.paths] of .review/config.toml (C-NNNN IDs; the CI validate step and, once on main, ci.py read them).
"""
import hashlib
import importlib.util
from pathlib import Path
import unittest

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("guard", root / "tools/review_guard/guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

BASE = "a" * 40
LAYOUTS = ("old", "new")


def load(layout):
    """(catalog, ledger, global_ids, extensions) of one layout; the old one has no catalogue or settings."""
    if layout == "old":
        return (guard.read_json(root / ".review/invariants.json"), guard.read_json(root / ".review/findings.json"),
                None, None)
    ids = guard.read_json(root / ".review/mekiki/global-ids.json")
    extensions = guard.path_extensions(guard.read_config(root / ".review/config.toml"), ids)
    return (guard.read_json(root / ".review/causes/invariants.json"),
            guard.read_json(root / ".review/causes/findings.json"), ids, extensions)


def routing_rules(layout):
    catalog, ledger, ids, extensions = load(layout)
    rules, _ = guard.validate(catalog, ledger, ids)
    return guard.with_extensions(rules, extensions)


def filled_plan(layout, path):
    """A synthetic plan for one path. The old layout uses prepare; with the catalogue, prepare needs the private
    global ledger, so the plan is built from the selected IDs alone (a public plan names global IDs only)."""
    catalog, ledger, ids, extensions = load(layout)
    if layout == "old":
        plan = guard.prepare(catalog, ledger, [path], BASE)
    else:
        rules = routing_rules(layout)
        selected = guard.affected(rules, [path])
        plan = {"schema_version": 2, "base_sha": BASE, "planned_paths": [path], "conflicts": [], "context": {},
                "assessments": [{"id": rid, "disposition": "preserve", "reason": "TODO",
                                 "checks": [{"id": s["id"], "method": "TODO", "expected": "TODO"}
                                            for s in rules[rid]["scenarios"]]} for rid in selected],
                "variant_analysis": [{"invariant_id": rid} for rid in selected]}
    plan["task_id"] = "OPS-ROUTING"
    for assessment in plan["assessments"]:
        assessment["reason"] = "Synthetic routing fixture preserves the selected condition"
        for check in assessment["checks"]:
            check.update(method="inspect synthetic routing fixture", expected="condition remains covered")
    # Schema 2 plan tables (docs/review-prevention.md); routing is what this test checks.
    plan["boundaries"] = [{"id": "B1", "direction": "exit", "location": "synthetic routing fixture",
                           "data": "synthetic path", "trust": "trusted", "control": "test only"}]
    for row in plan["variant_analysis"]:
        row.update(pattern="synthetic routing sibling",
                   places=[{"location": "synthetic routing fixture", "result": "covered"}])
    return plan


def check(layout, plan, paths):
    catalog, ledger, ids, extensions = load(layout)
    return guard.check(catalog, ledger, plan, paths, BASE, ".review", ids, extensions)


class RepositoryRoutingTests(unittest.TestCase):
    def assert_required_assessment(self, path, invariant, scenarios):
        for layout in LAYOUTS:
            with self.subTest(layout=layout, path=path):
                plan = filled_plan(layout, path)
                selected = {a["id"]: a for a in plan["assessments"]}
                self.assertIn(invariant, selected)
                self.assertEqual({c["id"] for c in selected[invariant]["checks"]}, scenarios)
                self.assertEqual(check(layout, plan, [path])["result"], "metadata-complete")
                plan["assessments"] = [a for a in plan["assessments"] if a["id"] != invariant]
                with self.assertRaisesRegex(ValueError, "missing invariant assessments:.*" + invariant):
                    check(layout, plan, [path])

    def test_both_layouts_validate(self):
        catalog, ledger, _, _ = load("old")
        rules, findings = guard.validate(catalog, ledger)
        self.assertTrue(rules and findings)
        catalog, ledger, ids, extensions = load("new")
        rules, findings = guard.validate(catalog, ledger, ids)
        self.assertTrue(rules and findings)
        self.assertTrue(extensions)

    def test_new_layout_keeps_every_existing_invariant_route(self):
        # The split may generalize text, but the paths (catalogue + [causes.paths]), related invariants and scenario
        # IDs of every existing invariant stay the same, so each path selects what it selected before.
        old, new = routing_rules("old"), routing_rules("new")
        self.assertLessEqual(old.keys(), new.keys())
        for rid, rule in old.items():
            with self.subTest(invariant=rid):
                self.assertEqual(sorted(new[rid]["paths"]), sorted(rule["paths"]))
                self.assertEqual(sorted(new[rid]["related"]), sorted(rule["related"]))
                self.assertEqual([s["id"] for s in new[rid]["scenarios"]], [s["id"] for s in rule["scenarios"]])

    def test_config_paths_route_readme_to_the_global_tasks_invariant(self):
        catalog, ledger, ids, extensions = load("new")
        bare, _ = guard.validate(catalog, ledger, ids)
        self.assertNotIn("INV-TASKS", guard.affected(bare, ["README.md"]))
        self.assertIn("INV-TASKS", guard.affected(guard.with_extensions(bare, extensions), ["README.md"]))

    def test_readme_requires_tasks_and_both_entrypoint_scenarios(self):
        self.assert_required_assessment("README.md", "INV-TASKS", {"dependencies", "entrypoints"})

    def test_ui_design_and_application_require_record_semantics_and_history(self):
        for path in ["src/ui/AmountInput.tsx", "design/components.md", "src/application/cashflow/project.ts"]:
            self.assert_required_assessment(path, "INV-RECORDS", {"meaning", "history"})

    def test_persistence_portability_and_migrations_require_record_semantics_and_history(self):
        for path in ["src/infrastructure/storage/records.ts",
                     "src/infrastructure/portability/export.ts",
                     "migrations/0001.sql"]:
            self.assert_required_assessment(path, "INV-RECORDS", {"meaning", "history"})

    def test_planned_test_oracle_rules_and_workflow_paths_select_conditions(self):
        for layout in LAYOUTS:
            rules = routing_rules(layout)
            for path, expected in [("tests/fixtures/records.json", "INV-RECORDS"),
                                   ("docs/test-oracles/tax.md", "INV-RECORDS"),
                                   ("docs/rules/2026.md", "INV-RECORDS"),
                                   ("e2e/records.test.ts", "INV-HTTP"),
                                   (".github/workflows/ci.yml", "INV-RELEASE")]:
                with self.subTest(layout=layout, path=path):
                    self.assertIn(expected, guard.affected(rules, [path]))

    def test_t26_http_directory_selects_http_and_release_conditions(self):
        for layout in LAYOUTS:
            with self.subTest(layout=layout):
                selected = guard.affected(routing_rules(layout), ["src/infrastructure/http/server.ts"])
                self.assertTrue({"INV-HTTP", "INV-RELEASE", "INV-LOCK"} <= set(selected))

    def test_pr4_lessons_are_retrievable_without_renumbering(self):
        catalog, ledger, _, _ = load("old")
        candidates = [
            {"invariant_id": "INV-TASKS", "cause_key": "draft-open-entrypoint-coherence", "evidence": "new template evidence"},
            {"invariant_id": "INV-REVIEW", "cause_key": "batch-cause-duplication", "evidence": "new batch evidence"}]
        result = guard.triage(catalog, ledger, candidates)
        self.assertEqual([(r["existing_id"], r["action"]) for r in result],
                         [("PR4-R022", "update-existing"), ("PR4-R023", "update-existing")])
        plan = guard.prepare(catalog, ledger, ["tools/review_guard/guard.py"], BASE)
        history = {f["id"] for context in plan["context"].values() for f in context["history"]}
        self.assertTrue({"PR4-R014", "PR4-R018", "PR4-R022", "PR4-R023"} <= history)

    def test_pr4_lessons_keep_their_split_ids_in_the_new_layout(self):
        # The split (mekiki 3204b4f, split-map.json) moved PR4-R014, R018, R022 and R023 to the global ledger as
        # C-0012, C-0013, C-0017 and C-0018. The catalogue finds them by the hash of the same cause_key.
        catalog, ledger, ids, _ = load("new")
        candidates = [
            {"invariant_id": "INV-TASKS", "cause_key": "draft-open-entrypoint-coherence", "evidence": "new template evidence"},
            {"invariant_id": "INV-REVIEW", "cause_key": "batch-cause-duplication", "evidence": "new batch evidence"}]
        result = guard.triage(catalog, ledger, candidates, ids)
        self.assertEqual([(r["existing_id"], r["action"]) for r in result],
                         [("C-0017", "update-existing"), ("C-0018", "update-existing")])
        plan = filled_plan("new", "tools/review_guard/guard.py")
        result = check("new", plan, ["tools/review_guard/guard.py"])
        self.assertTrue({"C-0012", "C-0013", "C-0017", "C-0018"} <= set(result["causes_not_analyzed"]))
        # A public plan names global invariants by ID only.
        plan["context"] = {"INV-REVIEW": {}}
        with self.assertRaisesRegex(ValueError, "context holds global invariants"):
            check("new", plan, ["tools/review_guard/guard.py"])

    def test_npm_install_policy_selects_release_conditions(self):
        for layout in LAYOUTS:
            with self.subTest(layout=layout):
                self.assertIn("INV-RELEASE", guard.affected(routing_rules(layout), [".npmrc"]))

    def test_source_record_matches_the_copied_files(self):
        record = guard.read_json(root / ".review/mekiki/SOURCE.json")
        digests = {**record["guard"]["sha256"], **record["split"]["sha256"]}
        self.assertIn(".review/mekiki/global-ids.json", digests)
        for rel, digest in digests.items():
            with self.subTest(path=rel):
                # The bytes as Git stores them: a Windows checkout may turn LF into CRLF.
                data = (root / rel).read_bytes().replace(b"\r\n", b"\n")
                self.assertEqual(hashlib.sha256(data).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
