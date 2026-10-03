"""PR patrol judgment. Python 3.11+, standard library only.

The core is pure: it reads a snapshot (already fetched GitHub data) and a config, and returns
a judgment. It never reads the clock, never contacts the network, never posts, and never runs
code from a pull request. github_source.py fetches the snapshot and is the only optional writer.
"""
import argparse
import fnmatch
import json
from pathlib import Path
import re
import sys

import guard

Invalid = guard.Invalid
require = guard.require

# Classification of an open PR. Only the first three are the ledger's categories; the others
# say why none of them applies yet. None of them is an approval or a permission to merge.
READY = "ready-for-review"        # 着手候補: the reviewer may start (valid handoff, CI success)
FIXES = "awaiting-fixes"          # 修正待ち: the implementer has to act
OWNER = "awaiting-owner"          # 判断待ち: needs-owner was recorded
IN_PROGRESS = "in-progress"       # no valid ready-for-review; the implementer is (or may be) working
WAITING_CI = "waiting-ci"         # ready for this head/base, the required check has not finished
ACCEPTED = "accepted"             # a reviewer accepted this head/base; merge conditions are separate
UNCONFIRMED = "unconfirmed"       # some data could not be read; never read as "nothing to do"

DECISIONS = {"accepted", "changes-requested", "needs-owner"}
WORKER_STATUSES = {"ready-for-review", "working", "needs-owner", "blocked", "paused"}
# The leading status word counts ("working（中断中）" is working). "ready-for-reviewではない" does not match.
STATUS = re.compile(r"(ready-for-review|working|needs-owner|blocked|paused)(?![\w-])")
FIELD = re.compile(r"([a-z_]+):[ \t]*(.*)")
ISSUE_REF = re.compile(r"#([1-9][0-9]{0,8})\b")
MAX_BODY = 65_536
MAX_SNAPSHOT = 16 * 1_048_576
EXIT_UNCONFIRMED = 3  # 0: judged, 1: invalid input, 2: usage (argparse), 3: unconfirmed
NOTICE_TEXT = {
    "stale-handoff": "最新のhead/baseに対応するready-for-reviewの引継ぎがない（古い引継ぎは使わない）。"
                     "新しいhead/baseで検証し、引継ぎを出し直してほしい。",
    "ci-failed": "このhead/baseの必須のcheckが成功していない。修正して、新しいhead/baseで引き継いでほしい。",
    "ci-other-base": "必須のcheckの最新の成功は、いまのbaseの先端とのmerge commitを試験したものではない。"
                     "最新のbaseで試験し直し、引継ぎを出し直してほしい。",
}


