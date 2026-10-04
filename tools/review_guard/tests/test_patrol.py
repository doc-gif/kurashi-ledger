import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from patrol_fixtures import (BASE, BASE2, HEAD, HEAD2, IMPLEMENTER, LOGIN, NS, REVIEWER, comment, config,
                             gate, handoff_body, patrol, pull, review_body, snapshot)

T1, T2, T3, T4 = "2026-01-01T00:00:01Z", "2026-01-01T00:00:02Z", "2026-01-01T00:00:03Z", "2026-01-01T00:00:04Z"


def judged(*pulls, **kwargs):
    return patrol.judge(snapshot(*pulls, **kwargs), config())


def only(result):
    return result["pulls"][0]


class ClassificationTests(unittest.TestCase):
    def test_ready_needs_handoff_for_current_head_and_base_and_a_successful_gate(self):
        result = judged(pull([comment(1, T1, handoff_body())]))
        self.assertEqual(result["result"], "judged")
        self.assertEqual(only(result)["state"], patrol.READY)
        self.assertIsNone(only(result)["gap"])

    def test_elapsed_time_without_a_handoff_is_never_completion(self):
        old = "2001-01-01T00:00:00Z"
        stale = pull([comment(1, old, "作業はおそらく終わった。")])
        stale["updated_at"] = old
        self.assertEqual(only(judged(stale))["state"], patrol.IN_PROGRESS)
        # The judgment takes no clock at all: the same input gives the same answer.
        self.assertEqual(judged(stale), judged(stale))

    def test_stale_ready_after_push_or_base_update_needs_a_new_handoff(self):
        pushed = only(judged(pull([comment(1, T1, handoff_body(head=HEAD))], head=HEAD2)))
        self.assertEqual(pushed["state"], patrol.FIXES)
        self.assertEqual(pushed["gap"], "stale-handoff")
        moved = only(judged(pull([comment(1, T1, handoff_body(base=BASE))]), tip=BASE2))
        self.assertEqual(moved["state"], patrol.FIXES)
        self.assertEqual(moved["gap"], "stale-handoff")

    def test_working_or_unreadable_handoff_supersedes_an_earlier_ready(self):
        for later in (handoff_body(status="working（中断中）"), handoff_body(status="ready-for-reviewではない"),
                      handoff_body(status="paused"), handoff_body(head="<head SHA>")):
            with self.subTest(later=later.splitlines()[5]):
                result = only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, later)])))
                self.assertEqual(result["state"], patrol.IN_PROGRESS)

    def test_handoff_needs_owner(self):
        result = only(judged(pull([comment(1, T1, handoff_body(status="needs-owner"))])))
        self.assertEqual(result["state"], patrol.OWNER)

    def test_review_decisions_for_the_current_head_and_base(self):
        for decision, state in [("changes-requested", patrol.FIXES), ("needs-owner", patrol.OWNER),
                                ("accepted", patrol.ACCEPTED)]:
            with self.subTest(decision=decision):
                result = only(judged(pull([comment(1, T1, handoff_body()),
                                           comment(2, T2, review_body(decision))])))
                self.assertEqual(result["state"], state)
                self.assertEqual(result["review"]["decision"], decision)

    def test_push_during_review_makes_the_old_review_outdated(self):
        comments = [comment(1, T1, handoff_body(head=HEAD)), comment(2, T2, review_body("changes-requested", head=HEAD)),
                    comment(3, T3, handoff_body(head=HEAD2))]
        result = only(judged(pull(comments, head=HEAD2)))
        self.assertEqual(result["state"], patrol.READY)
        self.assertEqual(result["outdated_reviews"], [2])
        # Push after a review and no new handoff: the old accepted does not carry over.
        result = only(judged(pull(comments[:1] + [comment(2, T2, review_body("accepted", head=HEAD))], head=HEAD2)))
        self.assertEqual(result["state"], patrol.FIXES)

    def test_base_update_during_review_invalidates_the_review(self):
        comments = [comment(1, T1, handoff_body(base=BASE)), comment(2, T2, review_body("accepted", base=BASE))]
        self.assertEqual(only(judged(pull(comments), tip=BASE2))["state"], patrol.FIXES)
        comments.append(comment(3, T3, handoff_body(base=BASE2)))
        result = only(judged(pull(comments, ci_base=BASE2), tip=BASE2))
        self.assertEqual(result["state"], patrol.READY)
        self.assertNotIn("review", result)

    def test_same_head_new_base_with_the_old_base_ci_success_is_not_ready(self):
        # PR38-R007: the latest gate ran on a merge with BASE; the new ready is for BASE2.
        ready = [comment(1, T1, handoff_body(base=BASE2))]
        result = only(judged(pull(ready, ci_base=BASE), tip=BASE2))
        self.assertEqual(result["state"], patrol.FIXES)
        self.assertEqual(result["gap"], "ci-other-base")
        accepted = ready + [comment(2, T2, review_body("accepted", base=BASE2))]
        self.assertEqual(only(judged(pull(accepted, ci_base=BASE), tip=BASE2))["state"], patrol.FIXES)

    def test_missing_or_mismatched_ci_evidence_is_unconfirmed(self):
        ready = [comment(1, T1, handoff_body())]
        for change in ("missing", "other-run", "bad-sha", "no-parents"):
            with self.subTest(change=change):
                target = pull(ready)
                if change == "missing":
                    del target["ci_evidence"]
                elif change == "other-run":
                    target["ci_evidence"]["check_run_id"] = 99
                elif change == "bad-sha":
                    target["ci_evidence"]["tested_sha"] = "not-a-sha"
                else:
                    target["ci_evidence"]["parents"] = None
                result = judged(target)
                self.assertEqual(only(result)["state"], patrol.UNCONFIRMED)
                self.assertEqual(result["result"], "unconfirmed")

    def test_ci_failure_pending_missing_and_rerun(self):
        ready = [comment(1, T1, handoff_body())]
        failed = only(judged(pull(ready, checks=[gate("failure")])))
        self.assertEqual(failed["state"], patrol.FIXES)
        self.assertEqual(failed["gap"], "ci-failed")
        for checks in ([gate(status="in_progress")], [], [gate(head=HEAD2)],
                       [dict(gate(), name="checks (linux)")]):
            with self.subTest(checks=checks):
                self.assertEqual(only(judged(pull(ready, checks=checks)))["state"], patrol.WAITING_CI)
        for conclusion in ("cancelled", "skipped", "timed_out", "neutral", None):
            with self.subTest(conclusion=conclusion):
                self.assertEqual(only(judged(pull(ready, checks=[gate(conclusion)])))["state"], patrol.FIXES)
        rerun = [gate("failure", run_id=10), gate("success", run_id=11)]  # evidence is for run 11
        self.assertEqual(only(judged(pull(ready, checks=rerun)))["state"], patrol.READY)
        rerun_failed = [gate("success", run_id=10), gate("failure", run_id=11)]
        self.assertEqual(only(judged(pull(ready, checks=rerun_failed)))["state"], patrol.FIXES)

    def test_accepted_does_not_hide_a_failed_gate(self):
        comments = [comment(1, T1, handoff_body()), comment(2, T2, review_body("accepted"))]
        self.assertEqual(only(judged(pull(comments, checks=[gate("failure")])))["state"], patrol.FIXES)

    def test_policy_files_are_listed_but_do_not_change_the_state(self):
        result = only(judged(pull([comment(1, T1, handoff_body())],
                                  files=[".github/workflows/ci.yml", "tools/review_guard/guard.py", "README.md"])))
        self.assertEqual(result["state"], patrol.READY)
        self.assertEqual(result["policy_files"], [".github/workflows/ci.yml", "tools/review_guard/guard.py"])

    def test_issue_named_by_the_handoff(self):
        closed = only(judged(pull([comment(1, T1, handoff_body())]), issues={"7": "closed"}))
        self.assertTrue(any("#7" in w and "closed" in w for w in closed["warnings"]))
        # PR38-R001: an issue that could not be read makes the PR unconfirmed, not a warning.
        unread = judged(pull([comment(1, T1, handoff_body())]), issues={})
        self.assertEqual(unread["result"], "unconfirmed")
        self.assertEqual(only(unread)["state"], patrol.UNCONFIRMED)
        self.assertIsNone(only(unread)["gap"])

    def test_draft_is_work_in_progress_even_with_a_matching_ready(self):
        # PR38-R006: back to Draft after a ready (and even after an accepted) is not a candidate.
        ready = [comment(1, T1, handoff_body())]
        self.assertEqual(only(judged(pull(ready, draft=True)))["state"], patrol.IN_PROGRESS)
        accepted = ready + [comment(2, T2, review_body("accepted"))]
        self.assertEqual(only(judged(pull(accepted)))["state"], patrol.ACCEPTED)
        self.assertEqual(only(judged(pull(accepted, draft=True)))["state"], patrol.IN_PROGRESS)
        stale = only(judged(pull(ready, head=HEAD2, draft=True)))
        self.assertEqual((stale["state"], stale["gap"]), (patrol.IN_PROGRESS, None))
        self.assertEqual(only(judged(pull([comment(1, T1, handoff_body(status="needs-owner"))], draft=True)))["state"],
                         patrol.OWNER)


