import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class TrustedBaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "base"
        self.candidate = self.root / "candidate"
        code = self.base / "tools/review_guard"
        code.mkdir(parents=True)
        for name in ("guard.py", "ci.py"):
            shutil.copyfile(Path(__file__).parents[1] / name, code / name)
        self.catalog = {"schema_version": 1, "invariants": [
            {"id": "safety", "condition": "must preserve", "paths": ["src/*"], "related": [],
             "scenarios": [{"id": "restore", "question": "does restore preserve data?"}]}]}
        self.ledger = {"schema_version": 1, "findings": []}
        for folder in (self.base, self.candidate):
            self.write(folder / ".review/invariants.json", self.catalog)
            self.write(folder / ".review/findings.json", self.ledger)
        self.paths = ["src/save.py", ".review/plans/OPS.json"]
        self.plan = {"schema_version": 1, "task_id": "OPS", "base_sha": "a" * 40,
                     "planned_paths": ["src/save.py"], "conflicts": [], "assessments": [
                         {"id": "safety", "disposition": "preserve", "reason": "whole restore checked",
                          "checks": [{"id": "restore", "method": "synthetic interrupted restore",
                                      "expected": "old data remains usable"}]}]}
        self.write(self.candidate / ".review/plans/OPS.json", self.plan)

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def run_ci(self):
        self.write(self.root / "paths.json", self.paths)
        return subprocess.run([sys.executable, "-E", "-s", str(self.base / "tools/review_guard/ci.py"),
                               "--candidate", str(self.candidate), "--paths-file", str(self.root / "paths.json"),
                               "--base-sha", "a" * 40], text=True, capture_output=True)

    def test_candidate_policy_cannot_erase_base_requirements(self):
        self.write(self.candidate / ".review/invariants.json", {"schema_version": 1, "invariants": []})
        self.plan["assessments"] = []
        self.write(self.candidate / ".review/plans/OPS.json", self.plan)
        result = self.run_ci()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing invariant", result.stderr)

    def test_trusted_base_accepts_complete_metadata(self):
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("metadata-complete", result.stdout)

    def test_policy_removed_is_reported_even_when_base_plan_is_complete(self):
        self.write(self.candidate / ".review/invariants.json", {"schema_version": 1, "invariants": []})
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.splitlines()[0])
        self.assertEqual(report["policy_changes_to_review"][0]["id"], "safety")
        self.assertIsNone(report["policy_changes_to_review"][0]["after"])

    def test_candidate_code_is_not_imported_or_executed(self):
        code = self.candidate / "tools/review_guard"
        code.mkdir(parents=True)
        for name in ("guard.py", "ci.py"):
            (code / name).write_text('raise RuntimeError("candidate code was executed")', encoding="utf-8")
        result = self.run_ci()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.plan["assessments"] = []
        self.write(self.candidate / ".review/plans/OPS.json", self.plan)
        result = self.run_ci()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing invariant", result.stderr)

    def test_no_plan_or_multiple_plans_rejected(self):
        for paths in (["src/save.py"], self.paths + [".review/plans/other.json"]):
            self.paths = paths
            result = self.run_ci()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("exactly one", result.stderr)

    def test_plan_cannot_follow_symlink_outside_candidate(self):
        plan = self.candidate / ".review/plans/OPS.json"
        plan.unlink()
        outside = self.root / "outside.json"
        self.write(outside, self.plan)
        try:
            plan.symlink_to(outside)
        except OSError:
            self.skipTest("symlink creation unavailable on this host")
        result = self.run_ci()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("escapes checkout", result.stderr)
