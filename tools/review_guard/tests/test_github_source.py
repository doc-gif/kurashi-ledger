import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from patrol_fixtures import (BASE, BASE2, HEAD, HEAD2, NS, config, gate, github_source, handoff_body, patrol)

REPO = "example-owner/example-repo"
API = "https://api.github.com/"
T1 = "2026-01-01T00:00:01Z"


def raw_comment(cid, body, association="OWNER", at=T1):
    return {"id": cid, "created_at": at, "author_association": association, "user": {"login": "shared-account"},
            "body": body}


class FakeGitHub:
    """An in-memory GitHub REST API with Link pagination, Actions job logs and failure injection."""

    def __init__(self, page_size=2):
        self.page_size = page_size
        self.tip = BASE
        self.pulls = {}
        self.comments, self.reviews, self.files, self.checks = {}, {}, {}, {}
        self.logs, self.commits = {}, {}
        self.issues = {"7": "open"}
        self.fail = {}          # path prefix -> (status, headers)
        self.calls = []
        self.posted = []
        self.on_recheck = None  # called after every comments read; a barrier in the race tests
        self.mutex = threading.Lock()
        self.next_run = 100

    def add_gate(self, head, conclusion="success", status="completed", tested_base=None):
        """A Quality gate run on head; its log names a merge commit of tested_base and head."""
        self.next_run += 1
        run = dict(gate(conclusion, head=head, run_id=self.next_run, status=status),
                   app={"slug": "github-actions"})
        merge = f"{self.next_run:040x}"
        self.logs[run["id"]] = ("2026-01-01T00:00:00.0Z \x1b[36;1mrun step\x1b[0m\n"
                                f"2026-01-01T00:00:00.1Z   TESTED_SHA: {merge}\n"
                                f"2026-01-01T00:00:00.2Z   HEAD_SHA: {head}\n")
        self.commits[merge] = [tested_base or self.tip, head]
        self.checks.setdefault(head, []).append(run)
        return run

    def add_pull(self, number, head=HEAD, comments=(), files=("src/a.ts",), gate_run=True):
        self.pulls[number] = {"number": number, "state": "open", "draft": False,
                              "head": {"sha": head}, "base": {"ref": "main"}}
        self.comments[number] = list(comments)
        self.reviews[number] = []
        self.files[number] = [{"filename": f} for f in files]
        if gate_run and head not in self.checks:
            self.add_gate(head)

    def response(self, status, value, headers=None):
        return status, dict(headers or {}), value if isinstance(value, str) else json.dumps(value)

    def page(self, path, items, query, key=None):
        page = int(query.get("page", ["1"])[0])
        chunk = items[(page - 1) * self.page_size: page * self.page_size]
        headers = {}
        if page * self.page_size < len(items):
            headers["link"] = f'<{API}{path}?per_page=100&page={page + 1}>; rel="next"'
        value = {"total_count": len(items), key: chunk} if key else chunk
        return self.response(200, value, headers)

    def request(self, method, target, payload=None, text=False):
        split = urlsplit(target if target.startswith("http") else API + target)
        path = split.path.lstrip("/")
        parts = path.split("/")
        with self.mutex:
            response = self.handle(method, path, parts, parse_qs(split.query), payload, text)
        if self.on_recheck and method == "GET" and parts[3:4] == ["issues"] and parts[5:6] == ["comments"]:
            self.on_recheck(self)  # after the comments were read: both patrols have re-read
        return response

    def handle(self, method, path, parts, query, payload, text):
        self.calls.append((method, path, text))
        for prefix, (status, headers) in self.fail.items():
            if path.startswith(prefix):
                message = "You have exceeded a secondary rate limit" if "x-synthetic" in headers else "failure"
                return self.response(status, {"message": message}, headers)
        if method == "POST" and parts[3] == "issues" and parts[5] == "comments":
            number = int(parts[4])
            self.comments[number].append(raw_comment(1000 + len(self.posted), payload["body"],
                                                     at="2026-01-02T00:00:00Z"))
            self.posted.append((number, payload["body"]))
            return self.response(201, {"id": 1})
        if parts[3:] == ["branches", "main"]:
            return self.response(200, {"commit": {"sha": self.tip}})
        if parts[3] == "pulls" and len(parts) == 4:
            return self.page(path, [p for p in self.pulls.values() if p["state"] == "open"], query)
        if parts[3] == "pulls" and len(parts) == 5:
            return self.response(200, self.pulls[int(parts[4])])
        if parts[3] == "pulls" and parts[5] == "files":
            return self.page(path, self.files[int(parts[4])], query)
        if parts[3] == "pulls" and parts[5] == "reviews":
            return self.page(path, self.reviews[int(parts[4])], query)
        if parts[3] == "issues" and len(parts) == 6 and parts[5] == "comments":
            return self.page(path, self.comments[int(parts[4])], query)
        if parts[3] == "issues" and len(parts) == 5:
            state = self.issues.get(parts[4])
            return self.response(200, {"state": state}) if state else self.response(404, {"message": "Not Found"})
        if parts[3] == "commits" and len(parts) == 6 and parts[5] == "check-runs":
            return self.page(path, self.checks.get(parts[4], []), query, key="check_runs")
        if parts[3] == "commits" and len(parts) == 5 and parts[4] in self.commits:
            return self.response(200, {"parents": [{"sha": s} for s in self.commits[parts[4]]]})
        if parts[3:5] == ["actions", "jobs"] and parts[6] == "logs" and text:
            return self.response(200, self.logs[int(parts[5])])
        return self.response(404, {"message": "Not Found"})


