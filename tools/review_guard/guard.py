"""Portable review preparation. Python 3.11+, standard library, no network or execution."""
import argparse
import fnmatch
import json
from pathlib import Path
import re
import sys


class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result
    path = Path(path)
    require(not path.is_symlink(), "JSON symlinks are not accepted")
    require(path.stat().st_size <= 1_048_576, "JSON exceeds 1 MiB limit")
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)


def text(value):
    return isinstance(value, str) and bool(value.strip()) and value.strip().upper() not in {"TODO", "TBD"}


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def path_ok(value):
    return (isinstance(value, str) and bool(value) and not value.startswith("/")
            and "\\" not in value and ":" not in value
            and not any(c in value for c in "\n\r\x00")
            and all(p not in {"", ".", ".."} for p in value.split("/")))


def index(items, label):
    require(isinstance(items, list), f"{label} must be a list")
    result = {}
    for item in items:
        require(isinstance(item, dict) and text(item.get("id")), f"{label}: missing id")
        require(item["id"] not in result, f"{label}: duplicate id {item['id']}")
        result[item["id"]] = item
    return result


def validate(catalog, ledger):
    require(catalog.get("schema_version") == 1 and ledger.get("schema_version") == 1,
            "unsupported schema version")
    rules = index(catalog.get("invariants"), "invariants")
    for rid, rule in rules.items():
        require(text(rule.get("condition")), f"{rid}: missing condition")
        require(isinstance(rule.get("paths"), list) and rule["paths"]
                and all(path_ok(p) for p in rule["paths"]), f"{rid}: invalid paths")
        require(isinstance(rule.get("related"), list)
                and set(rule["related"]) <= rules.keys(), f"{rid}: unknown related invariant")
        scenarios = index(rule.get("scenarios"), rid + " scenarios")
        require(bool(scenarios) and all(text(s.get("question")) for s in scenarios.values()),
                f"{rid}: missing scenario question")
    findings = index(ledger.get("findings"), "findings")
    keys = set()
    for fid, finding in findings.items():
        require(finding.get("invariant_id") in rules, f"{fid}: unknown invariant")
        require(text(finding.get("cause_key")) and text(finding.get("lesson")), f"{fid}: missing cause/lesson")
        key = (finding["invariant_id"], finding["cause_key"])
        require(key not in keys, f"duplicate cause: {key}")
        keys.add(key)
        require(isinstance(finding.get("sources"), list) and finding["sources"]
                and all(isinstance(s, str) and s.startswith("https://") for s in finding["sources"]),
                f"{fid}: missing evidence links")
    return rules, findings


def paths_list(paths):
    require(isinstance(paths, list) and all(path_ok(p) for p in paths), "invalid changed paths")
    return sorted(set(paths))


def affected(rules, paths):
    selected = {rid for rid, rule in rules.items()
                if any(fnmatch.fnmatchcase(p, pattern) for p in paths for pattern in rule["paths"])}
    pending = list(selected)
    while pending:
        for related in rules[pending.pop()]["related"]:
            if related not in selected:
                selected.add(related)
                pending.append(related)
    return sorted(selected)


def prepare(catalog, ledger, paths, base):
    rules, findings = validate(catalog, ledger)
    require(sha(base), "base_sha must be a full SHA")
    paths = paths_list(paths)
    ids = affected(rules, paths)
    return {"schema_version": 1, "base_sha": base, "task_id": "TODO",
            "planned_paths": paths, "conflicts": [],
            "assessments": [
                {"id": rid, "disposition": "preserve", "reason": "TODO",
                 "checks": [{"id": s["id"], "method": "TODO", "expected": "TODO"}
                            for s in rules[rid]["scenarios"]]} for rid in ids],
            "context": {rid: {"condition": rules[rid]["condition"],
                              "scenarios": rules[rid]["scenarios"],
                              "history": [f for f in findings.values() if f["invariant_id"] == rid]}
                        for rid in ids}}


