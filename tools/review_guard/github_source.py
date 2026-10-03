"""Read GitHub for the PR patrol and, only when asked, post deduplicated notices.

Reading uses `gh api` GET requests (the caller's existing gh login; this module never reads a
token). Any failed, rate-limited or truncated read marks the data incomplete, and the judgment
becomes "unconfirmed" instead of "no PRs" or "no findings". Posting needs --post; the default is
a dry run. It never checks out, builds or runs code from a pull request, and never merges.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

import guard
import patrol

API = "https://api.github.com/"
MAX_PAGES = 30
LINK_NEXT = re.compile(r'<([^>]+)>;\s*rel="next"')


class SourceError(Exception):
    def __init__(self, kind, detail=""):
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind


class GhTransport:
    """Runs gh with a fixed argument list (no shell). Returns (status, headers, body)."""

    def __init__(self, timeout=60):
        self.timeout = timeout

    def request(self, method, path, payload=None):
        args = ["gh", "api", "--include", "--method", method,
                "-H", "Accept: application/vnd.github+json", path]
        if payload is not None:
            args += ["--input", "-"]
        try:
            done = subprocess.run(args, input=None if payload is None else json.dumps(payload),
                                  capture_output=True, text=True, encoding="utf-8", timeout=self.timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            raise SourceError("transport", type(exc).__name__) from exc
        return parse_include(done.stdout, done.returncode)


def parse_include(output, returncode=0):
    head, sep, body = output.replace("\r\n", "\n").partition("\n\n")
    lines = head.split("\n")
    match = re.match(r"HTTP/[0-9.]+ ([0-9]{3})", lines[0]) if sep else None
    if not match:
        raise SourceError("transport", f"no HTTP response (gh exit {returncode})")
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return int(match.group(1)), headers, body


def check_status(status, headers, path, body=""):
    if 200 <= status < 300:
        return
    if status == 429 or (status == 403 and (headers.get("x-ratelimit-remaining") == "0"
                                            or "retry-after" in headers or "rate limit" in body.lower())):
        raise SourceError("rate-limited", f"{path} (reset {headers.get('x-ratelimit-reset', '?')})")
    raise SourceError(f"http-{status}", path)


class GitHub:
    def __init__(self, transport, repository, max_pages=MAX_PAGES):
        self.transport, self.repo, self.max_pages = transport, repository, max_pages

    def get(self, path):
        status, headers, body = self.transport.request("GET", path)
        check_status(status, headers, path, body)
        try:
            return json.loads(body), headers
        except ValueError as exc:
            raise SourceError("invalid-response", path) from exc

    def pages(self, path, key=None):
        """Follow every rel="next" link. Stopping early is an error, never a short list."""
        items, url = [], path
        for _ in range(self.max_pages):
            value, headers = self.get(url)
            if key is not None:
                if not isinstance(value, dict) or not isinstance(value.get(key), list):
                    raise SourceError("invalid-response", path)
                total = value.get("total_count")
                value = value[key]
            if not isinstance(value, list):
                raise SourceError("invalid-response", path)
            items += value
            match = LINK_NEXT.search(headers.get("link", ""))
            if not match:
                if key is not None and isinstance(total, int) and total != len(items):
                    raise SourceError("incomplete", f"{path}: {len(items)} of {total}")
                return items
            url = match.group(1)
            if not url.startswith(API):
                raise SourceError("invalid-response", "next page outside the API")
        raise SourceError("incomplete", f"{path}: more than {self.max_pages} pages")

    def base_tip(self, branch):
        value, _ = self.get(f"repos/{self.repo}/branches/{branch}")
        sha = (value.get("commit") or {}).get("sha") if isinstance(value, dict) else None
        if not guard.sha(sha):
            raise SourceError("invalid-response", f"branch {branch}")
        return sha

    def post_comment(self, number, body):
        status, headers, text = self.transport.request(
            "POST", f"repos/{self.repo}/issues/{int(number)}/comments", {"body": body})
        check_status(status, headers, f"comment on #{number}", text)


def comment_items(issue_comments, reviews):
    items = [{"source": "comment", "id": c.get("id"), "created_at": c.get("created_at"),
              "author_association": c.get("author_association"), "login": (c.get("user") or {}).get("login"),
              "body": c.get("body")} for c in issue_comments]
    items += [{"source": "review", "id": r.get("id"), "created_at": r.get("submitted_at"),
               "author_association": r.get("author_association"), "login": (r.get("user") or {}).get("login"),
               "review_state": r.get("state"), "commit_id": r.get("commit_id"), "body": r.get("body")}
              for r in reviews]
    return items


def read_pull(gh, raw, config):
    number = raw.get("number")
    pull = {"number": number, "draft": bool(raw.get("draft")), "state": raw.get("state"),
            "head_sha": (raw.get("head") or {}).get("sha"), "base_ref": (raw.get("base") or {}).get("ref"),
            "complete": False, "errors": []}
    try:
        if not isinstance(number, int) or number <= 0 or not guard.sha(pull["head_sha"]) \
                or not patrol.branch_ok(pull["base_ref"]):
            raise SourceError("invalid-response", f"pull {number}")
        repo = gh.repo
        pull["files"] = [f.get("filename") for f in gh.pages(f"repos/{repo}/pulls/{number}/files?per_page=100")]
        pull["comments"] = comment_items(gh.pages(f"repos/{repo}/issues/{number}/comments?per_page=100"),
                                         gh.pages(f"repos/{repo}/pulls/{number}/reviews?per_page=100"))
        pull["check_runs"] = [{"id": r.get("id"), "name": r.get("name"), "status": r.get("status"),
                               "conclusion": r.get("conclusion"), "head_sha": r.get("head_sha")}
                              for r in gh.pages(f"repos/{repo}/commits/{pull['head_sha']}/check-runs?per_page=100",
                                                key="check_runs")]
        pull["complete"] = True
    except SourceError as exc:
        pull["errors"].append(str(exc))
    return pull


def snapshot(gh, config, numbers=None):
    snap = {"schema_version": 1, "repository": gh.repo, "complete": False, "errors": [],
            "base_tips": {}, "pulls": [], "issues": {}}
    try:
        raw = gh.pages(f"repos/{gh.repo}/pulls?state=open&per_page=100")
    except SourceError as exc:
        snap["errors"].append(f"open pulls: {exc}")
        return snap
    if numbers:
        missing = sorted(set(numbers) - {p.get("number") for p in raw})
        if missing:
            snap["errors"].append("not open or not found: " + ", ".join(f"#{n}" for n in missing))
        raw = [p for p in raw if p.get("number") in set(numbers)]
    for item in raw:
        pull = read_pull(gh, item, config)
        ref = pull["base_ref"]
        if patrol.branch_ok(ref) and ref not in snap["base_tips"]:
            try:
                snap["base_tips"][ref] = gh.base_tip(ref)
            except SourceError as exc:
                snap["errors"].append(f"base {ref}: {exc}")
                snap["base_tips"][ref] = None
        for ref_number in issue_refs(pull, config):
            if ref_number not in snap["issues"]:
                try:
                    value, _ = gh.get(f"repos/{gh.repo}/issues/{int(ref_number)}")
                    snap["issues"][ref_number] = value.get("state") if isinstance(value, dict) else None
                except SourceError:
                    snap["issues"][ref_number] = None
        snap["pulls"].append(pull)
    snap["issues"] = {k: v for k, v in snap["issues"].items() if v is not None}
    snap["complete"] = not snap["errors"]
    return snap


def issue_refs(pull, config):
    refs = []
    try:
        records = patrol.collect(pull, config)["handoffs"]
    except (patrol.Invalid, KeyError, TypeError):
        return refs
    for record in records[-1:]:
        refs += patrol.ISSUE_REF.findall(record["task_id"])
    return refs


def post_notices(gh, config, judgment, dry_run=True):
    """Post each new notice once. Re-read the PR, base tip and comments right before posting;
    skip on any change or read failure. Concurrent patrols see each other's marker on re-read."""
    outcome = []
    for pull in judgment["pulls"]:
        for notice in pull.get("notices", []):
            entry = {"pr": pull["number"], "kind": notice["kind"], "head_sha": notice["head_sha"],
                     "base_sha": notice["base_sha"]}
            try:
                value, _ = gh.get(f"repos/{gh.repo}/pulls/{int(pull['number'])}")
                fresh = read_pull(gh, value, config)
                tip = gh.base_tip(fresh["base_ref"]) if patrol.branch_ok(fresh["base_ref"]) else None
                if not fresh["complete"]:
                    entry["action"] = "skipped-unconfirmed"
                elif value.get("state") != "open" or fresh["head_sha"] != notice["head_sha"] \
                        or tip != notice["base_sha"]:
                    entry["action"] = "skipped-changed"
                elif (notice["kind"], notice["head_sha"], notice["base_sha"]) in \
                        patrol.collect(fresh, config)["notices"]:
                    entry["action"] = "skipped-duplicate"
                elif dry_run:
                    entry["action"] = "dry-run"
                else:
                    gh.post_comment(pull["number"], notice["body"])
                    entry["action"] = "posted"
            except SourceError as exc:
                entry["action"] = "skipped-unconfirmed"
                entry["error"] = str(exc)
            outcome.append(entry)
    return outcome


def main(argv=None, transport=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=".review/patrol.json")
    parser.add_argument("--pr", type=int, action="append", help="limit to these open PR numbers")
    parser.add_argument("--snapshot-out", help="also write the fetched snapshot (new file only)")
    parser.add_argument("--post", action="store_true", help="post new notices (default: dry run)")
    args = parser.parse_args(argv)
    try:
        guard.require_runtime()
        config = patrol.load_config(guard.read_json(args.config))
        gh = GitHub(transport or GhTransport(), config["repository"])
        snap = snapshot(gh, config, args.pr)
        if args.snapshot_out:
            with Path(args.snapshot_out).open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(snap, ensure_ascii=False, indent=2) + "\n")
        result = patrol.judge(snap, config)
        if result["result"] == "unconfirmed":
            result["posting"] = "not attempted: data is unconfirmed"
        else:
            result["posting"] = post_notices(gh, config, result, dry_run=not args.post)
        for pull in result["pulls"]:
            for notice in pull.get("notices", []):
                notice.pop("body", None)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return patrol.EXIT_UNCONFIRMED if result["result"] == "unconfirmed" else 0
    except (guard.Invalid, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"review-patrol: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
