"""PR #12 red team (RT-3..RT-6): synthetic data only."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/review_guard"))
import guard  # noqa: E402

spec = importlib.util.spec_from_file_location("stage4_fixture", ROOT / "tests/stage4/fixtures.py")
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)


class Stage4RedTeam(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory()
        self.addCleanup(self.area.cleanup)
        self.host = Path(self.area.name)
        self.repo = self.host / "repo"
        self.private = self.host / "private"
        for path, data in [(self.repo / ".review/causes/invariants.json", fx.LOCAL_CATALOG),
                           (self.repo / ".review/causes/findings.json", fx.LOCAL_LEDGER),
                           (self.repo / ".review/mekiki/global-ids.json", fx.index()),
                           (self.repo / "paths.json", ["src/read.py"]),
                           (self.private / "invariants.json", fx.GLOBAL_CATALOG),
                           (self.private / "findings.json", fx.GLOBAL_LEDGER)]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def prepare(self, cwd, private_output):
        r = self.repo
        return subprocess.run([sys.executable, "-E", "-s", str(ROOT / "tools/review_guard/guard.py"), "prepare",
                               "--catalog", r / ".review/causes/invariants.json", "--ledger", r / ".review/causes/findings.json",
                               "--global-ids", r / ".review/mekiki/global-ids.json", "--paths-file", r / "paths.json",
                               "--base-sha", fx.BASE, "--global-catalog", self.private / "invariants.json",
                               "--global-ledger", self.private / "findings.json", "--private-output", private_output],
                              cwd=cwd, text=True, capture_output=True, timeout=15,
                              env={k: os.environ[k] for k in ("PATH", "LANG") if k in os.environ})

    def test_RT3_private_output_inside_the_repo_is_refused_from_any_working_directory(self):
        control = self.prepare(self.repo, self.private / "reference.json")
        self.assertEqual(control.returncode, 0, control.stderr)
        for cwd in (self.repo / ".review", self.host, self.private):
            target = self.repo / ("ref-" + cwd.name + ".json")
            result = self.prepare(cwd, target)
            self.assertEqual(result.returncode, 1, str(cwd))
            self.assertFalse(target.exists())

    def test_RT3_a_case_variant_of_the_repository_path_is_refused_where_the_file_system_ignores_case(self):
        variant = Path(str(self.repo).replace("/repo", "/REPO"))
        if not variant.exists():  # a case-sensitive file system: the variant is another directory
            return
        target = variant / "ref.json"
        self.assertEqual(self.prepare(self.private, target).returncode, 1)
        self.assertFalse((self.repo / "ref.json").exists())

    def test_RT4_a_project_finding_cannot_state_a_cause_hash(self):
        ledger = copy.deepcopy(fx.LOCAL_LEDGER)
        ledger["findings"][0]["cause_key_hash"] = "0" * 64
        with self.assertRaises(guard.Invalid):
            guard.validate(fx.LOCAL_CATALOG, ledger, fx.index())
        with self.assertRaises(guard.Invalid):
            guard.validate(fx.LOCAL_CATALOG, ledger)

    def test_RT5_triage_matches_both_layers(self):
        out = guard.triage(fx.LOCAL_CATALOG, fx.LOCAL_LEDGER, [
            {"invariant_id": "G-A", "cause_key": "fictional-identity", "evidence": "synthetic"},
            {"invariant_id": "G-A", "cause_key": "fictional-new", "evidence": "synthetic"},
            {"invariant_id": "L-A", "cause_key": "local-fence", "evidence": "synthetic"},
        ], fx.index())
        self.assertEqual([(o["existing_id"], o["action"]) for o in out],
                         [("C-0001", "update-existing"), (None, "propose-new"), ("C-0003", "update-existing")])

    def test_RT6_a_project_finding_on_a_global_invariant_reaches_the_reference(self):
        ledger = copy.deepcopy(fx.LOCAL_LEDGER)
        ledger["findings"].append({"id": "C-0004", "invariant_id": "G-A", "cause_key": "local-on-global",
                                   "lesson": "A synthetic project lesson on a global rule.",
                                   "sources": ["https://synthetic-local.example.test/lesson"]})
        public, private = guard.prepare_split(fx.LOCAL_CATALOG, ledger, ["src/read.py"], fx.BASE, fx.index(),
                                              (fx.GLOBAL_CATALOG, fx.GLOBAL_LEDGER))
        self.assertNotIn("G-A", public["context"])
        self.assertIn("A synthetic project lesson on a global rule.", json.dumps(private))


if __name__ == "__main__":
    unittest.main()