class SameAccountAndTrustTests(unittest.TestCase):
    def test_same_account_comment_reviews_are_identified_by_body_markers(self):
        comments = [comment(1, T1, handoff_body(), login=LOGIN),
                    comment(500, T2, review_body("changes-requested"), source="review", login=LOGIN,
                            review_state="COMMENTED", commit_id=HEAD)]
        self.assertEqual(only(judged(pull(comments)))["state"], patrol.FIXES)

    def test_github_review_state_without_a_marker_is_not_a_decision(self):
        comments = [comment(1, T1, handoff_body()),
                    comment(500, T2, "LGTM", source="review", review_state="APPROVED", commit_id=HEAD)]
        self.assertEqual(only(judged(pull(comments)))["state"], patrol.READY)

    def test_legacy_reviewer_role_is_read(self):
        comments = [comment(1, T1, handoff_body()), comment(2, T2, review_body("accepted", role="reviewer"))]
        self.assertEqual(only(judged(pull(comments)))["state"], patrol.ACCEPTED)

    def test_review_from_the_implementer_side_is_not_counted(self):
        # PR38-R010: only the opposite side counts (Claude implements -> Codex reviews, and back).
        same = [("claude-reviewer", IMPLEMENTER), ("claude-reviewer", "claude-session/other-subagent")]
        for role, agent in same:
            with self.subTest(role=role, agent=agent):
                comments = [comment(1, T1, handoff_body()), comment(2, T2, review_body("accepted", role=role, agent=agent))]
                result = only(judged(pull(comments)))
                self.assertEqual(result["state"], patrol.READY)
                self.assertTrue(any("implementer's side (claude)" in w for w in result["warnings"]))
        # The other direction: Codex implemented, a Codex subagent reviewed; then Claude reviewed.
        codex_ready = comment(1, T1, handoff_body(agent="codex-session/impl"))
        own = comment(2, T2, review_body("accepted", role="codex-reviewer", agent="codex-session/other"))
        self.assertEqual(only(judged(pull([codex_ready, own])))["state"], patrol.READY)
        other = comment(3, T3, review_body("accepted", role="claude-reviewer", agent="claude-session/reviewer"))
        result = only(judged(pull([codex_ready, own, other])))
        self.assertEqual((result["state"], result["review"]["side"]), (patrol.ACCEPTED, "claude"))

    def test_review_side_that_cannot_be_determined_is_unconfirmed(self):
        for role, agent in [("reviewer", "someone/unknown"),            # legacy role, unknown agent_id
                            ("codex-reviewer", "claude-session/x")]:    # role and agent_id disagree
            with self.subTest(role=role, agent=agent):
                comments = [comment(1, T1, handoff_body()), comment(2, T2, review_body("accepted", role=role, agent=agent))]
                self.assertEqual(only(judged(pull(comments)))["state"], patrol.UNCONFIRMED)
        legacy = [comment(1, T1, handoff_body()), comment(2, T2, review_body("accepted", role="reviewer"))]
        self.assertEqual(only(judged(pull(legacy)))["state"], patrol.ACCEPTED)  # codex-session agent_id
        unknown_impl = [comment(1, T1, handoff_body(agent="someone/impl")), comment(2, T2, review_body("accepted"))]
        self.assertEqual(only(judged(pull(unknown_impl)))["state"], patrol.UNCONFIRMED)
        self.assertEqual(only(judged(pull(unknown_impl[:1])))["state"], patrol.READY)

    def test_same_second_records_of_different_resources_are_unconfirmed(self):
        # PR38-R009: an issue comment and a pull review in the same second have no provable order.
        for review_id, handoff_id in [(5, 900), (900, 5)]:          # either id order
            for decision in ("accepted", "changes-requested"):
                with self.subTest(review_id=review_id, decision=decision):
                    comments = [comment(handoff_id, T2, handoff_body()),
                                comment(review_id, T2, review_body(decision), source="review",
                                        review_state="COMMENTED", commit_id=HEAD)]
                    self.assertEqual(only(judged(pull(comments)))["state"], patrol.UNCONFIRMED)
        unreadable = [comment(900, T2, handoff_body()),
                      comment(5, T2, "role: codex-reviewer\ndecision: accepted", source="review")]
        self.assertEqual(only(judged(pull(unreadable)))["state"], patrol.UNCONFIRMED)
        # Same resource: ids order them. Different seconds: timestamps order them.
        same_resource = [comment(5, T2, handoff_body()), comment(6, T2, review_body("accepted"))]
        self.assertEqual(only(judged(pull(same_resource)))["state"], patrol.ACCEPTED)
        before = [comment(900, T2, handoff_body()),
                  comment(5, T1, review_body("accepted"), source="review", commit_id=HEAD)]
        self.assertEqual(only(judged(pull(before)))["state"], patrol.READY)
        after = [comment(900, T1, handoff_body()),
                 comment(5, T2, review_body("accepted"), source="review", commit_id=HEAD)]
        self.assertEqual(only(judged(pull(after)))["state"], patrol.ACCEPTED)

    def test_conflicting_decisions_in_the_same_second_are_unconfirmed(self):
        comments = [comment(1, T1, handoff_body()), comment(900, T2, review_body("accepted")),
                    comment(5, T2, review_body("changes-requested"), source="review", commit_id=HEAD)]
        self.assertEqual(only(judged(pull(comments)))["state"], patrol.UNCONFIRMED)

    def test_records_from_untrusted_authors_are_ignored(self):
        forged = [comment(1, T1, handoff_body()),
                  comment(2, T2, review_body("accepted"), association="NONE", login="someone-else"),
                  comment(3, T3, handoff_body(status="needs-owner"), association="CONTRIBUTOR")]
        result = only(judged(pull(forged)))
        self.assertEqual(result["state"], patrol.READY)
        self.assertEqual(sum("untrusted" in w for w in result["warnings"]), 2)

    def test_only_a_marker_on_the_first_line_is_a_record(self):
        # PR38-R004: an example after a preface, inside a fence or after a real record never counts.
        examples = ["例として次のように書く。\n\n" + review_body("accepted"),
                    "例:\n```text\n" + review_body("accepted") + "\n```",
                    "本文 <!-- " + NS + ":review:v1 -->\ndecision: accepted"]
        for body in examples:
            with self.subTest(body=body.splitlines()[0]):
                result = only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, body)])))
                self.assertEqual(result["state"], patrol.READY)
        trailing = review_body("changes-requested") + "\n\n書式の例:\n" + review_body("accepted")
        result = only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, trailing)])))
        self.assertEqual(result["state"], patrol.FIXES)
        self.assertTrue(any("not on the first line" in w for w in result["warnings"]))
        leading_blank = "\n\n" + review_body("accepted")
        self.assertEqual(only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, leading_blank)])))["state"],
                         patrol.ACCEPTED)

    def test_configured_bot_records_are_read_although_the_association_is_none(self):
        # A bot working note after a human-account ready makes the PR in progress.
        bot_working = comment(2, T2, handoff_body(status="working"), association="NONE", login="example-claude[bot]")
        result = only(judged(pull([comment(1, T1, handoff_body()), bot_working])))
        self.assertEqual(result["state"], patrol.IN_PROGRESS)
        codex_review = comment(2, T2, review_body("changes-requested"), association="NONE", login="example-codex[bot]")
        self.assertEqual(only(judged(pull([comment(1, T1, handoff_body()), codex_review])))["state"], patrol.FIXES)
        # Trust is not a role: a bot's plain APPROVED without a marker decides nothing.
        note = comment(3, T3, "LGTM", association="NONE", login="example-codex[bot]", source="review",
                       review_state="APPROVED", commit_id=HEAD)
        self.assertEqual(only(judged(pull([comment(1, T1, handoff_body()), note])))["state"], patrol.READY)

    def test_bot_writing_for_another_side_is_unconfirmed(self):
        mismatch = comment(2, T2, review_body("accepted", role="claude-reviewer", agent="claude-session/x"),
                           association="NONE", login="example-codex[bot]")
        result = only(judged(pull([comment(1, T1, handoff_body(agent="codex-session/impl")), mismatch])))
        self.assertEqual(result["state"], patrol.UNCONFIRMED)
        self.assertTrue(any("example-codex[bot]" in w for w in result["warnings"]))
        handoff_mismatch = comment(2, T2, handoff_body(agent="codex-session/impl"),
                                   association="NONE", login="example-claude[bot]")
        result = only(judged(pull([comment(1, T1, handoff_body()), handoff_mismatch])))
        self.assertEqual(result["state"], patrol.UNCONFIRMED)

    def test_unknown_bots_and_none_humans_are_ignored(self):
        for login in ("someone-else[bot]", "someone-else"):
            with self.subTest(login=login):
                other = comment(2, T2, review_body("changes-requested"), association="NONE", login=login)
                result = only(judged(pull([comment(1, T1, handoff_body()), other])))
                self.assertEqual(result["state"], patrol.READY)
                self.assertTrue(any("untrusted" in w for w in result["warnings"]))

    def test_human_account_records_keep_the_association_rule(self):
        # doc-gif style: OWNER association, no bot mapping, no family cross-check.
        owner = comment(2, T2, review_body("accepted"), association="OWNER", login="shared-account")
        self.assertEqual(only(judged(pull([comment(1, T1, handoff_body()), owner])))["state"], patrol.ACCEPTED)

    def test_unreadable_or_unmarked_reviewer_text_after_ready_is_unconfirmed(self):
        placeholder = review_body("changes-requested | accepted | needs-owner")
        unmarked = "role: codex-reviewer\nagent_id: x\ndecision: changes-requested"
        for body in (placeholder, unmarked):
            with self.subTest(body=body.splitlines()[0]):
                result = only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, body)])))
                self.assertEqual(result["state"], patrol.UNCONFIRMED)
        # Before the latest ready it is history and only a warning.
        result = only(judged(pull([comment(1, T1, unmarked), comment(2, T2, handoff_body())])))
        self.assertEqual(result["state"], patrol.READY)
        self.assertTrue(result["warnings"])

    def test_unmarked_implementer_notes_are_reported_but_do_not_block(self):
        note = "role: implementer\nagent_id: claude-session/alpha\n指摘への対応の記録"
        result = only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, note)])))
        self.assertEqual(result["state"], patrol.READY)
        self.assertTrue(any("without the marker" in w for w in result["warnings"]))


