"""ADR-0007 components (G1-G7): changing a component's files selects its review points."""
import importlib.util
from pathlib import Path
import unittest

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("guard", root / "tools/review_guard/guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

COMPONENTS = {"INV-G1-PATH", "INV-G2-STRUCTURE", "INV-G3-LOCK", "INV-G4-MAINTENANCE",
              "INV-G5-MODE", "INV-G6-ARTIFACTS", "INV-G7-HTTP"}


class ComponentRoutingTests(unittest.TestCase):
    def setUp(self):
        self.catalog = guard.read_json(root / ".review/invariants.json")
        self.ledger = guard.read_json(root / ".review/findings.json")
        self.rules, _ = guard.validate(self.catalog, self.ledger)

    def selected(self, path):
        return set(guard.affected(self.rules, [path]))

    def test_every_component_is_registered_with_the_operations_scenario(self):
        self.assertTrue(COMPONENTS <= self.rules.keys())
        for rid in COMPONENTS:
            with self.subTest(rid=rid):
                self.assertIn("operations", {s["id"] for s in self.rules[rid]["scenarios"]})

    def test_adr_0007_selects_every_component(self):
        self.assertTrue(COMPONENTS <= self.selected("docs/adr/0007-shared-safety-checks.md"))

    def test_component_files_select_their_component(self):
        for path, expected in [
                ("docs/adr/0006-data-location-backup-encryption.md",
                 {"INV-G1-PATH", "INV-G2-STRUCTURE", "INV-G3-LOCK", "INV-G4-MAINTENANCE", "INV-G5-MODE"}),
                ("src/infrastructure/storage/root.ts",
                 {"INV-G1-PATH", "INV-G2-STRUCTURE", "INV-G3-LOCK", "INV-G4-MAINTENANCE"}),
                ("src/infrastructure/portability/restore.ts",
                 {"INV-G1-PATH", "INV-G2-STRUCTURE", "INV-G3-LOCK", "INV-G4-MAINTENANCE"}),
                ("migrations/0002.sql", {"INV-G2-STRUCTURE"}),
                ("src/application/startup.ts", {"INV-G5-MODE"}),
                ("scripts/lib/install-record.ts", {"INV-G6-ARTIFACTS"}),
                ("docs/adr/0008-install-record.md", {"INV-G6-ARTIFACTS"}),
                ("package-lock.json", {"INV-G6-ARTIFACTS"}),
                ("src/infrastructure/http/server.ts", {"INV-G7-HTTP"}),
                ("docs/adr/0003-local-http-boundary.md", {"INV-G7-HTTP"}),
                ("src/start.ts", {"INV-G5-MODE", "INV-G6-ARTIFACTS", "INV-G7-HTTP"})]:
            with self.subTest(path=path):
                selected = self.selected(path)
                self.assertTrue(expected <= selected, expected - selected)

    def test_components_pull_in_the_existing_conditions(self):
        for path, expected in [("src/infrastructure/http/server.ts", {"INV-HTTP"}),
                               ("scripts/lib/install-record.ts", {"INV-RELEASE"}),
                               ("src/infrastructure/storage/lock.ts", {"INV-LOCK", "INV-ROOT", "INV-STORAGE"})]:
            with self.subTest(path=path):
                self.assertTrue(expected <= self.selected(path))

    def test_unrelated_paths_do_not_select_components(self):
        for path in ["src/domain/records/fact.ts", "design/tokens.json", "docs/contracts/records.md"]:
            with self.subTest(path=path):
                self.assertEqual(self.selected(path) & COMPONENTS, set())

    def test_a_plan_without_the_component_assessment_is_rejected(self):
        base = "a" * 40
        plan = guard.prepare(self.catalog, self.ledger, ["src/infrastructure/http/server.ts"], base)
        plan["task_id"] = "OPS-ROUTING"
        for assessment in plan["assessments"]:
            assessment["reason"] = "Synthetic routing fixture preserves the selected condition"
            for check in assessment["checks"]:
                check.update(method="inspect synthetic routing fixture", expected="condition remains covered")
        self.assertEqual(guard.check(self.catalog, self.ledger, plan, ["src/infrastructure/http/server.ts"],
                                     base)["result"], "metadata-complete")
        plan["assessments"] = [a for a in plan["assessments"] if a["id"] != "INV-G7-HTTP"]
        with self.assertRaisesRegex(ValueError, "missing invariant assessments:.*INV-G7-HTTP"):
            guard.check(self.catalog, self.ledger, plan, ["src/infrastructure/http/server.ts"], base)


if __name__ == "__main__":
    unittest.main()