def load_config(value):
    require(isinstance(value, dict) and value.get("schema_version") == 1, "unsupported patrol config")
    ns = value.get("marker_namespace")
    require(isinstance(ns, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", ns) is not None,
            "marker_namespace must be lowercase letters, digits and hyphens")
    require(guard.text(value.get("repository")) and re.fullmatch(
        r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", value["repository"]) is not None, "invalid repository")
    require(guard.text(value.get("required_check")), "missing required_check")
    require(isinstance(value.get("tested_commit_env"), str)
            and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", value["tested_commit_env"]) is not None,
            "tested_commit_env must name the environment variable that the required check logs")
    logins = value.get("trusted_logins", [])
    require(isinstance(logins, list) and all(guard.text(item) for item in logins),
            "trusted_logins must be a list of strings")
    roles = value.get("reviewer_roles")
    require(isinstance(roles, dict) and roles and all(
        guard.text(k) and guard.text(v) for k, v in roles.items()), "reviewer_roles must map role to reviewer")
    for key in ("trusted_associations", "copilot_logins", "policy_paths"):
        require(isinstance(value.get(key), list) and value[key] and all(
            guard.text(item) for item in value[key]), f"{key} must be a non-empty list of strings")
    require(all(guard.path_ok(p) for p in value["policy_paths"]), "invalid policy_paths")
    return value


def branch_ok(value):
    return (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", value) is not None
            and ".." not in value and not value.startswith(("/", "-")) and not value.endswith("/"))


def markers(ns):
    return {f"<!-- {ns}:{kind}:v1 -->": kind for kind in ("handoff", "review", "patrol")}


def parse_records(body, ns):
    """Return (records, unmarked_role, misplaced) for one body.

    Only a marker on the first non-empty line starts a record (docs/pr-review-loop.md: the marker
    is the first line). It is followed by `key: value` lines up to the first line that is not one.
    A marker on any later line is an example or a quote and is never read as a record; `misplaced`
    reports it. `unmarked_role` is the role when the first line is `role: ...` without a marker.
    Text is never interpreted further.
    """
    if not isinstance(body, str):
        return [], None, False
    if len(body) > MAX_BODY:
        return [{"kind": None, "fields": {}, "error": "body too large"}], None, False
    known = markers(ns)
    lines = [line.strip() for line in body.replace("\r\n", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    if not lines:
        return [], None, False
    misplaced = any(line in known for line in lines[1:])
    if lines[0] in known:
        fields, error = {}, None
        for line in lines[1:]:
            match = FIELD.fullmatch(line)
            if not match:
                break
            key, value = match.group(1), match.group(2).strip()
            if key in fields:
                error = f"duplicate field {key}"
            fields[key] = value
        return [{"kind": known[lines[0]], "fields": fields, "error": error}], None, misplaced
    first = FIELD.fullmatch(lines[0])
    unmarked = first.group(2).strip() if first and first.group(1) == "role" else None
    return [], unmarked, misplaced


def handoff(fields):
    match = STATUS.match(fields.get("worker_status", ""))
    status = match.group(1) if match else None
    require(fields.get("role") == "implementer", "handoff role must be implementer")
    require(status in WORKER_STATUSES, "unknown worker_status")
    require(guard.text(fields.get("agent_id")) and guard.text(fields.get("task_id")), "missing agent_id/task_id")
    if status == "ready-for-review":
        require(guard.sha(fields.get("head_sha")) and guard.sha(fields.get("base_sha")),
                "ready-for-review needs 40-character head_sha and base_sha")
    return {"worker_status": status, "agent_id": fields["agent_id"], "task_id": fields["task_id"],
            "head_sha": fields.get("head_sha") if guard.sha(fields.get("head_sha")) else None,
            "base_sha": fields.get("base_sha") if guard.sha(fields.get("base_sha")) else None}


def review(fields, roles):
    require(fields.get("role") in roles, "unknown reviewer role")
    require(fields.get("decision") in DECISIONS, "unknown decision")
    require(guard.text(fields.get("agent_id")), "missing agent_id")
    require(guard.sha(fields.get("head_sha")) and guard.sha(fields.get("base_sha")),
            "review needs 40-character head_sha and base_sha")
    return {"reviewer": roles[fields["role"]], "role": fields["role"], "agent_id": fields["agent_id"],
            "decision": fields["decision"], "head_sha": fields["head_sha"], "base_sha": fields["base_sha"]}


def notice_record(fields):
    require(fields.get("kind") in NOTICE_TEXT, "unknown notice kind")
    require(guard.sha(fields.get("head_sha")) and guard.sha(fields.get("base_sha")), "notice needs SHAs")
    return (fields["kind"], fields["head_sha"], fields["base_sha"])


def notice_body(ns, number, kind, head, base):
    """Fixed text and SHAs only. Nothing written by others is copied into the body."""
    require(kind in NOTICE_TEXT and guard.sha(head) and guard.sha(base) and isinstance(number, int),
            "invalid notice")
    return "\n".join([f"<!-- {ns}:patrol:v1 -->", f"kind: {kind}", f"pr: {number}",
                      f"head_sha: {head}", f"base_sha: {base}", "",
                      NOTICE_TEXT[kind],
                      "この通知は巡回の機械判定で、承認・マージの許可ではない。同じhead/baseには1回だけ投稿する。"])


def order(item):
    ident = item.get("id")
    return (str(item.get("created_at") or item.get("at")), ident if isinstance(ident, int) else 0)


def collect(pull, config):
    """Turn trusted comments and reviews into ordered records. Roles come from the body only.

    An unreadable handoff is kept as a handoff without a status, so it still supersedes an
    earlier ready-for-review. Unreadable or unmarked reviewer records are kept in `unreadable`,
    so a later judgment can refuse to call the PR ready while they are unexplained.
    """
    ns, roles = config["marker_namespace"], config["reviewer_roles"]
    trusted = set(config["trusted_associations"])
    trusted_logins = set(config.get("trusted_logins", []))
    out = {"handoffs": [], "reviews": [], "unreadable": [], "notices": set(), "warnings": []}
    for item in sorted(pull.get("comments", []), key=order):
        records, unmarked, misplaced = parse_records(item.get("body"), ns)
        where = f"{item.get('source', 'comment')} {item.get('id')}"
        at = {"at": item.get("created_at"), "id": item.get("id") if isinstance(item.get("id"), int) else 0}
        if item.get("author_association") not in trusted and item.get("login") not in trusted_logins:
            if records or unmarked or misplaced:
                out["warnings"].append(f"{where}: record from an untrusted author association ignored")
            continue
        if misplaced:
            out["warnings"].append(f"{where}: a marker that is not on the first line is not a record")
        if unmarked:
            out["warnings"].append(f"{where}: role {unmarked!r} without the marker; not counted as a record")
            if unmarked in roles:
                out["unreadable"].append(dict(at, reason=f"{where}: reviewer text without the marker"))
        for record in records:
            try:
                require(record["error"] is None and record["kind"], record.get("error") or "invalid record")
                if record["kind"] == "handoff":
                    out["handoffs"].append(dict(handoff(record["fields"]), **at))
                elif record["kind"] == "review":
                    out["reviews"].append(dict(review(record["fields"], roles), **at))
                else:
                    out["notices"].add(notice_record(record["fields"]))
            except Invalid as exc:
                reason = f"{where}: {record['kind'] or 'unknown'} record not readable ({exc})"
                out["warnings"].append(reason)
                if record["kind"] == "handoff":
                    out["handoffs"].append(dict(at, worker_status=None, agent_id=None, task_id="",
                                                head_sha=None, base_sha=None, invalid=str(exc)))
                elif record["kind"] != "patrol":
                    out["unreadable"].append(dict(at, reason=reason))
    return out


def required_check(pull, config, base_tip):
    """The latest run of the required check for this head, and whether it tested this base.

    A pull_request run tests a merge commit. Its success counts only when the commit it tested
    (pull["ci_evidence"], read from the run) has exactly the parents [base tip, head].
    """
    runs = [r for r in pull.get("check_runs", [])
            if r.get("name") == config["required_check"] and r.get("head_sha") == pull["head_sha"]]
    if not runs:
        return {"status": "missing"}
    latest = max(runs, key=lambda r: r.get("id") if isinstance(r.get("id"), int) else 0)
    if latest.get("status") != "completed":
        return {"status": "pending", "id": latest.get("id")}
    if latest.get("conclusion") != "success":
        return {"status": "failure", "conclusion": latest.get("conclusion"), "id": latest.get("id")}
    evidence = pull.get("ci_evidence")
    if not isinstance(evidence, dict) or evidence.get("check_run_id") != latest.get("id") \
            or not guard.sha(evidence.get("tested_sha")) or not isinstance(evidence.get("parents"), list):
        return {"status": "unconfirmed", "id": latest.get("id"),
                "reason": "the commit tested by the latest successful run was not read"}
    if evidence["parents"] != [base_tip, pull["head_sha"]]:
        return {"status": "other-base", "id": latest.get("id"), "tested_sha": evidence["tested_sha"],
                "parents": evidence["parents"]}
    return {"status": "success", "id": latest.get("id"), "tested_sha": evidence["tested_sha"]}


def copilot(pull, config):
    logins = set(config["copilot_logins"])
    reviews = [c for c in pull.get("comments", []) if c.get("source") == "review" and c.get("login") in logins]
    current = [c for c in reviews if c.get("commit_id") == pull["head_sha"]]
    return {"status": "reviewed-current-head" if current else "not-reviewed-current-head",
            "reviews_on_head": len(current),
            "note": "Copilotは補助。未実施・利用不可は判定を変えず、承認にも数えない。"}


def judge_pull(pull, base_tip, config, issues):
    result = {"number": pull.get("number"), "head_sha": pull.get("head_sha"), "base_ref": pull.get("base_ref"),
              "base_tip": base_tip, "draft": bool(pull.get("draft")), "reasons": [], "warnings": [],
              "notices": []}
    errors = list(pull.get("errors", []))
    if base_tip is None:
        errors.append(f"base branch {pull.get('base_ref')} tip not read")
    if not guard.sha(pull.get("head_sha")):
        errors.append("head_sha not read")
    if errors or not pull.get("complete", False):
        result.update(state=UNCONFIRMED, reasons=errors or ["incomplete data"])
        return result
    files = pull.get("files", [])
    result["policy_files"] = sorted({f for f in files for p in config["policy_paths"]
                                     if fnmatch.fnmatchcase(f, p)})
    if result["policy_files"]:
        result["warnings"].append("workflow・検査器・条件・原因台帳を変える。CIの合格は迂回を防がないので、"
                                  "独立レビューで変更そのものを確かめる")
    records = collect(pull, config)
    result["warnings"] += records["warnings"]
    result["copilot"] = copilot(pull, config)
    head, number = pull["head_sha"], pull.get("number")
    ns = config["marker_namespace"]

    def finish(state, reason, notice=None):
        result["state"] = state
        result["reasons"].append(reason)
        if notice:
            key = (notice, head, base_tip)
            if key not in records["notices"]:
                result["notices"].append({"kind": notice, "head_sha": head, "base_sha": base_tip,
                                          "body": notice_body(ns, number, notice, head, base_tip)})
        return result

    if not records["handoffs"]:
        return finish(IN_PROGRESS, "no handoff; elapsed time or Open state is not completion")
    latest = records["handoffs"][-1]
    result["handoff"] = {k: latest[k] for k in ("worker_status", "agent_id", "task_id", "head_sha", "base_sha", "id")}
    if latest.get("invalid"):
        return finish(IN_PROGRESS, "the latest handoff is not readable; earlier handoffs are not used")
    unread = [ref for ref in ISSUE_REF.findall(latest["task_id"]) if issues.get(ref) is None]
    if unread:
        result.update(state=UNCONFIRMED, reasons=["issues named by the latest handoff were not read: "
                                                  + ", ".join(f"#{ref}" for ref in unread)])
        return result
    for ref in ISSUE_REF.findall(latest["task_id"]):
        if issues[ref] != "open" and int(ref) != number:
            result["warnings"].append(f"issue #{ref} named by the handoff is {issues[ref]}")
    if latest["worker_status"] == "needs-owner":
        return finish(OWNER, "the latest handoff is needs-owner")
    if latest["worker_status"] != "ready-for-review":
        return finish(IN_PROGRESS, f"the latest handoff is {latest['worker_status']}")
    if result["draft"]:
        # Draft means work in progress (AGENTS.md); a ready-for-review is honoured only when Open.
        return finish(IN_PROGRESS, "the PR is a Draft; a ready-for-review counts only on an Open PR")
    since = order(latest)
    unreadable = [u["reason"] for u in records["unreadable"] if order(u) >= since]
    if unreadable:
        result.update(state=UNCONFIRMED, reasons=["reviewer text after the ready-for-review is not readable; "
                                                  "a human has to check it"] + unreadable)
        return result
    if latest["head_sha"] != head:
        return finish(FIXES, "the ready-for-review is for an older head (pushed after the handoff)", "stale-handoff")
    if latest["base_sha"] != base_tip:
        return finish(FIXES, "the ready-for-review is for an older base (base moved after the handoff)",
                      "stale-handoff")
    after = [r for r in records["reviews"]
             if r["head_sha"] == head and r["base_sha"] == base_tip and order(r) >= since]
    for r in after:
        if r["agent_id"] == latest["agent_id"]:
            result["warnings"].append(f"review {r['id']} has the implementer's agent_id; not counted")
    independent = [r for r in after if r["agent_id"] != latest["agent_id"]]
    older = [r["id"] for r in records["reviews"] if r not in after]
    if older:
        result["outdated_reviews"] = older
    ci = required_check(pull, config, base_tip)
    result["ci"] = ci
    if independent:
        last = independent[-1]
        result["review"] = {k: last[k] for k in ("role", "agent_id", "decision", "id")}
        if last["decision"] == "needs-owner":
            return finish(OWNER, "the reviewer recorded needs-owner for this head/base")
        if last["decision"] == "changes-requested":
            return finish(FIXES, "the reviewer requested changes for this head/base")
    if ci["status"] == "failure":
        return finish(FIXES, f"required check {config['required_check']} is {ci.get('conclusion')}", "ci-failed")
    if ci["status"] == "other-base":
        return finish(FIXES, f"required check {config['required_check']} succeeded on a merge with another base",
                      "ci-other-base")
    if ci["status"] == "unconfirmed":
        result.update(state=UNCONFIRMED, reasons=[ci["reason"]])
        return result
    if ci["status"] in {"missing", "pending"}:
        return finish(WAITING_CI, f"required check {config['required_check']} is {ci['status']} for this head")
    if independent:
        return finish(ACCEPTED, "accepted for this head/base; merge conditions (AGENTS.md) are checked separately")
    return finish(READY, "ready-for-review matches the current head and base tip, and the required check succeeded")


def judge(snapshot, config):
    """Judge every PR in a snapshot. Missing or partial data makes the run unconfirmed."""
    config = load_config(config)
    require(isinstance(snapshot, dict) and snapshot.get("schema_version") == 1, "unsupported snapshot")
    pulls = snapshot.get("pulls")
    require(isinstance(pulls, list), "snapshot pulls must be a list")
    tips = snapshot.get("base_tips") or {}
    issues = {str(k): v for k, v in (snapshot.get("issues") or {}).items()}
    judged = [judge_pull(p, tips.get(p.get("base_ref")) if guard.sha(tips.get(p.get("base_ref"))) else None,
                         config, issues) for p in pulls]
    errors = list(snapshot.get("errors", []))
    complete = bool(snapshot.get("complete")) and not errors
    unconfirmed = not complete or any(p["state"] == UNCONFIRMED for p in judged)
    return {"result": "unconfirmed" if unconfirmed else "judged", "repository": config["repository"],
            "errors": errors if errors or complete else ["snapshot is incomplete"],
            "pulls": judged,
            "notice": "機械判定の補助。承認・マージの許可ではなく、取得の失敗は「PRなし」「指摘なし」とみなさない。"}


def read_snapshot(path):
    """Like guard.read_json (no symlinks, duplicate keys rejected) with a larger size limit."""
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result
    path = Path(path)
    require(not path.is_symlink(), "JSON symlinks are not accepted")
    require(path.stat().st_size <= MAX_SNAPSHOT, "snapshot exceeds 16 MiB limit")
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["judge"])
    parser.add_argument("--snapshot", required=True, help="JSON written by github_source.py --snapshot-out")
    parser.add_argument("--config", default=".review/patrol.json")
    args = parser.parse_args(argv)
    try:
        guard.require_runtime()
        result = judge(read_snapshot(args.snapshot), guard.read_json(args.config))
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return EXIT_UNCONFIRMED if result["result"] == "unconfirmed" else 0
    except (Invalid, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"review-patrol: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