def run(fake, *argv):
    out, err = io.StringIO(), io.StringIO()
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "patrol.json"
        path.write_text(json.dumps(config()), encoding="utf-8")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = github_source.main(["--config", str(path), "--lock-file", str(Path(folder) / "patrol.lock"),
                                       *argv], transport=fake)
    return code, out.getvalue(), err.getvalue()


def judge_all(fake):
    gh = github_source.GitHub(fake, REPO)
    return gh, patrol.judge(github_source.snapshot(gh, config()), config())


class SourceTests(unittest.TestCase):
    def gh(self, fake, max_pages=github_source.MAX_PAGES):
        return github_source.GitHub(fake, REPO, max_pages=max_pages)

    def ready_pull(self, fake, number=5, head=HEAD, **kwargs):
        fake.add_pull(number, head=head, comments=[raw_comment(1, handoff_body(head=head))], **kwargs)

    def test_pagination_reads_every_page(self):
        fake = FakeGitHub(page_size=2)
        for n in range(1, 6):
            self.ready_pull(fake, number=n, files=[f"f{i}.ts" for i in range(5)])
        snap = github_source.snapshot(self.gh(fake), config())
        self.assertTrue(snap["complete"], snap["errors"])
        self.assertEqual(sorted(p["number"] for p in snap["pulls"]), [1, 2, 3, 4, 5])
        self.assertEqual(len(snap["pulls"][0]["files"]), 5)
        result = patrol.judge(snap, config())
        self.assertEqual(result["result"], "judged")
        self.assertEqual({p["state"] for p in result["pulls"]}, {patrol.READY})

    def test_too_many_pages_is_incomplete_not_a_short_list(self):
        fake = FakeGitHub(page_size=1)
        for n in range(1, 4):
            self.ready_pull(fake, number=n)
        snap = github_source.snapshot(self.gh(fake, max_pages=2), config())
        self.assertFalse(snap["complete"])
        self.assertEqual(snap["pulls"], [])
        self.assertEqual(patrol.judge(snap, config())["result"], "unconfirmed")

    def test_check_run_total_mismatch_is_incomplete(self):
        fake = FakeGitHub()
        self.ready_pull(fake)
        original = fake.page

        def short(path, items, query, key=None):
            status, headers, body = original(path, items, query, key)
            if key:
                value = json.loads(body)
                value["total_count"] += 1
                body = json.dumps(value)
            return status, headers, body
        fake.page = short
        snap = github_source.snapshot(self.gh(fake), config())
        self.assertEqual(patrol.judge(snap, config())["pulls"][0]["state"], patrol.UNCONFIRMED)

    def test_next_link_outside_the_api_is_refused(self):
        fake = FakeGitHub()
        fake.request = lambda method, path, payload=None, text=False: (
            200, {"link": '<https://example.invalid/x?page=2>; rel="next"'}, "[]")
        with self.assertRaises(github_source.SourceError):
            self.gh(fake).pages("repos/x/y/pulls")

    def test_rate_limit_and_errors_make_the_pull_unconfirmed(self):
        for status, headers, kind in [(403, {"x-ratelimit-remaining": "0"}, "rate-limited"),
                                      (429, {"retry-after": "60"}, "rate-limited"),
                                      (403, {"retry-after": "30"}, "rate-limited"),
                                      (403, {"x-synthetic": "secondary"}, "rate-limited"),
                                      (502, {}, "http-502"), (404, {}, "http-404")]:
            with self.subTest(status=status, headers=headers):
                fake = FakeGitHub()
                self.ready_pull(fake)
                fake.fail[f"repos/{REPO}/pulls/5/reviews"] = (status, headers)
                snap = github_source.snapshot(self.gh(fake), config())
                result = patrol.judge(snap, config())
                self.assertEqual(result["result"], "unconfirmed")
                self.assertIn(kind, result["pulls"][0]["reasons"][0])

    def test_failed_pull_list_and_base_tip(self):
        fake = FakeGitHub()
        self.ready_pull(fake)
        fake.fail[f"repos/{REPO}/pulls"] = (403, {"x-ratelimit-remaining": "0"})
        snap = github_source.snapshot(self.gh(fake), config())
        self.assertEqual((snap["complete"], snap["pulls"]), (False, []))
        fake = FakeGitHub()
        self.ready_pull(fake)
        fake.fail[f"repos/{REPO}/branches/main"] = (500, {})
        result = patrol.judge(github_source.snapshot(self.gh(fake), config()), config())
        self.assertEqual(result["pulls"][0]["state"], patrol.UNCONFIRMED)

    def test_failed_issue_read_is_unconfirmed_and_posts_nothing(self):
        # PR38-R001: the issue named by the handoff could not be read.
        for failure in ("rate-limit", "missing"):
            with self.subTest(failure=failure):
                fake = FakeGitHub()
                fake.add_pull(5, head=HEAD2, comments=[raw_comment(1, handoff_body(head=HEAD))])
                if failure == "rate-limit":
                    fake.fail[f"repos/{REPO}/issues/7"] = (403, {"x-ratelimit-remaining": "0"})
                else:
                    fake.issues = {}
                code, out, _ = run(fake, "--post")
                self.assertEqual(code, patrol.EXIT_UNCONFIRMED)
                self.assertEqual(json.loads(out)["pulls"][0]["state"], patrol.UNCONFIRMED)
                self.assertEqual(fake.posted, [])

    def test_ci_evidence_is_read_from_the_gate_log_and_the_tested_merge(self):
        fake = FakeGitHub()
        self.ready_pull(fake)
        snap = github_source.snapshot(self.gh(fake), config())
        self.assertEqual(snap["pulls"][0]["ci_evidence"]["parents"], [BASE, HEAD])
        self.assertTrue(any(text for _, path, text in fake.calls if path.endswith("/logs")))
        self.assertEqual(patrol.judge(snap, config())["pulls"][0]["state"], patrol.READY)

    def test_gate_success_on_an_older_base_is_not_ready(self):
        # PR38-R007: same head, the base moved, a new ready for the new base, the old run's success.
        fake = FakeGitHub()
        fake.add_pull(5, head=HEAD, comments=[raw_comment(1, handoff_body(head=HEAD, base=BASE2))], gate_run=False)
        fake.add_gate(HEAD, tested_base=BASE)
        fake.tip = BASE2
        _, result = judge_all(fake)
        self.assertEqual(result["pulls"][0]["state"], patrol.FIXES)
        self.assertEqual(result["pulls"][0]["notices"][0]["kind"], "ci-other-base")
        fake.add_gate(HEAD, tested_base=BASE2)  # a re-run on the new base
        _, result = judge_all(fake)
        self.assertEqual(result["pulls"][0]["state"], patrol.READY)

    def test_ci_evidence_that_cannot_be_read_is_unconfirmed(self):
        for change in ("log-fails", "no-line", "two-lines", "commit-fails", "not-actions"):
            with self.subTest(change=change):
                fake = FakeGitHub()
                self.ready_pull(fake)
                run_id = fake.checks[HEAD][0]["id"]
                if change == "log-fails":
                    fake.fail[f"repos/{REPO}/actions/jobs/{run_id}/logs"] = (410, {})
                elif change == "no-line":
                    fake.logs[run_id] = "2026-01-01T00:00:00Z nothing here\n"
                elif change == "two-lines":
                    fake.logs[run_id] += f"2026-01-01T00:00:01Z   TESTED_SHA: {'8' * 40}\n"
                elif change == "commit-fails":
                    fake.commits.clear()
                else:
                    fake.checks[HEAD][0]["app"] = {"slug": "other-ci"}
                _, result = judge_all(fake)
                self.assertEqual(result["result"], "unconfirmed")
                self.assertEqual(result["pulls"][0]["state"], patrol.UNCONFIRMED)

    def test_transport_failure_is_unconfirmed(self):
        with mock.patch.object(github_source.subprocess, "run", side_effect=FileNotFoundError("gh")):
            gh = self.gh(github_source.GhTransport())
            snap = github_source.snapshot(gh, config())
        self.assertEqual(patrol.judge(snap, config())["result"], "unconfirmed")

    def test_gh_is_called_with_a_fixed_argument_list_and_no_shell(self):
        done = subprocess.CompletedProcess([], 0, stdout="HTTP/2.0 200 OK\r\nLink: <x>\r\n\r\n[]", stderr="")
        with mock.patch.object(github_source.subprocess, "run", return_value=done) as run_mock:
            status, headers, body = github_source.GhTransport().request("GET", "repos/a/b/pulls?state=open")
            github_source.GhTransport().request("GET", "repos/a/b/actions/jobs/1/logs", text=True)
        (first, kwargs), (second, _) = run_mock.call_args_list[0], run_mock.call_args_list[1]
        self.assertEqual(first[0][:5], ["gh", "api", "--include", "--method", "GET"])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(second[0][:3], ["gh", "api", "--allow-escape-sequences"])
        self.assertEqual((status, headers["link"], body), (200, "<x>", "[]"))
        with self.assertRaises(github_source.SourceError):
            github_source.parse_include("gh: not logged in", 1)