class CopilotTests(unittest.TestCase):
    def test_copilot_unavailable_does_not_change_the_state(self):
        result = only(judged(pull([comment(1, T1, handoff_body())])))
        self.assertEqual(result["state"], patrol.READY)
        self.assertEqual(result["copilot"]["status"], "not-reviewed-current-head")

    def test_copilot_review_or_approval_is_never_an_acceptance(self):
        copilot = comment(9, T2, "Copilot reviewed 3 files", source="review", association="NONE",
                          login="copilot-pull-request-reviewer[bot]", review_state="APPROVED", commit_id=HEAD)
        result = only(judged(pull([comment(1, T1, handoff_body()), copilot])))
        self.assertEqual(result["state"], patrol.READY)
        self.assertEqual(result["copilot"]["status"], "reviewed-current-head")
        old = dict(copilot, commit_id=HEAD2)
        self.assertEqual(only(judged(pull([comment(1, T1, handoff_body()), old])))["copilot"]["status"],
                         "not-reviewed-current-head")


class ReportOnlyTests(unittest.TestCase):
    def test_gap_is_reported_and_nothing_is_composed_for_posting(self):
        # 2026-10-04 owner decision: notifications belong to the Issue #45 receiver, not T23.
        stale = [comment(1, T1, handoff_body(head=HEAD))]
        result = only(judged(pull(stale, head=HEAD2)))
        self.assertEqual((result["state"], result["gap"]), (patrol.FIXES, "stale-handoff"))
        self.assertNotIn("notices", result)
        self.assertFalse(hasattr(patrol, "notice_body"))

    def test_old_patrol_notice_comments_are_not_records(self):
        old = f"<!-- {NS}:patrol:v1 -->\nkind: stale-handoff\nhead_sha: {HEAD2}\nbase_sha: {BASE}"
        stale = [comment(1, T1, handoff_body(head=HEAD)), comment(2, T2, old)]
        result = only(judged(pull(stale, head=HEAD2)))
        self.assertEqual((result["state"], result["gap"]), (patrol.FIXES, "stale-handoff"))

    def test_text_written_by_others_is_data(self):
        evil = "$(touch pwned) `rm -rf /` <script>x</script>"
        result = only(judged(pull([comment(1, T1, handoff_body(task=evil + " #7"))])))
        self.assertEqual(result["state"], patrol.READY)
        self.assertEqual(result["handoff"]["task_id"], evil + " #7")


