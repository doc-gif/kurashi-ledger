"""Design 8 / 10 stage 4: exercise public CLI behavior with synthetic inputs only."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("stage4_fixture", ROOT / "tests/stage4/fixtures.py")
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)


class Stage4LedgerTests(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory()
        self.addCleanup(self.area.cleanup)
        self.host = Path(self.area.name)
        self.repo = self.host / "public-repo"
        self.repo.mkdir()
        self.private = self.host / "private-host"
        self.private.mkdir()
        self.env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "WINDIR", "LANG") if k in os.environ}
        self.write(self.repo / ".review/causes/invariants.json", fx.LOCAL_CATALOG)
        self.write(self.repo / ".review/causes/findings.json", fx.LOCAL_LEDGER)
        self.write(self.repo / ".review/mekiki/global-ids.json", fx.index())
        self.write(self.private / "invariants.json", fx.GLOBAL_CATALOG)
        self.write(self.private / "findings.json", fx.GLOBAL_LEDGER)
        self.ids = self.repo / ".review/mekiki/global-ids.json"

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def cli(self, command, *args, catalog=None, ledger=None, global_ids=True):
        argv = [sys.executable, "-E", "-s", str(ROOT / "tools/review_guard/guard.py"), command,
                "--catalog", str(catalog or self.repo / ".review/causes/invariants.json"),
                "--ledger", str(ledger or self.repo / ".review/causes/findings.json")]
        if global_ids:
            argv += ["--global-ids", str(self.ids)]
        return subprocess.run(argv + list(map(str, args)), cwd=self.repo, env=self.env,
                              text=True, encoding="utf-8", capture_output=True, timeout=15)

    def ok(self, result, message="S4 guard CLI must consume the global ID catalogue (not implemented yet)"):
        self.assertEqual(result.returncode, 0, message + "\n" + result.stderr)
        return json.loads(result.stdout)

    def complete(self, paths=("local/fence.py",), analyzed=True):
        p = fx.plan(paths, analyzed)
        self.write(self.repo / ".review/plans/SYN-4.json", p)
        self.write(self.repo / "paths.json", list(paths))
        return p

    def check(self, p=None, paths=("local/fence.py",), global_ids=True):
        if p is None:
            self.complete(paths)
        else:
            self.write(self.repo / ".review/plans/SYN-4.json", p)
            self.write(self.repo / "paths.json", list(paths))
        return self.cli("check", "--plan", ".review/plans/SYN-4.json", "--paths-file", "paths.json",
                        "--base-sha", fx.BASE, global_ids=global_ids)

    def export(self, catalog=None, ledger=None):
        return self.cli("export-global-ids", catalog=catalog or self.private / "invariants.json",
                        ledger=ledger or self.private / "findings.json", global_ids=False)

    def test_S4_ID_01_exact_public_catalogue_and_bound_hash(self):
        result = self.ok(self.export(), "S4 export-global-ids CLI is not implemented")
        self.assertEqual(result, fx.index())
        text = json.dumps(result, ensure_ascii=False)
        for value in fx.global_texts() + [f["cause_key"] for f in fx.GLOBAL_LEDGER["findings"]]:
            self.assertNotIn(value, text)
        self.assertNotEqual(result["findings"][0]["cause_key_hash"], result["findings"][1]["cause_key_hash"],
                            "same cause name under different invariants must have different hashes")

    def test_S4_ID_02_export_is_independent_of_private_prose(self):
        before = self.ok(self.export(), "S4 export-global-ids CLI is not implemented")
        catalog, ledger = copy.deepcopy(fx.GLOBAL_CATALOG), copy.deepcopy(fx.GLOBAL_LEDGER)
        for r in catalog["invariants"]:
            r["condition"] = "Entirely different synthetic private condition."
            for s in r["scenarios"]:
                s["question"] = "Entirely different synthetic private question?"
        for f in ledger["findings"]:
            f.update(lesson="Different synthetic private lesson.", sources=["https://other.example.test/private"])
        self.write(self.private / "invariants.json", catalog)
        self.write(self.private / "findings.json", ledger)
        self.assertEqual(self.ok(self.export()), before)

    def test_S4_ID_03_export_refuses_global_related_to_local(self):
        self.ok(self.export(), "S4 export-global-ids CLI is not implemented")
        c = copy.deepcopy(fx.GLOBAL_CATALOG)
        c["invariants"][0]["related"].append("L-A")
        self.write(self.private / "invariants.json", c)
        self.assertEqual(self.export().returncode, 1, "a global related reference cannot point into a repo ledger")

    def test_S4_UNION_01_validate_counts_both_layers(self):
        result = self.ok(self.cli("validate"))
        self.assertEqual((result["invariants"], result["findings"]), (3, 3))

    def test_S4_UNION_02_legacy_without_catalogue_remains_usable(self):
        c, l = fx.merged()
        self.write(self.repo / "full-catalog.json", c)
        self.write(self.repo / "full-ledger.json", l)
        result = self.ok(self.cli("validate", catalog=self.repo / "full-catalog.json",
                                  ledger=self.repo / "full-ledger.json", global_ids=False))
        self.assertEqual((result["invariants"], result["findings"]), (3, 3))

    def test_S4_COMPARE_00_synthetic_plan_oracles_pass_the_unsplit_guard(self):
        c, l = fx.merged()
        self.write(self.repo / ".review/causes/invariants.json", c)
        self.write(self.repo / ".review/causes/findings.json", l)
        for paths in (["local/fence.py"], ["src/read.py"], ["lib/lock.py"],
                      ["src/old.py", "other/new.py"], ["other/note.txt"], []):
            with self.subTest(paths=paths):
                value = self.ok(self.check(paths=paths, global_ids=False))
                self.assertEqual(value["invariants"], fx.selected(paths))
                self.assertEqual(value["causes_not_analyzed"], [])
        for rid, fid in [("G-A", "C-0001"), ("G-B", "C-0002"), ("L-A", "C-0003")]:
            p = fx.plan(["local/fence.py"])
            next(v for v in p["variant_analysis"] if v["invariant_id"] == rid).pop("cause_key")
            self.assertEqual(self.ok(self.check(p, global_ids=False))["causes_not_analyzed"], [fid])

    def test_S4_UNION_03_hash_does_not_accept_another_invariants_cause(self):
        self.ok(self.check())
        p = fx.plan(["local/fence.py"])
        p["variant_analysis"][0]["cause_key"] = "local-fence"
        self.assertEqual(self.check(p).returncode, 1, "cause hashes bind the invariant ID, not just the name")

    def test_S4_PREP_01_public_plan_and_private_reference_are_separate(self):
        self.write(self.repo / "paths.json", ["local/fence.py"])
        output = self.repo / ".review/plans/SYN-4.json"
        private_output = self.private / "reference.json"
        result = self.cli("prepare", "--paths-file", "paths.json", "--base-sha", fx.BASE,
                          "--global-catalog", self.private / "invariants.json",
                          "--global-ledger", self.private / "findings.json",
                          "--private-output", private_output, "--output", output)
        public = self.ok(result, "S4 prepare's two-output CLI is not implemented")
        self.assertTrue(output.is_file())
        self.assertTrue(private_output.is_file())
        saved = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(public, saved)
        self.assertEqual({a["id"] for a in saved["assessments"]}, {"G-A", "G-B", "L-A"})
        self.assertEqual(set(saved["context"]), {"L-A"})
        self.assertIn(fx.LOCAL_CATALOG["invariants"][0]["condition"], json.dumps(saved, ensure_ascii=False))
        private = json.dumps(json.loads(private_output.read_text(encoding="utf-8")), ensure_ascii=False)
        for value in fx.global_texts():
            self.assertIn(value, private)
            self.assertNotIn(value, json.dumps(saved, ensure_ascii=False))
            self.assertNotIn(value, result.stdout)
            for path in self.repo.rglob("*"):
                if path.is_file() and path != self.ids:
                    content = path.read_text(encoding="utf-8")
                    if path.suffix == ".json":
                        content = json.dumps(json.loads(content), ensure_ascii=False)
                    self.assertNotIn(value, content)
        # Fill the generated rows without discarding IDs or scenarios, then verify in catalogue-only CI mode.
        saved["task_id"] = "SYN-4"
        filled = fx.plan(["local/fence.py"])
        for a in saved["assessments"]:
            a.update(next(x for x in filled["assessments"] if x["id"] == a["id"]))
        saved["boundaries"] = filled["boundaries"]
        saved["variant_analysis"] = filled["variant_analysis"]
        self.assertEqual(self.ok(self.check(saved))["invariants"], ["G-A", "G-B", "L-A"])

    def test_S4_PREP_02_private_output_must_be_outside_repo(self):
        self.write(self.repo / "paths.json", ["src/read.py"])
        args = ["--paths-file", "paths.json", "--base-sha", fx.BASE,
                "--global-catalog", self.private / "invariants.json",
                "--global-ledger", self.private / "findings.json"]
        self.ok(self.cli("prepare", *args, "--private-output", self.private / "valid.json"),
                "S4 prepare's private-output boundary is not implemented")
        bad = self.repo / "private-looking/reference.json"
        result = self.cli("prepare", *args, "--private-output", bad)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(bad.exists())
        for value in fx.global_texts():
            self.assertNotIn(value, result.stdout + result.stderr)

    def test_S4_PREP_03_catalogue_only_host_cannot_prepare_private_text(self):
        self.ok(self.cli("validate"))
        self.write(self.repo / "paths.json", ["src/read.py"])
        self.assertEqual(self.cli("prepare", "--paths-file", "paths.json", "--base-sha", fx.BASE,
                                  "--private-output", self.private / "missing.json").returncode, 1)

    def ci(self):
        self.complete()
        # CI needs the changed plan itself as well as the product paths (PR11-R002).
        self.write(self.repo / "paths.json", ["local/fence.py", ".review/plans/SYN-4.json"])
        base = self.host / "trusted-base"
        for source in (ROOT / "tools/review_guard").glob("*.py"):
            target = base / "tools/review_guard" / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for rel in (".review/causes/invariants.json", ".review/causes/findings.json", ".review/mekiki/global-ids.json"):
            self.write(base / rel, json.loads((self.repo / rel).read_text(encoding="utf-8")))
        # Candidate code must never run. All executable input comes from the copied base tool.
        for name in ("guard.py", "ci.py"):
            bad = self.repo / "tools/review_guard" / name
            bad.parent.mkdir(parents=True, exist_ok=True)
            bad.write_text('raise RuntimeError("CANDIDATE_CODE_EXECUTED")', encoding="utf-8")
        def run():
            return subprocess.run([sys.executable, "-E", "-s", str(base / "tools/review_guard/ci.py"),
                                   "--candidate", str(self.repo), "--paths-file", str(self.repo / "paths.json"),
                                   "--base-sha", fx.BASE], cwd=self.repo, env=self.env,
                                  text=True, encoding="utf-8", capture_output=True, timeout=15)
        control = run()
        self.assertEqual(control.returncode, 0,
                         "S4 base CI does not yet load the catalogue alongside the local ledger\n" +
                         control.stdout + control.stderr)
        return run, base

    def test_S4_CI_01_uses_only_public_catalogue_without_global_bodies_or_secrets(self):
        run, _ = self.ci()
        shutil.rmtree(self.private)
        result = run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("CANDIDATE_CODE_EXECUTED", result.stdout + result.stderr)
        self.assertIn("metadata-complete", result.stdout)
        for value in fx.global_texts():
            self.assertNotIn(value, result.stdout + result.stderr)

    def test_S4_CI_02_candidate_cannot_erase_base_global_coverage(self):
        run, _ = self.ci()
        self.write(self.ids, {"schema_version": 1, "invariants": [], "findings": []})
        p = fx.plan(["local/fence.py"])
        p["assessments"] = [a for a in p["assessments"] if a["id"] == "L-A"]
        p["variant_analysis"] = [v for v in p["variant_analysis"] if v["invariant_id"] == "L-A"]
        self.write(self.repo / ".review/plans/SYN-4.json", p)
        self.assertEqual(run().returncode, 1, "candidate catalogue is not the trusted coverage definition")


def add_case(name, fn):
    fn.__name__ = name
    setattr(Stage4LedgerTests, name, fn)


for label, paths in [("global-path", ["src/read.py"]), ("related-cycle", ["lib/lock.py"]),
                     ("local-to-global", ["local/fence.py"]), ("rename-old-and-new", ["src/old.py", "other/new.py"]),
                     ("unrelated", ["other/note.txt"]), ("empty", [])]:
    def compare(self, paths=paths):
        expected = fx.selected(paths)
        split = self.ok(self.check(paths=paths))
        self.assertEqual(split["invariants"], expected, "affected includes both layers and closes related cycles")
        self.assertEqual(split["causes_not_analyzed"], [])
        c, l = fx.merged()
        self.write(self.repo / ".review/causes/invariants.json", c)
        self.write(self.repo / ".review/causes/findings.json", l)
        full = self.ok(self.check(paths=paths, global_ids=False))
        self.assertEqual({k: split[k] for k in ("invariants", "causes_not_analyzed")},
                         {k: full[k] for k in ("invariants", "causes_not_analyzed")})
    add_case("test_S4_COMPARE_01_" + label.replace("-", "_"), compare)


for rid, fid in [("G-A", "C-0001"), ("G-B", "C-0002"), ("L-A", "C-0003")]:
    def missing(self, rid=rid, fid=fid):
        self.ok(self.check())
        p = fx.plan(["local/fence.py"])
        next(v for v in p["variant_analysis"] if v["invariant_id"] == rid).pop("cause_key")
        split = self.ok(self.check(p))
        self.assertEqual(split["causes_not_analyzed"], [fid], "missing global hashes are never a known empty list")
        c, l = fx.merged()
        self.write(self.repo / ".review/causes/invariants.json", c)
        self.write(self.repo / ".review/causes/findings.json", l)
        full = self.ok(self.check(p, global_ids=False))
        self.assertEqual(split["causes_not_analyzed"], full["causes_not_analyzed"])
    add_case("test_S4_COMPARE_02_missing_" + rid.replace("-", "_"), missing)


def invalid_plan(mode):
    p = fx.plan(["local/fence.py"])
    if mode == "unknown-assessment": p["assessments"][0]["id"] = "G-MISSING"
    elif mode == "unknown-scenario": p["assessments"][0]["checks"][0]["id"] = "missing-scenario"
    elif mode == "missing-global-assessment": p["assessments"].pop(0)
    elif mode == "missing-global-scenario": p["assessments"][0]["checks"] = []
    elif mode == "unknown-variant-invariant": p["variant_analysis"][0]["invariant_id"] = "G-MISSING"
    elif mode == "unknown-global-cause": p["variant_analysis"][0]["cause_key"] = "fictional-missing"
    elif mode == "duplicate-global-cause": p["variant_analysis"].append(copy.deepcopy(p["variant_analysis"][0]))
    elif mode == "global-context": p["context"]["G-A"] = {"condition": fx.GLOBAL_CATALOG["invariants"][0]["condition"]}
    elif mode == "global-context-empty": p["context"]["G-B"] = {}
    return p


for mode in ["unknown-assessment", "unknown-scenario", "missing-global-assessment", "missing-global-scenario",
             "unknown-variant-invariant", "unknown-global-cause", "duplicate-global-cause", "global-context", "global-context-empty"]:
    def reject(self, mode=mode):
        self.ok(self.check()) # positive control: an unsupported option must never masquerade as a valid refusal
        result = self.check(invalid_plan(mode))
        self.assertEqual(result.returncode, 1, mode + " must fail validation, not argument parsing")
    add_case("test_S4_REJECT_01_" + mode.replace("-", "_"), reject)


for mode in ["invariant-collision", "finding-collision", "cause-collision", "unknown-local-related",
             "global-to-local-related", "unknown-global-related", "unknown-finding-invariant", "invalid-hash", "duplicate-global-id"]:
    def reject_union(self, mode=mode):
        self.ok(self.cli("validate"))
        c, l, ids = copy.deepcopy(fx.LOCAL_CATALOG), copy.deepcopy(fx.LOCAL_LEDGER), fx.index()
        if mode == "invariant-collision": c["invariants"].append(copy.deepcopy(fx.GLOBAL_CATALOG["invariants"][0]))
        elif mode == "finding-collision": l["findings"][0]["id"] = "C-0001"
        elif mode == "cause-collision": l["findings"].append(dict(copy.deepcopy(fx.GLOBAL_LEDGER["findings"][0]), id="C-0099"))
        elif mode == "unknown-local-related": c["invariants"][0]["related"] = ["G-MISSING"]
        elif mode == "global-to-local-related": ids["invariants"][0]["related"] = ["L-A"]
        elif mode == "unknown-global-related": ids["invariants"][0]["related"] = ["G-MISSING"]
        elif mode == "unknown-finding-invariant": ids["findings"][0]["invariant_id"] = "G-MISSING"
        elif mode == "invalid-hash": ids["findings"][0]["cause_key_hash"] = "not-a-sha256"
        elif mode == "duplicate-global-id": ids["invariants"].append(copy.deepcopy(ids["invariants"][0]))
        self.write(self.repo / ".review/causes/invariants.json", c)
        self.write(self.repo / ".review/causes/findings.json", l)
        self.write(self.ids, ids)
        self.assertEqual(self.cli("validate").returncode, 1, mode + " must not be accepted or silently ignored")
    add_case("test_S4_REJECT_02_" + mode.replace("-", "_"), reject_union)
