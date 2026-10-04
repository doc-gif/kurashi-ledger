"""Read GitHub for the PR patrol and print a read-only report.

Reading uses `gh api` GET requests (the caller's existing gh login; this module never reads a
token). Any failed, rate-limited or truncated read marks the data incomplete, and the judgment
becomes "unconfirmed" instead of "no PRs" or "no findings". It never writes to GitHub: posting
notifications belongs to the Issue #45 receiver (docs/review-dispatch-design.md). It never checks
out, builds or runs code from a pull request, and never merges.
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
MAX_LOG = 5 * 1_048_576
MAX_PR_FILES = 3000  # the documented maximum of GET /pulls/{n}/files
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
LINK_NEXT = re.compile(r'<([^>]+)>;\s*rel="next"')


class SourceError(Exception):
    def __init__(self, kind, detail=""):
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind


class GhTransport:
    """Runs gh with a fixed argument list (no shell). Returns (status, headers, body)."""

    def __init__(self, timeout=60):
        self.timeout = timeout

    def request(self, method, path, text=False):
        if method != "GET":
            raise SourceError("refused", "the patrol only reads")
        args = ["gh", "api", "--include", "--method", "GET",
                "-H", "Accept: application/vnd.github+json", path]
        if text:
            # Job logs contain terminal escape sequences; gh refuses to print them otherwise.
            # They are stripped before parsing and never shown.
            args.insert(2, "--allow-escape-sequences")
        try:
            done = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                  encoding="utf-8", timeout=self.timeout)
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

    def get_text(self, path):
        status, headers, body = self.transport.request("GET", path, text=True)
        check_status(status, headers, path, body)
        if len(body) > MAX_LOG:
            raise SourceError("invalid-response", f"{path}: log too large")
        return ANSI.sub("", body)

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



def comment_items(issue_comments, reviews):
    items = [{"source": "comment", "id": c.get("id"), "created_at": c.get("created_at"),
              "author_association": c.get("author_association"), "login": (c.get("user") or {}).get("login"),
              "body": c.get("body")} for c in issue_comments]
    items += [{"source": "review", "id": r.get("id"), "created_at": r.get("submitted_at"),
               "author_association": r.get("author_association"), "login": (r.get("user") or {}).get("login"),
               "review_state": r.get("state"), "commit_id": r.get("commit_id"), "body": r.get("body")}
              for r in reviews]
    return items


def ci_evidence(gh, run, config):
    """The commit that the latest successful required run tested, and that commit's parents.

    The run's log names the tested commit in the environment variable `tested_commit_env`
    (this repository's Quality gate prints TESTED_SHA). Any doubt raises, so the PR becomes
    unconfirmed rather than ready.
    """
    if (run.get("app") or {}).get("slug") != "github-actions" or not isinstance(run.get("id"), int):
        raise SourceError("ci-evidence", "the required check is not a GitHub Actions job")
    log = gh.get_text(f"repos/{gh.repo}/actions/jobs/{run['id']}/logs")
    name = re.escape(config["tested_commit_env"])
    found = set(re.findall(rf"^\S+\s+{name}: ([0-9a-f]{{40}})\s*$", log, flags=re.M))
    if len(found) != 1:
        raise SourceError("ci-evidence", f"{config['tested_commit_env']} not found exactly once in the log")
    tested = found.pop()
    value, _ = gh.get(f"repos/{gh.repo}/commits/{tested}")
    parents = [p.get("sha") for p in value.get("parents", [])] if isinstance(value, dict) else None
    if not parents or not all(guard.sha(p) for p in parents):
        raise SourceError("ci-evidence", f"parents of {tested} not read")
    return {"check_run_id": run["id"], "tested_sha": tested, "parents": parents}


def read_pull(gh, raw, config, tips, issues):
    """Read one PR completely, or record why not. tips and issues are per-run caches."""
    number = raw.get("number")
    pull = {"number": number, "draft": bool(raw.get("draft")), "state": raw.get("state"),
            "head_sha": (raw.get("head") or {}).get("sha"), "base_ref": (raw.get("base") or {}).get("ref"),
            "complete": False, "errors": []}
    try:
        if not isinstance(number, int) or number <= 0 or not guard.sha(pull["head_sha"]) \
                or not patrol.branch_ok(pull["base_ref"]):
            raise SourceError("invalid-response", f"pull {number}")
        repo = gh.repo
        if pull["base_ref"] not in tips:
            tips[pull["base_ref"]] = gh.base_tip(pull["base_ref"])
        detail, _ = gh.get(f"repos/{repo}/pulls/{number}")
        changed = detail.get("changed_files") if isinstance(detail, dict) else None
        if not isinstance(changed, int) or (detail.get("head") or {}).get("sha") != pull["head_sha"]:
            raise SourceError("incomplete", f"pull {number} detail (changed_files or head) not read")
        files = gh.pages(f"repos/{repo}/pulls/{number}/files?per_page=100")
        # The files API stops at a fixed maximum without saying so; only a full count proves completeness.
        if len(files) != changed or changed > MAX_PR_FILES:
            raise SourceError("incomplete", f"pull {number} files: read {len(files)} of {changed}")
        pull["files"] = [f.get("filename") for f in files]
        pull["comments"] = comment_items(gh.pages(f"repos/{repo}/issues/{number}/comments?per_page=100"),
                                         gh.pages(f"repos/{repo}/pulls/{number}/reviews?per_page=100"))
        runs = gh.pages(f"repos/{repo}/commits/{pull['head_sha']}/check-runs?per_page=100", key="check_runs")
        pull["check_runs"] = [{"id": r.get("id"), "name": r.get("name"), "status": r.get("status"),
                               "conclusion": r.get("conclusion"), "head_sha": r.get("head_sha")} for r in runs]
        latest = max((r for r in runs if r.get("name") == config["required_check"]
                      and r.get("head_sha") == pull["head_sha"] and isinstance(r.get("id"), int)),
                     key=lambda r: r["id"], default=None)
        if latest and latest.get("status") == "completed" and latest.get("conclusion") == "success":
            pull["ci_evidence"] = ci_evidence(gh, latest, config)
        for ref in issue_refs(pull, config):
            if ref not in issues:
                value, _ = gh.get(f"repos/{repo}/issues/{int(ref)}")
                if not isinstance(value, dict) or value.get("state") not in {"open", "closed"}:
                    raise SourceError("invalid-response", f"issue #{ref}")
                issues[ref] = value["state"]
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
        snap["pulls"].append(read_pull(gh, item, config, snap["base_tips"], snap["issues"]))
    snap["complete"] = not snap["errors"]
    return snap


def issue_refs(pull, config):
    records = patrol.collect(pull, config)["handoffs"]
    return patrol.ISSUE_REF.findall(records[-1]["task_id"]) if records else []


def main(argv=None, transport=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=".review/patrol.json")
    parser.add_argument("--pr", type=int, action="append", help="limit to these open PR numbers")
    parser.add_argument("--snapshot-out", help="also write the fetched snapshot (new file only)")
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
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return patrol.EXIT_UNCONFIRMED if result["result"] == "unconfirmed" else 0
    except (guard.Invalid, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"review-patrol: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