class UnconfirmedTests(unittest.TestCase):
    def test_partial_pull_data_is_unconfirmed(self):
        broken = pull([comment(1, T1, handoff_body())])
        broken.update(complete=False, errors=["rate-limited: reviews"])
        result = judged(broken)
        self.assertEqual(result["result"], "unconfirmed")
        self.assertEqual(only(result)["state"], patrol.UNCONFIRMED)
        self.assertIsNone(only(result)["gap"])

    def test_failed_list_is_not_an_empty_repository(self):
        snap = snapshot()
        snap.update(complete=False, errors=["open pulls: rate-limited"])
        result = patrol.judge(snap, config())
        self.assertEqual(result["result"], "unconfirmed")
        self.assertEqual(result["pulls"], [])
        incomplete = snapshot()
        incomplete["complete"] = False
        self.assertEqual(patrol.judge(incomplete, config())["result"], "unconfirmed")

    def test_missing_base_tip_is_unconfirmed(self):
        result = judged(pull([comment(1, T1, handoff_body())]), tip=None)
        self.assertEqual(only(result)["state"], patrol.UNCONFIRMED)

    def test_empty_but_complete_snapshot_is_judged(self):
        self.assertEqual(patrol.judge(snapshot(), config())["result"], "judged")

    def test_snapshot_of_another_repository_is_rejected(self):
        # PR38-R011
        for value in ("other-owner/other-repo", None):
            with self.subTest(repository=value):
                snap = snapshot(pull([comment(1, T1, handoff_body())]))
                if value is None:
                    del snap["repository"]
                else:
                    snap["repository"] = value
                with self.assertRaisesRegex(patrol.Invalid, "repository"):
                    patrol.judge(snap, config())


