"""Issue #46 CI integration contract using only synthetic repositories.

Run only in a secret-free, credential-free sandbox. This author did not run it.
Every subprocess executes the actual Python files copied from this repository
to the trusted base tree. Candidate Python is never executed or imported.
The copy includes future modules and lib dependencies, but excludes tests.

CLI arguments are solely the public README's ci/check/prepare/export-global-ids
arguments. The proposed allowlist lives at .review/mekiki/plan-rewrites.json;
candidate split-map bytes live at .review/mekiki/split-map.json. CI alone tests
the count/old-base exemptions. Individual check uses a single changed plan and
that plan's base_sha, preserving the existing guard CLI contract.

Publication checking belongs to the host before push. Host material is used
only to generate fixture metadata with export-global-ids/prepare, and is removed
before CI runs. CI receives no host paths or shared-text publication callback.
Its free-text responsibility is to reject changes outside the named locations.
Public GitHub runners are not assumed to possess any private reference text.

Metadata JSON envelopes and split-map nested fields not documented in README
remain fixture proposals. Actual export-global-ids and prepare generate their
outputs during setup so those internal output formats are not reverse-engineered.
Successful actual prepare/check/CI compatibility remains unverified until run.
The owner requires allowlist deletion in rewrite PRs (comment 6116585402).
The fixed positive CI fixture keeps history empty; API cases cover its mapping.
"""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from plan_rewrite_fixtures import (
    BASE_SHA, OLD_SHA, PLAN_A, PLAN_B, OPS_LEDGER, SHARED_TEXT,
    encode_map, fallback, make_batch, split_map, variant,
)


MAP_PATH = ".review/mekiki/split-map.json"
LIST_PATH = ".review/mekiki/plan-rewrites.json"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def synthetic_catalog(invariant_id, condition, paths, question):
    # Public docs name these invariant/scenario fields, but do not publish a
    # full input JSON envelope. This envelope is explicitly unverified.
    return {"schema_version": 1, "invariants": [{
        "id": invariant_id, "condition": condition, "paths": paths,
        "related": [], "scenarios": [{"id": "SYNTHETIC-1", "question": question}],
    }]}


class PlanRewriteCIIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="issue46-ci-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.base = self.root / "base"
        self.candidate = self.root / "candidate"
        self.host = self.root / "host"
        self.inputs = self.root / "inputs"
        self.base.mkdir()
        self.candidate.mkdir()
        self.host.mkdir()
        self.inputs.mkdir()
        self.env = {
            "PATH": os.defpath, "LANG": "C.UTF-8", "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
        }
        source_tools = Path(__file__).resolve().parents[1]
        # Missing rewrite implementation must reach the real CI behavior,
        # rather than abort fixture setup before the integration check.
        for required in ("guard.py", "ci.py"):
            self.assertTrue((source_tools / required).is_file(), "Actual base module is required: " + required)
        for source in source_tools.rglob("*.py"):
            relative = source.relative_to(source_tools)
            if "tests" in relative.parts or "__pycache__" in relative.parts:
                continue
            destination = self.base / "tools/review_guard" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        self.guard = self.base / "tools/review_guard/guard.py"
        self.ci = self.base / "tools/review_guard/ci.py"
        # Candidate modules are tripwires, never substitutes for trusted code.
        for module_name in ("guard.py", "ci.py", "plan_rewrites.py"):
            path = self.candidate / "tools/review_guard" / module_name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("raise SystemExit(99)  # candidate code must never execute\n", encoding="utf-8")

    def command(self, script, *arguments, cwd=None):
        return subprocess.run(
            [sys.executable, str(script), *map(str, arguments)],
            cwd=cwd or self.base, env=self.env, text=True,
            encoding="utf-8", capture_output=True, timeout=30, check=False,
        )

    def expect_exit(self, result, expected):
        self.assertEqual(result.returncode, expected, result.stdout + "\n" + result.stderr)

    def prepare_trees(self, paths=(PLAN_A, PLAN_B)):
        local_catalog = synthetic_catalog(
            "INV-OLD", "Keep the synthetic project boundary.", ["src/synthetic.py", MAP_PATH],
            "Can the project fixture preserve its own expected outcomes?",
        )
        local_ledger = {"schema_version": 1, "findings": []}
        shared_catalog = synthetic_catalog(
            "INV-GLOBAL", SHARED_TEXT, [],
            "Do shared policies reject invented unsafe requests?",
        )
        # All text is invented for this test. No nonpublic text is loaded.
        shared_ledger = {"schema_version": 1, "findings": [{
            "id": "C-0001", "invariant_id": "INV-GLOBAL", "cause_key": "new-a",
            "lesson": SHARED_TEXT, "sources": ["https://example.invalid/synthetic-shared-source"],
        }]}
        self.host_catalog = self.host / "invariants.json"
        self.host_ledger = self.host / "findings.json"
        write_json(self.host_catalog, shared_catalog)
        write_json(self.host_ledger, shared_ledger)
        for tree in (self.base, self.candidate):
            write_json(tree / ".review/causes/invariants.json", local_catalog)
            write_json(tree / ".review/causes/findings.json", local_ledger)
        self.config = '[causes.paths]\n"INV-GLOBAL" = ["src/synthetic.py", "' + MAP_PATH + '"]\n'
        for tree in (self.base, self.candidate):
            (tree / ".review/config.toml").write_text(self.config, encoding="utf-8")
        exported = self.command(self.guard, "export-global-ids", "--catalog", self.host_catalog, "--ledger", self.host_ledger)
        self.expect_exit(exported, 0)
        ids = json.loads(exported.stdout)
        for tree in (self.base, self.candidate):
            write_json(tree / ".review/mekiki/global-ids.json", ids)
        planned_file = self.inputs / "planned-paths.json"
        write_json(planned_file, ["src/synthetic.py", MAP_PATH])
        self.paths = tuple(paths)
        self.actual_paths = [*paths, MAP_PATH, LIST_PATH]
        self.actual_file = self.inputs / "actual-paths.json"
        write_json(self.actual_file, self.actual_paths)
        self.originals = {}
        self.rewrites = {}
        for path in paths:
            output = self.base / path
            output.parent.mkdir(parents=True, exist_ok=True)
            prepared = self.command(
                self.guard, "prepare", "--catalog", self.base / ".review/causes/invariants.json",
                "--ledger", self.base / ".review/causes/findings.json",
                "--global-ids", self.base / ".review/mekiki/global-ids.json",
                "--global-catalog", self.host_catalog, "--global-ledger", self.host_ledger,
                "--config", self.base / ".review/config.toml",
                "--private-output", self.host / (output.stem + "-reference.json"),
                "--paths-file", planned_file, "--base-sha", OLD_SHA, "--output", output,
            )
            self.expect_exit(prepared, 0)
            before = json.loads(output.read_text(encoding="utf-8"))
            before["task_id"] = Path(path).stem
            self.assertEqual(before["base_sha"], OLD_SHA)
            self.assertCountEqual(before["planned_paths"], ["src/synthetic.py", MAP_PATH])
            self.assertCountEqual([row["id"] for row in before["assessments"]], ["INV-OLD", "INV-GLOBAL"])
            for assessment in before["assessments"]:
                assessment.update({"disposition": "preserve", "reason": "Keep the synthetic requirement.",
                                   "checks": [{"id": "SYNTHETIC-1", "method": "Inspect the synthetic boundary.",
                                               "expected": "The synthetic requirement remains covered."}],
                                   "decision_references": []})
            before["boundaries"] = [{"id": "B1", "direction": "entry", "location": "src/synthetic.py",
                                     "data": "Synthetic input.", "trust": "untrusted", "control": "Reject unknown input."}]
            self.assertEqual(before["context"]["INV-OLD"]["history"], [])
            before["context"]["INV-GLOBAL"] = {"condition": SHARED_TEXT, "scenarios": deepcopy(shared_catalog["invariants"][0]["scenarios"]),
                                                  "history": deepcopy(shared_ledger["findings"])}
            before["variant_analysis"] = [variant()]
            before["conflicts"] = [{"description": "Synthetic conflict " + str(index), "state": "resolved",
                                     "resolution": "Safe project resolution " + str(index)} for index in range(9)]
            after = deepcopy(before)
            del after["context"]["INV-GLOBAL"]
            after["variant_analysis"] = [variant("new-a", "INV-GLOBAL"), fallback(variant())]
            self.assertEqual(before["context"]["INV-OLD"], after["context"]["INV-OLD"])
            self.originals[path], self.rewrites[path] = before, after
            write_json(output, before)
            write_json(self.candidate / path, after)
        ci_map = split_map()
        # This independent positive fixture has only a moved global cause.
        # No local/project renumbering or both/history policy is exercised.
        ci_map["findings"] = [row for row in ci_map["findings"] if row["source_id"] == "PR1-R001"]
        self.map_bytes = encode_map(ci_map)
        (self.candidate / MAP_PATH).write_bytes(self.map_bytes)
        self.allowlist = make_batch(paths)["base_allowlist"]
        self.allowlist["split_map_sha256"] = hashlib.sha256(self.map_bytes).hexdigest()
        write_json(self.base / LIST_PATH, self.allowlist)
        # The candidate omits the one-use list; the actual path records deletion.

    def run_ci(self):
        # Fixture setup is a host task. The public CI has no shared body files.
        if self.host.exists():
            shutil.rmtree(self.host)
        return self.command(self.ci, "--candidate", self.candidate, "--paths-file", self.actual_file, "--base-sha", BASE_SHA)

    def check_each_rewrite(self):
        # Existing local check revalidates each plan with its own base. Count
        # and stale-base exemptions are exercised solely through real ci.py.
        for path in self.paths:
            with self.subTest(plan=path):
                plan = json.loads((self.candidate / path).read_text(encoding="utf-8"))
                single_paths = self.inputs / (Path(path).stem + "-check-paths.json")
                write_json(single_paths, [path, MAP_PATH])
                self.expect_exit(self.command(
                    self.guard, "check", "--plan", self.candidate / path,
                    "--paths-file", single_paths, "--base-sha", plan["base_sha"],
                    "--catalog", self.base / ".review/causes/invariants.json",
                    "--ledger", self.base / ".review/causes/findings.json",
                    "--global-ids", self.base / ".review/mekiki/global-ids.json",
                    "--config", self.base / ".review/config.toml", cwd=self.candidate,
                ), 0)

    def test_ci_two_listed_old_base_rewrites_and_each_real_check_pass(self):
        self.prepare_trees()
        self.assertGreaterEqual(len(self.paths), 2)
        self.check_each_rewrite()
        self.expect_exit(self.run_ci(), 0)

    def test_ci_named_free_text_rewrite_can_pass_without_host_inputs(self):
        self.prepare_trees((OPS_LEDGER, PLAN_B))
        self.rewrites[OPS_LEDGER]["conflicts"][5]["resolution"] = "A safe, wholly synthetic project explanation."
        write_json(self.candidate / OPS_LEDGER, self.rewrites[OPS_LEDGER])
        self.check_each_rewrite()
        self.expect_exit(self.run_ci(), 0)

    def test_ci_unlisted_two_current_base_plans_keep_the_one_plan_rule(self):
        self.prepare_trees()
        empty_list = deepcopy(self.allowlist)
        empty_list["plans"] = []
        write_json(self.base / LIST_PATH, empty_list)
        for path in self.paths:
            self.rewrites[path]["base_sha"] = BASE_SHA
            write_json(self.candidate / path, self.rewrites[path])
        self.expect_exit(self.run_ci(), 1)

    def test_ci_head_only_allowlist_cannot_authorize_two_old_base_plans(self):
        self.prepare_trees()
        (self.base / LIST_PATH).unlink()
        write_json(self.candidate / LIST_PATH, self.allowlist)
        self.expect_exit(self.run_ci(), 1)

    def test_ci_wrong_base_digest_is_rejected_with_allowlist_deleted(self):
        self.prepare_trees()
        self.assertFalse((self.candidate / LIST_PATH).exists())
        (self.candidate / MAP_PATH).write_bytes(self.map_bytes + b"\n")
        self.check_each_rewrite()
        self.expect_exit(self.run_ci(), 1)

    def test_ci_wrong_base_digest_is_not_repaired_by_head_digest(self):
        self.prepare_trees()
        changed_bytes = self.map_bytes + b"\n"
        (self.candidate / MAP_PATH).write_bytes(changed_bytes)
        head_list = deepcopy(self.allowlist)
        head_list["split_map_sha256"] = hashlib.sha256(changed_bytes).hexdigest()
        write_json(self.candidate / LIST_PATH, head_list)
        self.expect_exit(self.run_ci(), 1)

    def test_ci_listed_rewrite_cannot_change_assessment_decision(self):
        self.prepare_trees()
        self.rewrites[PLAN_A]["assessments"][0]["reason"] = "Unauthorized synthetic decision change."
        write_json(self.candidate / PLAN_A, self.rewrites[PLAN_A])
        self.expect_exit(self.run_ci(), 1)

    def test_ci_non_named_free_text_change_is_rejected(self):
        self.prepare_trees((OPS_LEDGER, PLAN_B))
        self.rewrites[OPS_LEDGER]["conflicts"][4]["resolution"] = "Unauthorized neighboring project explanation."
        write_json(self.candidate / OPS_LEDGER, self.rewrites[OPS_LEDGER])
        self.expect_exit(self.run_ci(), 1)

    def test_ci_head_pointer_cannot_authorize_non_named_free_text(self):
        self.prepare_trees((OPS_LEDGER, PLAN_B))
        head_list = deepcopy(self.allowlist)
        for entry in head_list["plans"]:
            if entry["path"] == OPS_LEDGER:
                entry["editable_text"].append("/conflicts/4/resolution")
        write_json(self.candidate / LIST_PATH, head_list)
        self.rewrites[OPS_LEDGER]["conflicts"][4]["resolution"] = "Head-authorized neighboring explanation."
        write_json(self.candidate / OPS_LEDGER, self.rewrites[OPS_LEDGER])
        self.expect_exit(self.run_ci(), 1)

    def test_ci_unchanged_retained_allowlist_is_rejected(self):
        self.prepare_trees()
        write_json(self.candidate / LIST_PATH, self.allowlist)
        self.actual_paths = [*self.paths, MAP_PATH]
        write_json(self.actual_file, self.actual_paths)
        self.check_each_rewrite()
        self.expect_exit(self.run_ci(), 1)

    def test_ci_retained_bad_head_digest_is_rejected_even_with_matching_base_authority(self):
        self.prepare_trees()
        head_list = deepcopy(self.allowlist)
        head_list["split_map_sha256"] = "0" * 64
        write_json(self.candidate / LIST_PATH, head_list)
        self.check_each_rewrite()
        self.expect_exit(self.run_ci(), 1)

    def test_ci_head_removal_does_not_remove_base_allowlist_authority(self):
        self.prepare_trees()
        self.assertFalse((self.candidate / LIST_PATH).exists())
        self.check_each_rewrite()
        self.expect_exit(self.run_ci(), 0)

    def test_ci_listed_only_rewrites_can_delete_allowlist_with_actual_deletion_path(self):
        self.prepare_trees()
        # The split-map is unchanged in this PR; only listed plans and the
        # allowlist deletion belong to the actual changed-path list (RT-1).
        (self.base / MAP_PATH).write_bytes(self.map_bytes)
        self.assertFalse((self.candidate / LIST_PATH).exists())
        self.actual_paths = [*self.paths, LIST_PATH]
        write_json(self.actual_file, self.actual_paths)
        self.check_each_rewrite()
        self.expect_exit(self.run_ci(), 0)

    def test_ci_listed_only_rewrites_cannot_edit_allowlist_with_actual_changed_path(self):
        self.prepare_trees()
        (self.base / MAP_PATH).write_bytes(self.map_bytes)
        head_list = deepcopy(self.allowlist)
        head_list["split_map_sha256"] = "0" * 64
        write_json(self.candidate / LIST_PATH, head_list)
        self.actual_paths = [*self.paths, LIST_PATH]
        write_json(self.actual_file, self.actual_paths)
        self.expect_exit(self.run_ci(), 1)
