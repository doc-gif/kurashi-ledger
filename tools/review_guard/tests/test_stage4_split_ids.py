"""Design 8 cause ID contract; public CLI only, entirely synthetic ledgers."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class Stage4SplitIdTests(unittest.TestCase):
    def setUp(self):
        area = tempfile.TemporaryDirectory()
        self.addCleanup(area.cleanup)
        self.repo = Path(area.name)
        self.catalog = {"schema_version": 1, "invariants": [{"id": "L-SYN", "paths": ["local/*"],
            "related": [], "condition": "The fictional local garden retains its wooden gate.",
            "scenarios": [{"id": "stable", "question": "Does the synthetic garden retain its independent gate?"}]}]}
        self.ledger = {"schema_version": 1, "findings": [{"id": "C-0001", "invariant_id": "L-SYN",
            "cause_key": "fictional-gate", "lesson": "The synthetic local fence keeps its painted gate.",
            "sources": ["https://github.com/synthetic-project/ledger/pull/902#issuecomment-70002"]}]}
        self.ids = {"schema_version": 1, "invariants": [{"id": "G-SYN", "paths": ["global/*"], "related": [],
            "scenarios": [{"id": "stable"}]}], "findings": [{"id": "C-0002", "invariant_id": "G-SYN",
            "cause_key_hash": hashlib.sha256(b"G-SYN\nfictional-moon").hexdigest()}]}
        self.env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "WINDIR", "LANG") if k in os.environ}

    def write(self, rel, value):
        p = self.repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def validate(self, ledger=None, ids=None):
        self.write("local.json", self.catalog)
        self.write("findings.json", ledger or self.ledger)
        self.write("ids.json", ids or self.ids)
        return subprocess.run([sys.executable, "-E", "-s", str(ROOT / "tools/review_guard/guard.py"),
            "validate", "--catalog", "local.json", "--ledger", "findings.json", "--global-ids", "ids.json"],
            cwd=self.repo, env=self.env, text=True, encoding="utf-8", capture_output=True, timeout=15)

    def control(self):
        r = self.validate()
        self.assertEqual(r.returncode, 0, "valid synthetic C IDs must be accepted before a negative case\n" + r.stderr)
        x = json.loads(r.stdout)
        self.assertEqual((x["invariants"], x["findings"]), (2, 2))

    def paths_config(self, values):
        config = self.repo / ".review/config.toml"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text("[causes.paths]\n" + "\n".join(k + " = " + json.dumps(v) for k, v in values.items()) + "\n")

    def check(self, paths, selected):
        self.write("local.json", self.catalog)
        self.write("findings.json", self.ledger)
        self.write("ids.json", self.ids)
        rules = {"L-SYN": "fictional-gate", "G-SYN": "fictional-moon"}
        p = {"schema_version": 2, "task_id": "SYN-PATHS", "base_sha": "a" * 40,
            "planned_paths": paths, "conflicts": [], "context": {},
            "assessments": [{"id": rid, "disposition": "preserve", "reason": "Check the synthetic path boundary.",
                "checks": [{"id": "stable", "method": "Observe independent fictional gates.",
                            "expected": "The same painted panel remains."}]} for rid in selected],
            "boundaries": [{"id": "B1", "direction": "entry", "location": paths[0], "data": "fictional input",
                            "trust": "untrusted", "control": "Retain the synthetic gate."}] if selected else [],
            "variant_analysis": [{"invariant_id": rid, "cause_key": rules[rid],
                "pattern": "Check all fictional gates.", "places": [{"location": paths[0], "result": "Panel retained."}]}
                for rid in selected]}
        self.write("SYN-PATHS.json", p)
        self.write("paths.json", paths)
        return subprocess.run([sys.executable, "-E", "-s", str(ROOT / "tools/review_guard/guard.py"), "check",
            "--catalog", "local.json", "--ledger", "findings.json", "--global-ids", "ids.json",
            "--plan", "SYN-PATHS.json", "--paths-file", "paths.json", "--base-sha", "a" * 40],
            cwd=self.repo, env=self.env, text=True, encoding="utf-8", capture_output=True, timeout=15)

    def test_S4S_PATHS_added_glob_selects_common_invariant(self):
        self.control()
        self.paths_config({"G-SYN": ["extra/*"]})
        r = self.check(["extra/read.py"], ["G-SYN"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["invariants"], ["G-SYN"])

    def test_S4S_PATHS_empty_extension_cannot_remove_common_glob(self):
        self.control()
        self.paths_config({"G-SYN": []})
        r = self.check(["global/read.py"], ["G-SYN"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["invariants"], ["G-SYN"])

    def test_S4S_PATHS_empty_union_is_reported_without_selecting_a_plan(self):
        self.control()
        self.ids["invariants"][0]["paths"] = []
        self.paths_config({"G-SYN": []})
        r = self.check(["other/read.py"], [])
        self.assertEqual(r.returncode, 0, r.stderr)
        x = json.loads(r.stdout)
        self.assertEqual(x["invariants"], [])
        self.assertEqual(x["empty_global_paths"], ["G-SYN"], "test-side name for the required summary input")

    def test_S4S_PATHS_CI_uses_base_config_when_candidate_erases_its_extension(self):
        self.control()
        base = self.repo / "trusted-base"
        candidate = self.repo / "candidate"
        for source in (ROOT / "tools/review_guard").glob("*.py"):
            target = base / "tools/review_guard" / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for root in (base, candidate):
            for rel, value in [(".review/causes/invariants.json", self.catalog),
                               (".review/causes/findings.json", self.ledger),
                               (".review/mekiki/global-ids.json", self.ids)]:
                self.write(str((root / rel).relative_to(self.repo)), value)
            config = root / ".review/config.toml"
            config.write_text('[causes.paths]\nG-SYN = ["extra/*"]\n')
        p = {"schema_version": 2, "task_id": "SYN-CI", "base_sha": "a" * 40,
             "planned_paths": ["extra/read.py", ".review/config.toml"], "conflicts": [], "context": {},
             "assessments": [{"id": "G-SYN", "disposition": "preserve", "reason": "Synthetic base path proof.",
                "checks": [{"id": "stable", "method": "Two fictional gates.", "expected": "Same panel remains."}]}],
             "boundaries": [{"id": "B1", "direction": "entry", "location": "extra/read.py", "data": "synthetic input",
                "trust": "untrusted", "control": "Keep a stable gate."}],
             "variant_analysis": [{"invariant_id": "G-SYN", "cause_key": "fictional-moon", "pattern": "Other gates.",
                "places": [{"location": "extra/read.py", "result": "Retained."}]}]}
        self.write("candidate/.review/plans/SYN-CI.json", p)
        self.write("candidate/paths.json", ["extra/read.py", ".review/plans/SYN-CI.json", ".review/config.toml"])
        def run():
            return subprocess.run([sys.executable, "-E", "-s", str(base / "tools/review_guard/ci.py"),
                "--candidate", str(candidate), "--paths-file", str(candidate / "paths.json"), "--base-sha", "a" * 40],
                cwd=candidate, env=self.env, text=True, encoding="utf-8", capture_output=True, timeout=15)
        control = run()
        self.assertEqual(control.returncode, 0, "valid base-config control must pass before the tampered candidate\n" + control.stderr)
        (candidate / ".review/config.toml").write_text('[causes.paths]\nG-SYN = []\n')
        self.assertEqual(run().returncode, 0, "candidate removal must not change trusted base path selection")
        p["assessments"], p["variant_analysis"] = [], []
        self.write("candidate/.review/plans/SYN-CI.json", p)
        self.assertEqual(run().returncode, 1, "erased candidate config cannot hide a missing base-selected assessment")


def add_case(name, fn):
    fn.__name__ = name
    setattr(Stage4SplitIdTests, name, fn)


for value in ("C-0001", "C-9999", "C-10000", "C-10001", "C-99999"):
    def valid(self, value=value):
        self.control()
        l = copy.deepcopy(self.ledger)
        l["findings"][0]["id"] = value
        self.assertEqual(self.validate(l).returncode, 0, value)
    add_case("test_S4S_ID_canonical_" + value.replace("-", "_"), valid)

INVALID = {"zero": "C-0000", "short": "C-1", "long_zero": "C-00001", "padded_large": "C-01234",
    "old_pr": "PR901-R001", "space_before": " C-0001", "space_after": "C-0001 ",
    "newline": "C-0001\n", "negative": "C--001", "decimal": "C-1.0", "unicode": "C-０００１"}
for label, value in INVALID.items():
    for layer in ("project", "global"):
        def invalid(self, value=value, layer=layer):
            self.control()
            l, ids = copy.deepcopy(self.ledger), copy.deepcopy(self.ids)
            (l if layer == "project" else ids)["findings"][0]["id"] = value
            r = self.validate(l, ids)
            self.assertEqual(r.returncode, 1, "noncanonical ID is a validation refusal, never an argument error: " + repr(value))
        add_case("test_S4S_ID_reject_" + layer + "_" + label, invalid)


def collision(self):
    self.control()
    ids = copy.deepcopy(self.ids)
    ids["findings"][0]["id"] = "C-0001"
    self.assertEqual(self.validate(ids=ids).returncode, 1, "same C ID in project and public index is forbidden")
add_case("test_S4S_ID_project_global_collision", collision)

for label, config in {"unknown_invariant": {"G-MISSING": ["extra/*"]},
                      "project_invariant": {"L-SYN": ["extra/*"]},
                      "scalar_glob": {"G-SYN": "extra/*"},
                      "numeric_glob": {"G-SYN": [17]}}.items():
    def invalid_paths(self, config=config):
        self.control()
        self.paths_config({"G-SYN": ["extra/*"]})
        self.assertEqual(self.check(["global/read.py"], ["G-SYN"]).returncode, 0)
        self.paths_config(config)
        self.assertEqual(self.check(["global/read.py"], ["G-SYN"]).returncode, 1,
                         "invalid path extension is refused instead of silently ignored")
    add_case("test_S4S_PATHS_reject_" + label, invalid_paths)