class PostingTests(unittest.TestCase):
    def stale(self, fake):
        # The handoff is for HEAD, the PR is at HEAD2: one stale-handoff notice is due.
        fake.add_pull(5, head=HEAD2, comments=[raw_comment(1, handoff_body(head=HEAD))])

    def test_dry_run_is_the_default_and_posts_nothing(self):
        fake = FakeGitHub()
        self.stale(fake)
        code, out, _ = run(fake)
        self.assertEqual(code, 0)
        self.assertEqual(fake.posted, [])
        self.assertEqual(json.loads(out)["posting"][0]["action"], "dry-run")
        self.assertFalse(any(method == "POST" for method, _, _ in fake.calls))

    def test_post_once_then_skip_the_same_head(self):
        fake = FakeGitHub()
        self.stale(fake)
        self.assertEqual(run(fake, "--post")[0], 0)
        self.assertEqual(len(fake.posted), 1)
        self.assertTrue(fake.posted[0][1].startswith(f"<!-- {NS}:patrol:v1 -->\n"))
        code, out, _ = run(fake, "--post")
        self.assertEqual(len(fake.posted), 1)
        self.assertEqual(json.loads(out)["pulls"][0]["notices"], [])

    def test_state_change_before_posting_is_judged_again(self):
        # PR38-R003: re-read and re-judge; post only if the same notice is still due.
        at = "2026-01-01T00:00:02Z"
        changes = {
            "new ready": lambda f: f.comments[5].append(raw_comment(2, handoff_body(head=HEAD2), at=at)),
            "working": lambda f: f.comments[5].append(
                raw_comment(2, handoff_body(status="working", head=HEAD2), at=at)),
            "unreadable review": lambda f: f.comments[5].append(
                raw_comment(2, "role: codex-reviewer\ndecision: accepted", at=at)),
            "head pushed": lambda f: f.pulls[5]["head"].update(sha="3" * 40),
            "base moved": lambda f: setattr(f, "tip", BASE2),
            "closed": lambda f: f.pulls[5].update(state="closed"),
        }
        for name, change in changes.items():
            with self.subTest(change=name):
                fake = FakeGitHub()
                self.stale(fake)
                gh, judgment = judge_all(fake)
                change(fake)
                outcome = github_source.post_notices(gh, config(), judgment, dry_run=False)
                self.assertIn(outcome[0]["action"], {"skipped-changed", "skipped-unconfirmed"})
                self.assertEqual(fake.posted, [])

    def test_ci_recovery_before_posting_cancels_ci_failed(self):
        fake = FakeGitHub()
        fake.add_pull(5, head=HEAD, comments=[raw_comment(1, handoff_body(head=HEAD))], gate_run=False)
        fake.add_gate(HEAD, conclusion="failure")
        gh, judgment = judge_all(fake)
        self.assertEqual(judgment["pulls"][0]["notices"][0]["kind"], "ci-failed")
        fake.add_gate(HEAD)  # a re-run succeeded
        outcome = github_source.post_notices(gh, config(), judgment, dry_run=False)
        self.assertEqual((outcome[0]["action"], outcome[0]["state"]), ("skipped-changed", patrol.READY))
        self.assertEqual(fake.posted, [])

    def test_failed_re_read_skips_posting(self):
        fake = FakeGitHub()
        self.stale(fake)
        gh, judgment = judge_all(fake)
        fake.fail[f"repos/{REPO}/issues/5/comments"] = (403, {"x-ratelimit-remaining": "0"})
        outcome = github_source.post_notices(gh, config(), judgment, dry_run=False)
        self.assertEqual(outcome[0]["action"], "skipped-unconfirmed")
        self.assertEqual(fake.posted, [])

    def race(self, lock_path):
        """Two patrols judge the same state, then both re-read before either posts (barrier)."""
        fake = FakeGitHub()
        self.stale(fake)
        gh, first = judge_all(fake)
        _, second = judge_all(fake)
        barrier = threading.Barrier(2, timeout=1.0)

        def wait(_):
            with contextlib.suppress(threading.BrokenBarrierError):
                barrier.wait()
        fake.on_recheck = wait
        results = []

        def patrol_run(judgment):
            results.extend(github_source.post_notices(gh, config(), judgment, dry_run=False,
                                                      lock_path=lock_path, lock_timeout=10))
        threads = [threading.Thread(target=patrol_run, args=(j,)) for j in (first, second)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)
        return fake, sorted(r["action"] for r in results)

    def test_concurrent_patrols_without_the_lock_would_post_twice(self):
        # Shows that the race test really races: without a lock both re-read, then both post.
        fake, actions = self.race(None)
        self.assertEqual(len(fake.posted), 2)
        self.assertEqual(actions, ["posted", "posted"])

    def test_concurrent_patrols_with_the_lock_post_once(self):
        # PR38-R005: the OS file lock serializes re-read, re-judge and post across patrols.
        with tempfile.TemporaryDirectory() as folder:
            fake, actions = self.race(Path(folder) / "patrol.lock")
        self.assertEqual(len(fake.posted), 1)
        self.assertEqual(actions, ["posted", "skipped-changed"])

    def test_lock_timeout_posts_nothing(self):
        fake = FakeGitHub()
        self.stale(fake)
        gh, judgment = judge_all(fake)
        done = []
        with tempfile.TemporaryDirectory() as folder:
            lock = Path(folder) / "patrol.lock"
            with github_source.post_lock(lock) as held:
                self.assertTrue(held)
                worker = threading.Thread(target=lambda: done.extend(github_source.post_notices(
                    gh, config(), judgment, dry_run=False, lock_path=lock, lock_timeout=0.2)))
                worker.start()
                worker.join(10)
        self.assertEqual(done[0]["action"], "skipped-locked")
        self.assertEqual(fake.posted, [])

    def test_unconfirmed_run_posts_nothing_and_exits_3(self):
        fake = FakeGitHub()
        self.stale(fake)
        fake.add_pull(6)
        fake.fail[f"repos/{REPO}/pulls/6/files"] = (429, {})
        code, out, _ = run(fake, "--post")
        self.assertEqual(code, patrol.EXIT_UNCONFIRMED)
        self.assertEqual(fake.posted, [])
        self.assertIn("not attempted", json.loads(out)["posting"])


if __name__ == "__main__":
    unittest.main()
