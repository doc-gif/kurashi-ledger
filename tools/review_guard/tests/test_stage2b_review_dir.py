"""Stage 2b CLI contract (§10): synthetic trees only, existing tests unchanged."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class ReviewDirectoryContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mekiki-stage2b-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "base"
        self.candidate = self.root / "candidate"
        self.code = self.base / "tools/review_guard"
        self.code.mkdir(parents=True)
        for name in ("guard.py", "ci.py"):
            shutil.copyfile(Path(__file__).parents[1] / name, self.code / name)
        self.catalog = {"schema_version": 1, "invariants": []}
        self.ledger = {"schema_version": 1, "findings": []}
        self.plan = {"schema_version": 1, "task_id": "SYNTHETIC", "base_sha": "a" * 40,
                     "planned_paths": ["src/example.py"], "conflicts": [], "assessments": [],
                     "boundaries": [], "variant_analysis": [], "causes_not_analyzed": []}

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def fixture(self, review_dir):
        for tree in (self.base, self.candidate):
            self.write(tree / review_dir / "invariants.json", self.catalog)
            self.write(tree / review_dir / "findings.json", self.ledger)
        self.write(self.candidate / review_dir / "plans/SYNTHETIC.json", self.plan)
        self.write(self.root / "paths.json", ["src/example.py", review_dir + "/plans/SYNTHETIC.json"])
        # A decoy proves the selected directory is used; the default must not rescue custom-dir failures.
        if review_dir != ".review":
            for tree in (self.base, self.candidate):
                self.write(tree / ".review/invariants.json", {"invalid": "synthetic decoy"})
                self.write(tree / ".review/findings.json", {"invalid": "synthetic decoy"})

    def guard(self, review_dir, flags):
        return subprocess.run([sys.executable, "-E", "-s", str(self.code / "guard.py"), "check",
                               *flags, "--paths-file", str(self.root / "paths.json"), "--base-sha", "a" * 40,
                               "--plan", review_dir + "/plans/SYNTHETIC.json"],
                              cwd=self.candidate, text=True, capture_output=True)

    def ci(self, flags):
        return subprocess.run([sys.executable, "-E", "-s", str(self.code / "ci.py"), *flags,
                               "--candidate", str(self.candidate), "--paths-file", str(self.root / "paths.json"),
                               "--base-sha", "a" * 40], cwd=self.base, text=True, capture_output=True)

    def assert_complete(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("metadata-complete", result.stdout)

    def test_S2B_DIR_01_default_guard_preserves_dot_review(self):
        self.fixture(".review")
        self.assert_complete(self.guard(".review", []))

    def test_S2B_DIR_02_explicit_default_guard_matches_implicit(self):
        self.fixture(".review")
        implicit = self.guard(".review", [])
        explicit = self.guard(".review", ["--review-dir", ".review"])
        self.assert_complete(explicit)
        self.assertEqual(json.loads(explicit.stdout), json.loads(implicit.stdout))

    def test_S2B_DIR_03_custom_guard_selects_catalog_ledger_and_plan(self):
        self.fixture("audit/review")
        self.assert_complete(self.guard("audit/review", ["--review-dir", "audit/review"]))
        # A plan from the old directory must not count as the selected directory's plan.
        self.write(self.root / "paths.json", ["src/example.py", ".review/plans/SYNTHETIC.json"])
        result = self.guard("audit/review", ["--review-dir", "audit/review"])
        self.assertNotEqual(result.returncode, 0)

    def test_S2B_DIR_04_default_ci_preserves_trusted_base(self):
        self.fixture(".review")
        self.assert_complete(self.ci([]))

    def test_S2B_DIR_05_custom_ci_reads_only_the_trusted_base_code(self):
        self.fixture("audit/review")
        candidate_code = self.candidate / "tools/review_guard"
        candidate_code.mkdir(parents=True)
        for name in ("guard.py", "ci.py"):
            (candidate_code / name).write_text('raise RuntimeError("candidate code executed")', encoding="utf-8")
        self.assert_complete(self.ci(["--review-dir", "audit/review"]))

    def test_S2B_DIR_06_custom_ci_does_not_let_candidate_erase_base_requirements(self):
        self.fixture("audit/review")
        required = {"schema_version": 1, "invariants": [
            {"id": "synthetic-safety", "condition": "preserve data", "paths": ["src/*"], "related": [],
             "scenarios": [{"id": "restore", "question": "is data preserved?"}]}]}
        self.write(self.base / "audit/review/invariants.json", required)
        result = self.ci(["--review-dir", "audit/review"])
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("missing invariant", result.stderr)
