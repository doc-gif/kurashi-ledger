"""PR49-R001: a rewrite list file that exists but holds JSON `null` is a list, not a missing one.

Claude's tests, through the real ci.py. They reuse the setup of Codex's CI integration tests
(test_plan_rewrites_ci.py) without running those tests a second time. All data is synthetic.
"""

import json
import unittest

import test_plan_rewrites_ci as ci_tests
from plan_rewrite_fixtures import BASE_SHA, PLAN_A

LIST_PATH = ci_tests.LIST_PATH


class NullRewriteListCITests(unittest.TestCase):
    # Borrowed by attribute, so the loader never sees Codex's class in this module.
    setUp = ci_tests.PlanRewriteCIIntegrationTests.setUp
    command = ci_tests.PlanRewriteCIIntegrationTests.command
    expect_exit = ci_tests.PlanRewriteCIIntegrationTests.expect_exit
    prepare_trees = ci_tests.PlanRewriteCIIntegrationTests.prepare_trees
    run_ci = ci_tests.PlanRewriteCIIntegrationTests.run_ci

    def ordinary_pr(self):
        """One current-base plan and no list in either tree: the rules before Issue #46."""
        self.prepare_trees((PLAN_A,))
        (self.base / LIST_PATH).unlink()
        plan = json.loads((self.candidate / PLAN_A).read_text(encoding="utf-8"))
        plan["base_sha"] = BASE_SHA
        ci_tests.write_json(self.candidate / PLAN_A, plan)
        ci_tests.write_json(self.actual_file, [PLAN_A])

    def test_rewrite_pr_that_deletes_the_list_passes(self):
        self.prepare_trees()
        self.assertFalse((self.candidate / LIST_PATH).exists())
        self.expect_exit(self.run_ci(), 0)

    def test_rewrite_pr_that_leaves_a_null_list_is_rejected(self):
        self.prepare_trees()
        (self.candidate / LIST_PATH).write_text("null\n", encoding="utf-8")
        ci_tests.write_json(self.actual_file, [*self.paths, ci_tests.MAP_PATH, LIST_PATH])
        self.expect_exit(self.run_ci(), 1)

    def test_ordinary_pr_without_a_list_passes(self):
        self.ordinary_pr()
        self.expect_exit(self.run_ci(), 0)

    def test_ordinary_pr_adding_a_null_list_is_rejected(self):
        self.ordinary_pr()
        (self.candidate / LIST_PATH).parent.mkdir(parents=True, exist_ok=True)
        (self.candidate / LIST_PATH).write_text("null\n", encoding="utf-8")
        self.expect_exit(self.run_ci(), 1)

    def test_ordinary_pr_on_a_base_with_a_null_list_is_rejected(self):
        self.ordinary_pr()
        (self.base / LIST_PATH).write_text("null\n", encoding="utf-8")
        self.expect_exit(self.run_ci(), 1)


if __name__ == "__main__":
    unittest.main()
