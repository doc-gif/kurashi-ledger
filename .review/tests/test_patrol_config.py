"""This repository's patrol settings (.review/patrol.json) match its review loop documents."""
import json
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "tools/review_guard"))
import patrol  # noqa: E402


class PatrolConfigTests(unittest.TestCase):
    def setUp(self):
        self.config = patrol.load_config(json.loads((root / ".review/patrol.json").read_text(encoding="utf-8")))
        self.loop = (root / "docs/pr-review-loop.md").read_text(encoding="utf-8")

    def test_markers_and_roles_match_the_review_loop(self):
        ns = self.config["marker_namespace"]
        self.assertIn(f"<!-- {ns}:handoff:v1 -->", self.loop)
        self.assertIn(f"<!-- {ns}:review:v1 -->", self.loop)
        self.assertIn("role: codex-reviewer | claude-reviewer", self.loop)
        self.assertEqual(set(self.config["reviewer_roles"]), {"codex-reviewer", "claude-reviewer", "reviewer"})
        for decision in patrol.DECISIONS:
            self.assertIn(decision, self.loop)

    def test_required_check_is_the_ci_quality_gate(self):
        workflow = (root / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn(f"name: {self.config['required_check']}", workflow)
        # The gate logs the tested merge commit in this variable; the patrol reads it (PR38-R007).
        self.assertIn(f"{self.config['tested_commit_env']}: ${{{{ github.sha }}}}", workflow)

    def test_policy_paths_cover_workflow_checkers_conditions_and_ledger(self):
        policy = self.config["policy_paths"]
        for path in [".github/workflows/ci.yml", "tools/review_guard/guard.py", ".review/invariants.json",
                     ".review/findings.json", "scripts/check-public.ts", "scripts/lib/test-skips.ts"]:
            with self.subTest(path=path):
                self.assertTrue(any(patrol.fnmatch.fnmatchcase(path, p) for p in policy))
        self.assertFalse(any(patrol.fnmatch.fnmatchcase(".review/plans/T23.json", p) for p in policy))

    def test_agent_sides_classify_the_agent_ids_in_use(self):
        # Claude's sessions start with "claude-code-...", Codex's with "codex/..." or "codex-desktop/...".
        for agent_id, side in [("claude-code-desktop/session/subagent-T23", "claude"),
                               ("codex/session", "codex"), ("codex-desktop/session/pr25", "codex"),
                               ("someone-else/session", None)]:
            with self.subTest(agent_id=agent_id):
                self.assertEqual(patrol.side_of(agent_id, self.config), side)
        self.assertEqual(self.config["reviewer_roles"]["codex-reviewer"], "codex")
        self.assertEqual(self.config["reviewer_roles"]["claude-reviewer"], "claude")

    def test_roles_are_not_identified_by_login(self):
        # Copilot logins only label the auxiliary review; no reviewer role is mapped to a login.
        self.assertFalse(set(self.config["copilot_logins"]) & set(self.config["reviewer_roles"]))
        self.assertFalse(set(self.config["copilot_logins"]) & set(self.config["reviewer_roles"].values()))


if __name__ == "__main__":
    unittest.main()