class ParseAndConfigTests(unittest.TestCase):
    def test_duplicate_field_and_oversized_body_are_not_records(self):
        dup = handoff_body() + "\n"
        dup = dup.replace("role: implementer", "role: implementer\nrole: implementer")
        result = only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, dup)])))
        self.assertEqual(result["state"], patrol.IN_PROGRESS)
        huge = handoff_body() + "\n" + "x" * (patrol.MAX_BODY + 1)
        result = only(judged(pull([comment(1, T1, handoff_body()), comment(2, T2, huge)])))
        self.assertEqual(result["state"], patrol.UNCONFIRMED)

    def test_config_is_validated(self):
        for key, value in [("marker_namespace", "Bad Name"), ("repository", "no-slash"),
                           ("tested_commit_env", "lower"), ("trusted_logins", ["a-list"]), ("trusted_logins", {"x[bot]": "unknown-side"}),
                           ("agent_sides", {"codex": ["codex"]}),
                           ("reviewer_roles", {"codex-reviewer": "unknown-side"}),
                           ("trusted_associations", []), ("policy_paths", ["/abs"]), ("reviewer_roles", {})]:
            with self.subTest(key=key):
                bad = config()
                bad[key] = value
                with self.assertRaises(patrol.Invalid):
                    patrol.judge(snapshot(), bad)

    def test_cli_exit_codes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "config.json").write_text(json.dumps(config()), encoding="utf-8")
            cases = [(snapshot(pull([comment(1, T1, handoff_body())])), 0),
                     (dict(snapshot(), complete=False), patrol.EXIT_UNCONFIRMED),
                     ({"schema_version": 9}, 1),
                     (dict(snapshot(), repository="other-owner/other-repo"), 1)]
            for value, code in cases:
                with self.subTest(code=code):
                    (root / "snap.json").write_text(json.dumps(value), encoding="utf-8")
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        self.assertEqual(patrol.main(["judge", "--snapshot", str(root / "snap.json"),
                                                      "--config", str(root / "config.json")]), code)
                    if code != 1:
                        self.assertTrue(out.getvalue().isascii())


class NoExecutionTests(unittest.TestCase):
    def test_tool_sources_do_not_execute_pr_code_and_the_core_has_no_io(self):
        folder = Path(patrol.__file__).parent
        for name in ("patrol.py", "github_source.py"):
            source = (folder / name).read_text(encoding="utf-8")
            for forbidden in ("shell=True", "os.system", "eval(", "exec(", "import git", '"git"', '"checkout"'):
                with self.subTest(name=name, forbidden=forbidden):
                    self.assertFalse(forbidden in source, f"{name} contains {forbidden}")
        core = (folder / "patrol.py").read_text(encoding="utf-8")
        for forbidden in ("subprocess", "urllib", "socket", "http.client", "datetime", "import time"):
            with self.subTest(core=forbidden):
                self.assertFalse(forbidden in core, f"patrol.py contains {forbidden}")


if __name__ == "__main__":
    unittest.main()
