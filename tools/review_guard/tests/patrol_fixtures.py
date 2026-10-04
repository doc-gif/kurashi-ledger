"""Synthetic patrol fixtures. Every PR number, SHA, agent id and text here is made up."""
import copy
from pathlib import Path
import sys

TOOL = Path(__file__).resolve().parents[1]
if str(TOOL) not in sys.path:
    sys.path.insert(0, str(TOOL))

import github_source  # noqa: E402  (the tool directory is on sys.path only from here)
import patrol  # noqa: E402


NS = "example-ledger"
HEAD = "1" * 40
HEAD2 = "2" * 40
BASE = "a" * 40
BASE2 = "b" * 40
IMPLEMENTER = "claude-session/alpha"
REVIEWER = "codex-session/beta"
LOGIN = "shared-account"  # everyone posts from the same account; roles come from the body

CONFIG = {
    "schema_version": 1,
    "repository": "example-owner/example-repo",
    "marker_namespace": NS,
    "required_check": "Quality gate",
    "tested_commit_env": "TESTED_SHA",
    "trusted_logins": {"example-codex[bot]": "codex", "example-claude[bot]": "claude"},
    "agent_sides": {"codex": ["codex"], "claude": ["claude"]},
    "reviewer_roles": {"codex-reviewer": "codex", "claude-reviewer": "claude", "reviewer": "*"},
    "trusted_associations": ["OWNER", "MEMBER", "COLLABORATOR"],
    "copilot_logins": ["copilot-pull-request-reviewer[bot]"],
    "policy_paths": [".github/**", "tools/review_guard/**", ".review/invariants.json"],
}


def config():
    return copy.deepcopy(CONFIG)


def handoff_body(status="ready-for-review", head=HEAD, base=BASE, agent=IMPLEMENTER, task="T99（Issue #7）"):
    return "\n".join([f"<!-- {NS}:handoff:v1 -->", "role: implementer", f"agent_id: {agent}",
                      f"task_id: {task}", "spec_revision: main@" + BASE, f"worker_status: {status}",
                      f"head_sha: {head}", f"base_sha: {base}", "", "変更内容: 合成の例"])


def review_body(decision="accepted", head=HEAD, base=BASE, role="codex-reviewer", agent=REVIEWER):
    return "\n".join([f"<!-- {NS}:review:v1 -->", f"role: {role}", f"agent_id: {agent}",
                      f"head_sha: {head}", f"base_sha: {base}", f"decision: {decision}", "",
                      "確認した範囲・検証証跡: 合成の例"])


def comment(cid, at, body, association="OWNER", source="comment", login=LOGIN, **extra):
    item = {"source": source, "id": cid, "created_at": at, "author_association": association,
            "login": login, "body": body}
    item.update(extra)
    return item


def gate(conclusion="success", head=HEAD, run_id=10, status="completed"):
    return {"id": run_id, "name": "Quality gate", "status": status,
            "conclusion": conclusion if status == "completed" else None, "head_sha": head}


def evidence_for(checks, head, ci_base):
    """What the source reads for the latest successful gate: the tested merge and its parents."""
    gates = [c for c in checks if c["name"] == "Quality gate" and c["head_sha"] == head]
    if not gates:
        return None
    latest = max(gates, key=lambda c: c["id"])
    if latest["status"] != "completed" or latest["conclusion"] != "success":
        return None
    return {"check_run_id": latest["id"], "tested_sha": "9" * 40, "parents": [ci_base, head]}


def pull(comments=(), head=HEAD, checks=None, files=("src/example.ts",), number=5, draft=False, ci_base=BASE):
    checks = [gate(head=head)] if checks is None else list(checks)
    result = {"number": number, "draft": draft, "state": "open", "head_sha": head, "base_ref": "main",
              "complete": True, "errors": [], "files": list(files), "comments": list(comments),
              "check_runs": checks}
    evidence = evidence_for(checks, head, ci_base)
    if evidence:
        result["ci_evidence"] = evidence
    return result


def snapshot(*pulls, tip=BASE, issues=None):
    return {"schema_version": 1, "repository": CONFIG["repository"], "complete": True, "errors": [],
            "base_tips": {"main": tip}, "pulls": list(pulls), "issues": {"7": "open"} if issues is None else issues}
