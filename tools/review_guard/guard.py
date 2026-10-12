"""Portable review preparation. Python 3.11+, standard library, no network or execution."""
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tomllib


class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def require_runtime(version=None):
    require((version or sys.version_info) >= (3, 11), "Python 3.11 or newer is required")


def write_json(path, value):
    """Create a UTF-8 file, never silently replace an existing plan."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def shown(value):
    """Quote untrusted values for error messages: no raw newlines in public CI logs."""
    return json.dumps(value, ensure_ascii=True)


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"duplicate JSON key: {shown(key)}")
            result[key] = value
        return result
    path = Path(path)
    require(not path.is_symlink(), "JSON symlinks are not accepted")
    require(path.stat().st_size <= 1_048_576, "JSON exceeds 1 MiB limit")
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique)


def listed(values):
    return ", ".join(shown(v) for v in values)


def text(value):
    return isinstance(value, str) and bool(value.strip()) and value.strip().upper() not in {"TODO", "TBD"}


def version(value, allowed):
    """JSON true and 1.0 compare equal to 1 in Python; accept only real integers."""
    return type(value) is int and value in allowed


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
        require(item["id"] not in result, f"{label}: duplicate id {shown(item['id'])}")
        result[item["id"]] = item
    return result


# Design 8: a cause ID is "C-" and a positive decimal, 0-padded to 4 digits and natural from 10000 (one spelling
# per number). ASCII digits only: a str pattern's \d would also match other scripts' digits.
CAUSE_ID = re.compile(r"C-(?:0[0-9]{3}|[1-9][0-9]{3,})")
# The ID before the split (PR<N>-R<NNN>): only in a single-layer ledger, so the ledger before the split can still be
# checked for the stage-4 comparison (design 10). The two-layer ledger and the catalogue use C IDs only.
LEGACY_FINDING_ID = re.compile(r"PR[1-9][0-9]*-R[0-9]{3,}")
HEX64 = re.compile(r"[0-9a-f]{64}")


def cause_id(value):
    return isinstance(value, str) and CAUSE_ID.fullmatch(value) is not None and value != "C-0000"


def legacy_finding_id(value):
    return (isinstance(value, str) and LEGACY_FINDING_ID.fullmatch(value) is not None
            and int(value.split("-R")[1]) > 0)


def cause_hash(invariant_id, cause_key):
    """The public form of a cause (design 8): sha256 of the invariant ID, a newline and the cause_key."""
    return hashlib.sha256((invariant_id + "\n" + cause_key).encode("utf-8")).hexdigest()


def finding_key(finding):
    """(invariant, cause hash) of a finding of either layer."""
    if "cause_key_hash" in finding:
        return finding["invariant_id"], finding["cause_key_hash"]
    return finding["invariant_id"], cause_hash(finding["invariant_id"], finding["cause_key"])


def export_global_ids(catalog, ledger):
    """The public ID catalogue (.review/mekiki/global-ids.json) of the global ledger: only what the plan check reads.
    A global invariant may have no paths (design 8): repositories add them in [causes.paths]."""
    rules, findings = validate(catalog, ledger, empty_paths=True)
    ids = {"schema_version": 1,
            "invariants": [{"id": rid, "paths": list(rule["paths"]), "related": list(rule["related"]),
                            "scenarios": [{"id": sid} for sid in index(rule["scenarios"], "scenarios")]}
                           for rid, rule in rules.items()],
            "findings": [{"id": fid, "invariant_id": f["invariant_id"],
                          "cause_key_hash": cause_hash(f["invariant_id"], f["cause_key"])}
                         for fid, f in findings.items()]}
    validate_global_ids(ids)
    return ids


def validate_global_ids(ids):
    """Check the public catalogue alone: exact fields, known references, no prose (design 8)."""
    require(isinstance(ids, dict) and set(ids) == {"schema_version", "invariants", "findings"}
            and version(ids.get("schema_version"), {1}), "global ID catalogue: unsupported shape")
    rules = index(ids.get("invariants"), "global invariants")
    for rid, rule in rules.items():
        label = "global " + shown(rid)
        require(set(rule) == {"id", "paths", "related", "scenarios"}, f"{label}: unexpected fields")
        require(isinstance(rule["paths"], list) and all(path_ok(p) for p in rule["paths"]), f"{label}: invalid paths")
        require(isinstance(rule["related"], list) and all(isinstance(r, str) for r in rule["related"])
                and set(rule["related"]) <= rules.keys(), f"{label}: unknown related invariant")
        scenarios = index(rule["scenarios"], label + " scenarios")
        require(bool(scenarios) and all(set(sc) == {"id"} for sc in scenarios.values()),
                f"{label}: scenarios must be IDs only")
    findings = index(ids.get("findings"), "global findings")
    keys = set()
    for fid, finding in findings.items():
        label = "global " + shown(fid)
        require(set(finding) == {"id", "invariant_id", "cause_key_hash"}, f"{label}: unexpected fields")
        require(cause_id(fid), f"{label}: invalid finding id (C-NNNN)")
        require(isinstance(finding["invariant_id"], str) and finding["invariant_id"] in rules, f"{label}: unknown invariant")
        require(isinstance(finding["cause_key_hash"], str) and HEX64.fullmatch(finding["cause_key_hash"]) is not None,
                f"{label}: invalid cause_key_hash")
        key = finding_key(finding)
        require(key not in keys, f"duplicate global cause: {shown(fid)}")
        keys.add(key)
    return rules, findings


def validate(catalog, ledger, global_ids=None, empty_paths=False):
    """The project ledger, or the union of the project ledger and the global ID catalogue (design 8). A project
    entry may refer to global IDs; a global entry never to a project one. No ID or cause is in both layers.
    `empty_paths`: the ledger is the global one, whose invariants may have no paths."""
    global_rules, global_findings = validate_global_ids(global_ids) if global_ids is not None else ({}, {})
    require(version(catalog.get("schema_version"), {1}) and version(ledger.get("schema_version"), {1}),
            "unsupported schema version")
    rules = index(catalog.get("invariants"), "invariants")
    overlap = sorted(rules.keys() & global_rules.keys())
    require(not overlap, "invariant in both the project and the global ledger: " + listed(overlap))
    # ci.py also validates the candidate (PR-controlled) catalog and ledger: quote every id.
    for rid, rule in rules.items():
        label = shown(rid)
        require(text(rule.get("condition")), f"{label}: missing condition")
        require(isinstance(rule.get("paths"), list) and (rule["paths"] or empty_paths)
                and all(path_ok(p) for p in rule["paths"]), f"{label}: invalid paths")
        require(isinstance(rule.get("related"), list)
                and all(isinstance(r, str) for r in rule["related"])
                and set(rule["related"]) <= rules.keys() | global_rules.keys(), f"{label}: unknown related invariant")
        scenarios = index(rule.get("scenarios"), label + " scenarios")
        require(bool(scenarios) and all(text(s.get("question")) for s in scenarios.values()),
                f"{label}: missing scenario question")
    findings = index(ledger.get("findings"), "findings")
    keys = set()
    for fid, finding in findings.items():
        label = shown(fid)
        require(cause_id(fid) or (global_ids is None and legacy_finding_id(fid)),
                f"{label}: invalid shared finding id (C-NNNN)")
        require(fid not in global_findings, f"{label}: finding in both the project and the global ledger")
        # Only the catalogue states hashes; a project finding names its cause, so it cannot pose as another one.
        require("cause_key_hash" not in finding, f"{label}: a project finding has cause_key, not cause_key_hash")
        require(isinstance(finding.get("invariant_id"), str)
                and finding["invariant_id"] in rules.keys() | global_rules.keys(), f"{label}: unknown invariant")
        require(text(finding.get("cause_key")) and text(finding.get("lesson")), f"{label}: missing cause/lesson")
        require(finding["cause_key"] == finding["cause_key"].strip(), f"{label}: cause_key must be trimmed")
        key = (finding["invariant_id"], finding["cause_key"])
        require(key not in keys, f"duplicate cause: {shown(list(key))}")
        keys.add(key)
        require(finding_key(finding) not in {finding_key(g) for g in global_findings.values()},
                f"{label}: cause in both the project and the global ledger")
        require(isinstance(finding.get("sources"), list) and finding["sources"]
                and all(isinstance(s, str) and s.startswith("https://") for s in finding["sources"]),
                f"{label}: missing evidence links")
    if global_ids is None:
        return rules, findings
    union_rules = dict(global_rules)
    union_rules.update(rules)
    union_findings = dict(global_findings)
    union_findings.update(findings)
    return union_rules, union_findings


def paths_list(paths):
    require(isinstance(paths, list) and all(path_ok(p) for p in paths), "invalid changed paths")
    return sorted(set(paths))


def policy_changes(before, after):
    """Report structural changes, without guessing if prose or glob changes are safe."""
    old = index(before.get("invariants"), "base invariants")
    new = index(after.get("invariants"), "candidate invariants")
    changes = []
    for rid in sorted(old.keys() | new.keys()):
        if rid not in old or rid not in new:
            changes.append({"id": rid, "field": "invariant",
                            "before": old.get(rid), "after": new.get(rid)})
            continue
        for field in ("condition", "paths", "related", "scenarios"):
            if old[rid].get(field) != new[rid].get(field):
                changes.append({"id": rid, "field": field,
                                "before": old[rid].get(field), "after": new[rid].get(field)})
    return changes


def read_config(path):
    """The repository settings (.review/config.toml, design 9); {} when the file is absent. Only [causes.paths] is
    read here; the dispatcher checks the other tables."""
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return {}
    require(not path.is_symlink(), "config symlinks are not accepted")
    require(path.stat().st_size <= 1_048_576, "config exceeds 1 MiB limit")
    return tomllib.loads(path.read_text(encoding="utf-8"))


def path_extensions(config, global_ids):
    """[causes.paths] (design 8): global invariant ID -> globs the repository adds. Only global IDs of the catalogue;
    an empty array is allowed and changes nothing."""
    causes = config.get("causes", {})
    require(isinstance(causes, dict), "[causes] must be a table")
    paths = causes.get("paths", {})
    require(isinstance(paths, dict), "[causes.paths] must be a table")
    known = global_rule_ids(global_ids) if global_ids is not None else set()
    for rid, globs in paths.items():
        require(rid in known, "[causes.paths]: not a global invariant of the catalogue: " + shown(rid))
        require(isinstance(globs, list) and all(path_ok(g) for g in globs),
                "[causes.paths]: " + shown(rid) + " must be an array of repository-relative globs")
    return {rid: list(globs) for rid, globs in paths.items()}


def with_extensions(rules, extensions):
    """The selecting paths: the catalogue's paths and the repository's additions. Additions never remove a path."""
    if not extensions:
        return rules
    result = dict(rules)
    for rid, globs in extensions.items():
        result[rid] = dict(rules[rid], paths=rules[rid]["paths"] + [g for g in globs if g not in rules[rid]["paths"]])
    return result


def empty_global_paths(rules, global_ids):
    """Global invariants that select no path even with the additions: the summary lists them like disable_global."""
    return sorted(rid for rid in global_rule_ids(global_ids) if not rules[rid]["paths"])


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


# Plan schema 2 adds the boundary inventory and the variant analysis (docs/review-prevention.md).
# Schema 1 stays readable so that plans written before schema 2 do not all fail at once.
PLAN_SCHEMA = 2
PLAN_SCHEMAS = {1, 2}
DIRECTIONS = ("entry", "exit")
TRUST_LEVELS = ("untrusted", "partially-trusted", "trusted")


def prepare(catalog, ledger, paths, base):
    """The plan of a single-layer (project only) ledger."""
    return prepare_split(catalog, ledger, paths, base)[0]


def prepare_split(catalog, ledger, paths, base, global_ids=None, global_text=None, extensions=None):
    """The plan to commit, and with the global ledger the private reference (design 8): the plan names global
    causes by ID only; their condition, questions, lessons and sources go to the reference, never the repository."""
    require((global_ids is None) == (global_text is None),
            "prepare with the global ID catalogue needs the private global ledger (--global-catalog/--global-ledger)")
    if global_text is not None:
        require(export_global_ids(*global_text) == global_ids,
                "the global ID catalogue is not the one made from this global ledger")
    rules, findings = validate(catalog, ledger, global_ids)
    rules = with_extensions(rules, extensions)
    require(sha(base), "base_sha must be a full SHA")
    paths = paths_list(paths)
    ids = affected(rules, paths)
    public = {"schema_version": PLAN_SCHEMA, "base_sha": base, "task_id": "TODO",
            "planned_paths": paths, "conflicts": [],
            "assessments": [
                {"id": rid, "disposition": "preserve", "reason": "TODO",
                 "checks": [{"id": s["id"], "method": "TODO", "expected": "TODO"}
                            for s in rules[rid]["scenarios"]]} for rid in ids],
            "boundaries": [{"id": "B1", "direction": "TODO", "location": "TODO", "data": "TODO",
                            "trust": "TODO", "control": "TODO"}] if ids else [],
            "variant_analysis": [{"invariant_id": rid, "pattern": "TODO", "places": []} for rid in ids],
            "context": {rid: {"condition": rules[rid]["condition"],
                              "scenarios": rules[rid]["scenarios"],
                              "history": [f for f in findings.values() if f["invariant_id"] == rid]}
                        for rid in ids if global_ids is None or rid not in global_rule_ids(global_ids)}}
    if global_text is None:
        return public, None
    global_rules = index(global_text[0]["invariants"], "invariants")
    private = {"schema_version": 1, "base_sha": base,
               "context": {rid: {"condition": global_rules[rid]["condition"],
                                 "scenarios": global_rules[rid]["scenarios"],
                                 # The project's own findings on a global invariant too (its text is the
                                 # project's, but the public plan never has a global ID in `context`).
                                 "history": [f for f in global_text[1]["findings"] + list(ledger["findings"])
                                             if f["invariant_id"] == rid]}
                           for rid in ids if rid in global_rules}}
    return public, private


def repository_roots(paths):
    """The directories that hold a repository around these paths: each ancestor with .git or .review, and the
    working directory itself."""
    roots = {Path.cwd().resolve()}
    for path in paths:
        for parent in [Path(path).resolve(), *Path(path).resolve().parents]:
            if (parent / ".git").exists() or (parent / ".review").is_dir():
                roots.add(parent)
    return roots


def inside_any(target, roots):
    """Whether target is in one of roots, compared as files (a case-insensitive file system included)."""
    for parent in [target, *target.parents]:
        if parent.exists() and any(os.path.samefile(parent, r) for r in roots):
            return True
    return False


def global_rule_ids(global_ids):
    return {rule["id"] for rule in global_ids["invariants"]}


def check_plan_name(plan, path):
    task = plan.get("task_id")
    require(text(task), "missing plan task_id")
    name = Path(path).name
    stem = name[:-5] if name.endswith(".json") else ""
    require(stem == task or (stem.startswith(task + "-") and len(stem) > len(task) + 1),
            "plan filename must match task_id or task_id-part.json")


def check_boundaries(plan, ids):
    """(a) Every entry/exit point the change touches, with its trust level and control."""
    rows = plan.get("boundaries")
    require(isinstance(rows, list), "boundaries must be a list of entry/exit points")
    require(rows or not ids,
            "boundaries: empty inventory, but this change selects invariants " + listed(ids)
            + "; list every entry/exit point it touches with trust and control")
    for row in index(rows, "boundaries").values():
        label = "boundaries[" + shown(row["id"]) + "]"
        require(row["id"] == row["id"].strip(), label + ": id must be trimmed")
        require(row.get("direction") in DIRECTIONS, label + ": direction must be one of " + ", ".join(DIRECTIONS))
        require(row.get("trust") in TRUST_LEVELS, label + ": trust must be one of " + ", ".join(TRUST_LEVELS))
        for field in ("location", "data", "control"):
            require(text(row.get(field)), f"{label}: missing {field}")


def check_variants(plan, rules, findings, ids):
    """(b) For each relevant invariant or cause_key: the places checked and the result."""
    rows = plan.get("variant_analysis")
    require(isinstance(rows, list), "variant_analysis must be a list")
    causes = {finding_key(f): fid for fid, f in findings.items()}
    seen = set()
    for row in rows:
        require(isinstance(row, dict), "variant_analysis: each entry must be an object")
        rid, cause = row.get("invariant_id"), row.get("cause_key")
        require(isinstance(rid, str) and rid in rules, "variant_analysis: unknown invariant_id " + shown(rid))
        label = "variant_analysis[" + shown(rid) + ("/" + shown(cause) if "cause_key" in row else "") + "]"
        key = (rid, None)
        if "cause_key" in row:
            require(text(cause) and cause == cause.strip(), label + ": cause_key must be trimmed non-empty text")
            key = (rid, cause_hash(rid, cause))
            require(key in causes, label + ": cause_key is not in the ledger for " + shown(rid))
        require(key not in seen, label + ": duplicate entry")
        seen.add(key)
        require(text(row.get("pattern")), label + ": missing pattern (the issue class searched for)")
        places = row.get("places")
        require(isinstance(places, list) and places,
                label + ": no places checked; list each place with its result")
        for place in places:
            require(isinstance(place, dict) and text(place.get("location")) and text(place.get("result")),
                    label + ": each place needs location and result")
    missing = sorted(set(ids) - {rid for rid, _ in seen})
    require(not missing, "variant_analysis: missing selected invariants " + listed(missing)
            + "; list the places checked for each")
    return sorted(fid for key, fid in causes.items() if key[0] in ids and key not in seen)


def plans_prefix(review_dir):
    """The preflight plans of a review directory (design 10: --review-dir, default .review)."""
    return review_dir.rstrip("/") + "/plans/"


def review_directory(value):
    """A repository-relative directory of plain segments, never absolute or with "..": review data stays in the checkout."""
    require(isinstance(value, str) and value and not value.startswith("/")
            and all(part and part not in (".", "..") for part in value.rstrip("/").split("/")),
            "--review-dir must be a relative directory of plain segments")
    return value.rstrip("/")


def check(catalog, ledger, plan, paths, base, review_dir=".review", global_ids=None, extensions=None):
    """`extensions`: [causes.paths] of the base's settings (design 8, A7)."""
    rules, findings = validate(catalog, ledger, global_ids)
    rules = with_extensions(rules, extensions)
    if global_ids is not None:
        # Design 8: a public plan names global causes by ID only; their text stays out of `context`.
        context = plan.get("context", {})
        require(isinstance(context, dict), "context must be an object")
        shared = sorted(set(context) & global_rule_ids(global_ids))
        require(not shared, "context holds global invariants (IDs only in a public plan): " + listed(shared))
    prefix = plans_prefix(review_dir)
    require(sha(base) and plan.get("base_sha") == base, "stale or invalid base_sha: regenerate/recheck plan")
    require(version(plan.get("schema_version"), PLAN_SCHEMAS) and text(plan.get("task_id")),
            "missing or unsupported plan schema_version (1 or 2) or task_id")
    planned = paths_list(plan.get("planned_paths"))
    actual = paths_list(paths)
    plans = [p for p in actual if p.startswith(prefix) and p.endswith(".json")]
    require(len(plans) <= 1, "multiple changed preflight plans are not accepted in one PR")
    if plans:
        check_plan_name(plan, plans[0])
    # The single plan is review metadata, not an implementation path to be self-listed.
    actual = [p for p in actual if p not in plans]
    require(set(actual) <= set(planned), "unplanned paths: " + listed(sorted(set(actual) - set(planned))))
    ids = affected(rules, sorted(set(planned) | set(actual)))
    assessments = index(plan.get("assessments"), "assessments")
    require(set(assessments) <= rules.keys(), "unknown assessment id")
    require(set(ids) <= assessments.keys(), "missing invariant assessments: " + listed(sorted(set(ids) - assessments.keys())))
    conflicts = plan.get("conflicts")
    require(isinstance(conflicts, list), "conflicts must be a list")
    for conflict in conflicts:
        require(isinstance(conflict, dict) and text(conflict.get("description"))
                and conflict.get("state") == "resolved" and text(conflict.get("resolution")),
                "unresolved design conflict: revise the plan before implementation")
    decisions = []
    for rid in sorted(assessments):
        item, label = assessments[rid], shown(rid)
        require(item.get("disposition") in {"preserve", "not-applicable", "change-proposed"},
                f"{label}: invalid disposition")
        if item["disposition"] == "change-proposed":
            refs = item.get("decision_references")
            require(isinstance(refs, list) and refs and all(text(ref) for ref in refs),
                    f"{label}: change-proposed requires decision_references")
            decisions.append({"id": rid, "decision_references": refs})
        require(text(item.get("reason")), f"{label}: missing rationale")
        checks = index(item.get("checks"), label + " checks")
        expected_ids = {s["id"] for s in rules[rid]["scenarios"]}
        require(set(checks) == expected_ids, f"{label}: scenario coverage mismatch")
        for sid, c in checks.items():
            require(text(c.get("method")) and text(c.get("expected")), f"{label}/{shown(sid)}: missing method/expected result")
    tables = plan["schema_version"] >= 2 or "boundaries" in plan or "variant_analysis" in plan
    if tables:
        require("boundaries" in plan and "variant_analysis" in plan,
                f"plan schema {plan['schema_version']} requires both boundaries and variant_analysis"
                " (see docs/review-prevention.md)")
        check_boundaries(plan, ids)
        unanalyzed = check_variants(plan, rules, findings, ids)
    result = {"result": "metadata-complete", "invariants": ids,
              "decisions_to_review": decisions,
              "plan_tables": "checked" if tables else "legacy-v1",
              "notice": "This checks coverage only. It does not verify claims, resolve design conflicts, or approve implementation/merge."}
    if tables:
        # Ledger causes of the selected invariants without their own entry: input for the red team.
        result["causes_not_analyzed"] = unanalyzed
    else:
        result["legacy_notice"] = ("Schema 1 plan without boundaries/variant_analysis: accepted only for plans"
                                   " written before schema 2. New plans must use schema 2.")
    if global_ids is not None:
        # Design 8: a global invariant that selects nothing goes to the summary, so removing paths never stops it
        # silently.
        result["empty_global_paths"] = empty_global_paths(rules, global_ids)
    return result