def check(catalog, ledger, plan, paths, base):
    rules, _ = validate(catalog, ledger)
    require(sha(base) and plan.get("base_sha") == base, "stale or invalid base_sha: regenerate/recheck plan")
    require(plan.get("schema_version") == 1 and text(plan.get("task_id")), "missing plan version/task_id")
    planned = paths_list(plan.get("planned_paths"))
    actual = paths_list(paths)
    # The plan itself is review metadata, not an implementation path to be self-listed.
    actual = [p for p in actual if not (p.startswith(".review/plans/") and p.endswith(".json"))]
    require(set(actual) <= set(planned), "unplanned paths: " + ", ".join(sorted(set(actual) - set(planned))))
    ids = affected(rules, sorted(set(planned) | set(actual)))
    assessments = index(plan.get("assessments"), "assessments")
    require(set(assessments) <= rules.keys(), "unknown assessment id")
    require(set(ids) <= assessments.keys(), "missing invariant assessments: " + ", ".join(set(ids) - assessments.keys()))
    conflicts = plan.get("conflicts")
    require(isinstance(conflicts, list), "conflicts must be a list")
    for conflict in conflicts:
        require(isinstance(conflict, dict) and text(conflict.get("description"))
                and conflict.get("state") == "resolved" and text(conflict.get("resolution")),
                "unresolved design conflict: revise the plan before implementation")
    for rid in ids:
        item = assessments[rid]
        require(item.get("disposition") in {"preserve", "not-applicable"},
                f"{rid}: change-proposed requires a separate design decision, not a green preflight")
        require(text(item.get("reason")), f"{rid}: missing rationale")
        checks = index(item.get("checks"), rid + " checks")
        expected_ids = {s["id"] for s in rules[rid]["scenarios"]}
        require(set(checks) == expected_ids, f"{rid}: scenario coverage mismatch")
        for sid, c in checks.items():
            require(text(c.get("method")) and text(c.get("expected")), f"{rid}/{sid}: missing method/expected result")
    return {"result": "metadata-complete", "invariants": ids,
            "notice": "This checks coverage only. It does not verify claims, resolve design conflicts, or approve implementation/merge."}


def triage(catalog, ledger, candidates):
    rules, findings = validate(catalog, ledger)
    require(isinstance(candidates, list), "candidates must be a list")
    by_cause = {(f["invariant_id"], f["cause_key"]): f["id"] for f in findings.values()}
    output = []
    for c in candidates:
        require(isinstance(c, dict) and c.get("invariant_id") in rules
                and text(c.get("cause_key")) and text(c.get("evidence")), "invalid candidate")
        key = (c["invariant_id"], c["cause_key"])
        output.append({"existing_id": by_cause.get(key),
                       "action": "update-existing" if key in by_cause else "propose-new",
                       "candidate": c})
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate", "prepare", "check", "triage"])
    parser.add_argument("--catalog", default=".review/invariants.json")
    parser.add_argument("--ledger", default=".review/findings.json")
    parser.add_argument("--paths-file", help="JSON array of repository-relative paths; include both sides of renames")
    parser.add_argument("--base-sha")
    parser.add_argument("--plan")
    parser.add_argument("--candidates")
    args = parser.parse_args(argv)
    try:
        catalog, ledger = read_json(args.catalog), read_json(args.ledger)
        if args.command == "validate":
            rules, findings = validate(catalog, ledger)
            result = {"invariants": len(rules), "findings": len(findings)}
        elif args.command == "triage":
            require(args.candidates, "--candidates is required")
            result = triage(catalog, ledger, read_json(args.candidates))
        else:
            require(args.paths_file and args.base_sha, "--paths-file and --base-sha are required")
            paths = read_json(args.paths_file)
            if args.command == "prepare":
                result = prepare(catalog, ledger, paths, args.base_sha)
            else:
                require(args.plan, "--plan is required")
                result = check(catalog, ledger, read_json(args.plan), paths, args.base_sha)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (Invalid, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"review-guard: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
