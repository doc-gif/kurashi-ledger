import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
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
    """An in-memory GitHub REST API: paginates with Link headers, can fail or rate-limit any path."""

    def __init__(self, page_size=2):
        self.page_size = page_size
        self.tip = BASE
        self.pulls = {}
        self.comments, self.reviews, self.files, self.checks = {}, {}, {}, {}
        self.fail = {}        # path prefix -> (status, headers)
        self.calls = []
        self.posted = []

    def add_pull(self, number, head=HEAD, comments=(), files=("src/a.ts",), checks=None):
        self.pulls[number] = {"number": number, "state": "open", "draft": False,
                              "head": {"sha": head}, "base": {"ref": "main"}}
        self.comments[number] = list(comments)
        self.reviews[number] = []
        self.files[number] = [{"filename": f} for f in files]
        self.checks[head] = [gate(head=head)] if checks is None else list(checks)

    def response(self, status, value, headers=None):
        return status, dict(headers or {}), json.dumps(value)

    def page(self, path, items, query, key=None):
        page = int(query.get("page", ["1"])[0])
        chunk = items[(page - 1) * self.page_size: page * self.page_size]
        headers = {}
        if page * self.page_size < len(items):
            headers["link"] = f'<{API}{path}?per_page=100&page={page + 1}>; rel="next"'
        value = {"total_count": len(items), key: chunk} if key else chunk
        return self.response(200, value, headers)

    def request(self, method, target, payload=None):
        self.calls.append((method, target))
        split = urlsplit(target if target.startswith("http") else API + target)
        path = split.path.lstrip("/")
        query = parse_qs(split.query)
        for prefix, (status, headers) in self.fail.items():
            if path.startswith(prefix):
                message = "You have exceeded a secondary rate limit" if "x-synthetic" in headers else "failure"
                return self.response(status, {"message": message}, headers)
        parts = path.split("/")
        if method == "POST" and parts[3] == "issues" and parts[5] == "comments":
            number = int(parts[4])
            self.comments[number].append(raw_comment(1000 + len(self.posted), payload["body"], at="2026-01-02T00:00:00Z"))
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
            return self.response(200, {"state": "open"})
        if parts[3] == "commits" and parts[5] == "check-runs":
            return self.page(path, self.checks.get(parts[4], []), query, key="check_runs")
        return self.response(404, {"message": "Not Found"})


def run(fake, *argv):
    out, err = io.StringIO(), io.StringIO()
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "patrol.json"
        path.write_text(json.dumps(config()), encoding="utf-8")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = github_source.main(["--config", str(path), *argv], transport=fake)
    return code, out.getvalue(), err.getvalue()


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
        self.assertEqual(patrol.judge(snap, config())["result"], "judged")

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
        fake.request = lambda method, path, payload=None: (
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

    def test_transport_failure_is_unconfirmed(self):
        with mock.patch.object(github_source.subprocess, "run", side_effect=FileNotFoundError("gh")):
            gh = self.gh(github_source.GhTransport())
            snap = github_source.snapshot(gh, config())
        self.assertEqual(patrol.judge(snap, config())["result"], "unconfirmed")

    def test_gh_is_called_with_a_fixed_argument_list_and_no_shell(self):
        done = subprocess.CompletedProcess([], 0, stdout="HTTP/2.0 200 OK\r\nLink: <x>\r\n\r\n[]", stderr="")
        with mock.patch.object(github_source.subprocess, "run", return_value=done) as run_mock:
            status, headers, body = github_source.GhTransport().request("GET", "repos/a/b/pulls?state=open")
        args, kwargs = run_mock.call_args
        self.assertEqual(args[0][:5], ["gh", "api", "--include", "--method", "GET"])
        self.assertNotIn("shell", kwargs)
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
        self.assertFalse(any(method == "POST" for method, _ in fake.calls))

    def test_post_once_then_skip_the_same_head(self):
        fake = FakeGitHub()
        self.stale(fake)
        self.assertEqual(run(fake, "--post")[0], 0)
        self.assertEqual(len(fake.posted), 1)
        self.assertIn(f"<!-- {NS}:patrol:v1 -->", fake.posted[0][1])
        code, out, _ = run(fake, "--post")
        self.assertEqual(len(fake.posted), 1)
        self.assertEqual(json.loads(out)["pulls"][0]["notices"], [])

    def test_concurrent_patrols_with_the_same_snapshot_post_once(self):
        fake = FakeGitHub()
        self.stale(fake)
        gh = github_source.GitHub(fake, REPO)
        # Both patrols judged before either posted.
        first = patrol.judge(github_source.snapshot(gh, config()), config())
        second = patrol.judge(github_source.snapshot(gh, config()), config())
        a = github_source.post_notices(gh, config(), first, dry_run=False)
        b = github_source.post_notices(gh, config(), second, dry_run=False)
        self.assertEqual([e["action"] for e in a + b], ["posted", "skipped-duplicate"])
        self.assertEqual(len(fake.posted), 1)

    def test_push_or_base_move_right_before_posting_skips(self):
        for change in ("head", "base", "closed"):
            with self.subTest(change=change):
                fake = FakeGitHub()
                self.stale(fake)
                gh = github_source.GitHub(fake, REPO)
                judgment = patrol.judge(github_source.snapshot(gh, config()), config())
                if change == "head":
                    fake.pulls[5]["head"]["sha"] = "3" * 40
                elif change == "base":
                    fake.tip = BASE2
                else:
                    fake.pulls[5]["state"] = "closed"
                outcome = github_source.post_notices(gh, config(), judgment, dry_run=False)
                self.assertEqual(outcome[0]["action"], "skipped-changed")
                self.assertEqual(fake.posted, [])

    def test_failed_re_read_skips_posting(self):
        fake = FakeGitHub()
        self.stale(fake)
        gh = github_source.GitHub(fake, REPO)
        judgment = patrol.judge(github_source.snapshot(gh, config()), config())
        fake.fail[f"repos/{REPO}/issues/5/comments"] = (403, {"x-ratelimit-remaining": "0"})
        outcome = github_source.post_notices(gh, config(), judgment, dry_run=False)
        self.assertEqual(outcome[0]["action"], "skipped-unconfirmed")
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