def triage(catalog, ledger, candidates, global_ids=None):
    """With the catalogue, candidates are matched against both layers (a global cause by its hash)."""
    rules, findings = validate(catalog, ledger, global_ids)
    require(isinstance(candidates, list), "candidates must be a list")
    by_cause = {finding_key(f): f["id"] for f in findings.values()}
    output = []
    seen = set()
    for c in candidates:
        require(isinstance(c, dict) and c.get("invariant_id") in rules
                and text(c.get("cause_key")) and text(c.get("evidence")), "invalid candidate")
        require(c["cause_key"] == c["cause_key"].strip(), "candidate cause_key must be trimmed")
        key = (c["invariant_id"], cause_hash(c["invariant_id"], c["cause_key"]))
        require(key not in seen, "duplicate candidate cause")
        seen.add(key)
        output.append({"existing_id": by_cause.get(key),
                       "action": "update-existing" if key in by_cause else "propose-new",
                       "candidate": c})
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate", "prepare", "check", "triage", "export-global-ids"])
    parser.add_argument("--review-dir", default=".review",
                        help="the review directory (catalog, ledger and plans); default .review")
    parser.add_argument("--catalog", help="default <review-dir>/invariants.json")
    parser.add_argument("--ledger", help="default <review-dir>/findings.json")
    parser.add_argument("--paths-file", help="JSON array of repository-relative paths; include both sides of renames")
    parser.add_argument("--base-sha")
    parser.add_argument("--plan")
    parser.add_argument("--candidates")
    parser.add_argument("--output", help="Create a UTF-8 JSON file; refuses to overwrite existing files")
    parser.add_argument("--global-ids", help="the public global ID catalogue (.review/mekiki/global-ids.json); "
                        "the ledger is then its union with the project ledger")
    parser.add_argument("--config", help="the repository settings for [causes.paths] (design 8); "
                        "default <review-dir>/config.toml, none when absent")
    parser.add_argument("--global-catalog", help="prepare on the host: the private global invariants")
    parser.add_argument("--global-ledger", help="prepare on the host: the private global findings")
    parser.add_argument("--private-output", help="prepare on the host: a new file outside the repository for the "
                        "global text of the selected invariants")
    args = parser.parse_args(argv)
    try:
        require_runtime()
        review_dir = review_directory(args.review_dir)
        catalog = read_json(args.catalog or review_dir + "/invariants.json")
        ledger = read_json(args.ledger or review_dir + "/findings.json")
        global_ids = read_json(args.global_ids) if args.global_ids else None
        private = None
        extensions = None
        if args.command != "export-global-ids":
            if global_ids is not None:
                validate_global_ids(global_ids)
            extensions = path_extensions(read_config(args.config or review_dir + "/config.toml"), global_ids)
        if args.command == "export-global-ids":
            # --catalog/--ledger are the private global ledger here; only IDs and hashes are printed.
            result = export_global_ids(catalog, ledger)
        elif args.command == "validate":
            rules, findings = validate(catalog, ledger, global_ids)
            result = {"invariants": len(rules), "findings": len(findings)}
        elif args.command == "triage":
            require(args.candidates, "--candidates is required")
            result = triage(catalog, ledger, read_json(args.candidates), global_ids)
        else:
            require(args.paths_file and args.base_sha, "--paths-file and --base-sha are required")
            paths = read_json(args.paths_file)
            if args.command == "prepare":
                global_text = None
                if args.global_catalog or args.global_ledger:
                    require(args.global_catalog and args.global_ledger, "--global-catalog and --global-ledger go together")
                    require(args.private_output, "--private-output is required with the global ledger")
                    # The reference holds private text: never inside the repository being prepared, wherever
                    # the command runs from (PR #12 RT-3).
                    target = Path(args.private_output).resolve()
                    roots = repository_roots([Path.cwd(), *(Path(x) for x in (
                        args.catalog or review_dir + "/invariants.json", args.ledger or review_dir + "/findings.json",
                        args.global_ids, args.output, args.paths_file) if x)])
                    require(not inside_any(target, roots), "--private-output must be outside the repository")
                    global_text = (read_json(args.global_catalog), read_json(args.global_ledger))
                result, private = prepare_split(catalog, ledger, paths, args.base_sha, global_ids, global_text,
                                                extensions)
            else:
                require(args.plan, "--plan is required")
                plan = read_json(args.plan)
                check_plan_name(plan, args.plan)
                result = check(catalog, ledger, plan, paths, args.base_sha, review_dir, global_ids, extensions)
                changed_plans = [p for p in paths_list(paths)
                                 if p.startswith(plans_prefix(review_dir)) and p.endswith(".json")]
                if changed_plans:
                    require(Path(args.plan).resolve() == Path(changed_plans[0]).resolve(),
                            "--plan must refer to the changed preflight plan path")
        if private is not None:
            write_json(args.private_output, private)
        if args.output:
            write_json(args.output, result)
        # ASCII JSON survives redirected legacy Windows console encodings.
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (Invalid, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"review-guard: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
