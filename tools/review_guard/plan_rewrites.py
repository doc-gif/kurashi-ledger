"""Listed plan rewrites after the stage-4 ledger split (Issue #46). Standard library only, no guard import.

The base's list (<review-dir>/mekiki/plan-rewrites.json) names existing plans that `ledger rewrite-plans` may
rewrite in one PR, and pins the split-map by its SHA-256. A listed plan is exempt from "one changed plan" and
"base_sha is the PR's base", and may differ from its base copy only by:

1. removing common (global) invariants from `context`, and replacing a kept entry's `history` with the base
   project ledger's rows (owner, Issue #46 I46-R002 A): in the original order, each item becomes the base
   ledger row of its split-map `project` ID (the project side of `both`); an item that went only to the
   global ledger is dropped;
2. putting the moved causes' keys of `variant_analysis` per the split-map, with one invariant-only row for a
   selected original invariant that no row names any more (Issue #44 B);
3. rewording the conflict text (`description`, `resolution`) the list names by JSON Pointer.

Only the base list and the split-map bytes it pins grant this. The candidate's list grants nothing; its shape is
checked so a broken list never becomes the next base. Every changed plan still goes to `check_plan` (the caller
runs guard's check with the base materials), and to `check_publication` when a host caller passes one: CI omits
it, and omitting it never claims the publication check ran. ci.py imports this file flat from the base copy, the
tests as tools.review_guard.plan_rewrites: it imports nothing of its own package.
"""
from copy import deepcopy
import hashlib
import json
import re


LIST_SCHEMA = 1
MAP_SCHEMA = 1
HEX64 = re.compile(r"[0-9a-f]{64}")
# Owner decision (PR #43 question 10): only the text of a conflict may be reworded, never its state.
FREE_TEXT = ("description", "resolution")
# What a caller's check may raise (guard.Invalid is a ValueError).
CHECK_ERRORS = (ValueError, TypeError, KeyError, AttributeError)


def shown(value):
    """Quote untrusted values for messages: no raw newlines in public CI logs."""
    return json.dumps(value, ensure_ascii=True)


def canonical(value):
    """Equality of JSON values that keeps true and 1 apart (Python's == does not)."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def list_path(review_dir):
    return review_dir.rstrip("/") + "/mekiki/plan-rewrites.json"


def map_path(review_dir):
    return review_dir.rstrip("/") + "/mekiki/split-map.json"


def pointer_tokens(pointer):
    """RFC 6901: "/conflicts/5" -> ("conflicts", "5")."""
    return tuple(t.replace("~1", "/").replace("~0", "~") for t in pointer.split("/")[1:])


def allowlist_problem(value):
    """The list's shape, or None when it is valid."""
    if not isinstance(value, dict) or set(value) != {"schema_version", "split_map_sha256", "plans"}:
        return "the list needs exactly schema_version, split_map_sha256 and plans"
    if type(value["schema_version"]) is not int or value["schema_version"] != LIST_SCHEMA:
        return "unsupported list schema_version"
    if not isinstance(value["split_map_sha256"], str) or HEX64.fullmatch(value["split_map_sha256"]) is None:
        return "split_map_sha256 must be 64 lowercase hex digits"
    if not isinstance(value["plans"], list):
        return "plans must be a list"
    seen = set()
    for entry in value["plans"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "editable_text"}:
            return "each plans entry needs exactly path and editable_text"
        if not isinstance(entry["path"], str) or not entry["path"] or entry["path"] in seen:
            return "each plans path must be a distinct non-empty string"
        seen.add(entry["path"])
        pointers = entry["editable_text"]
        if not isinstance(pointers, list) or not all(isinstance(p, str) and p.startswith("/") for p in pointers):
            return "editable_text must be a list of JSON Pointers"
    return None


def listed_paths(value):
    """The plan paths of a valid list; nothing for an invalid or missing one."""
    return {entry["path"] for entry in value["plans"]} if value is not None and allowlist_problem(value) is None else set()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("split-map: duplicate JSON key " + shown(key))
        result[key] = value
    return result


def read_split_map(data):
    """(moves, common invariants, projects) of split-map.json as `ledger split` writes it. A move is a cause's old
    key -> its new key, for every cause but the two sides of `both` (the project side keeps the original key).
    `projects` is each source ID -> the IDs of its `project` entries ([] when it went only to the global side)."""
    value = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object)
    if not (isinstance(value, dict) and type(value.get("schema_version")) is int and value["schema_version"] == MAP_SCHEMA
            and isinstance(value.get("repo"), str) and isinstance(value.get("new_invariants"), list)
            and all(isinstance(r, str) for r in value["new_invariants"]) and isinstance(value.get("findings"), list)):
        raise ValueError("split-map: unsupported shape")
    moves, projects = {}, {}
    common = set(value["new_invariants"])
    for entry in value["findings"]:
        keys = [entry.get(side) if isinstance(entry, dict) else None for side in ("from", "to")]
        if not (isinstance(entry, dict) and isinstance(entry.get("source_id"), str) and isinstance(entry.get("id"), str)
                and entry.get("scope") in ("global", "project") and type(entry.get("both")) is bool
                and all(isinstance(k, dict) and isinstance(k.get("invariant_id"), str)
                        and isinstance(k.get("cause_key"), str) for k in keys)):
            raise ValueError("split-map: invalid entry")
        old, new = ((k["invariant_id"], k["cause_key"]) for k in keys)
        projects.setdefault(entry["source_id"], [])
        if entry["scope"] == "project":
            projects[entry["source_id"]].append(entry["id"])
        if entry["scope"] == "global":
            common.add(new[0])
        if entry["both"] or old == new:
            continue
        if moves.setdefault(old, new) != new:
            raise ValueError("split-map: one old key moves to two places: " + shown(list(old)))
    return moves, common, projects


def where(tokens):
    return shown("/" + "/".join(t.replace("~", "~0").replace("/", "~1") for t in tokens))


def editable(tokens, pointers):
    """A conflict's description or resolution that the base list names, by itself or by its conflict."""
    return (len(tokens) == 3 and tokens[0] == "conflicts" and tokens[2] in FREE_TEXT
            and any(p == tokens or p == tokens[:2] for p in pointers))


def differences(before, after, tokens, pointers):
    """Every change, except the rewording of an editable string. Structure never changes."""
    if isinstance(before, dict) and isinstance(after, dict):
        if before.keys() != after.keys():
            return [where(tokens) + ": fields were added or removed"]
        return [m for key in before for m in differences(before[key], after[key], tokens + (key,), pointers)]
    if isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            return [where(tokens) + ": items were added or removed"]
        return [m for i, (b, a) in enumerate(zip(before, after)) for m in differences(b, a, tokens + (str(i),), pointers)]
    if canonical(before) == canonical(after):
        return []
    if isinstance(before, str) and isinstance(after, str) and editable(tokens, pointers):
        return []
    return [where(tokens) + ": changed outside the listed rewrite"]


def mapped_history(history, projects, ledger):
    """The base ledger rows that replace `history`, in its order; None when an item has no single mapping."""
    rows = {}
    for row in ledger.get("findings") if isinstance(ledger, dict) and isinstance(ledger.get("findings"), list) else []:
        if isinstance(row, dict) and isinstance(row.get("id"), str):
            rows.setdefault(row["id"], []).append(row)
    result = []
    for item in history:
        source = item.get("id") if isinstance(item, dict) else None
        ids = projects.get(source) if isinstance(source, str) else None
        if ids is None or len(ids) > 1 or (ids and len(rows.get(ids[0], [])) != 1):
            return None
        result += [deepcopy(rows[i][0]) for i in ids]
    return result


def context_differences(before, after, common, pointers, projects, ledger):
    """Rule 1: a common invariant's entry may go; every other entry stays as it is, except that its history may
    become the base ledger rows the split-map maps it to (mapped_history)."""
    if not (isinstance(before, dict) and isinstance(after, dict)):
        return differences(before, after, ("context",), pointers)
    problems = ["context " + shown(rid) + ": added" for rid in after if rid not in before]
    for rid in before:
        old, new = before[rid], after.get(rid)
        if rid in after and isinstance(old, dict) and isinstance(new, dict) and "history" in old and "history" in new:
            rest = lambda entry: {k: v for k, v in entry.items() if k != "history"}
            problems += differences(rest(old), rest(new), ("context", rid), pointers)
            if canonical(old["history"]) != canonical(new["history"]):
                expected = mapped_history(old["history"], projects, ledger) if isinstance(old["history"], list) else None
                if expected is None or canonical(expected) != canonical(new["history"]):
                    problems.append(where(("context", rid, "history")) + ": must stay as it is, or become the base"
                                    " project ledger rows the split-map gives its items, in the same order")
        elif rid in after:
            problems += differences(old, new, ("context", rid), pointers)
        elif rid not in common:
            problems.append("context " + shown(rid) + ": only a common invariant may be removed")
    return problems


def variant_differences(before, after, moves, selected):
    """Rule 2: unchanged, or exactly the base rows with the moved causes' keys, plus one invariant-only row
    (invariant_id, pattern and places of a moved row) for each selected original invariant no row names any more."""
    if not (isinstance(before, list) and isinstance(after, list)):
        return differences(before, after, ("variant_analysis",), ())
    if canonical(before) == canonical(after):
        return []
    rows, fallbacks = [], {}
    for row in before:
        key = (row.get("invariant_id"), row.get("cause_key")) if isinstance(row, dict) else None
        new = moves.get(key) if key and all(isinstance(k, str) for k in key) else None
        if new is None:
            rows.append(row)
            continue
        rows.append(dict(row, invariant_id=new[0], cause_key=new[1]))
        if new[0] != key[0]:
            fallbacks.setdefault(key[0], set()).add(
                canonical({k: row[k] for k in ("invariant_id", "pattern", "places") if k in row}))
    named = {row["invariant_id"] for row in rows if isinstance(row, dict) and isinstance(row.get("invariant_id"), str)}
    required = {rid: options for rid, options in fallbacks.items() if rid in selected and rid not in named}
    expected = [canonical(row) for row in rows]
    position, extra = 0, []
    for row in after:
        if position < len(expected) and canonical(row) == expected[position]:
            position += 1
        else:
            extra.append(row)
    problems = []
    if position < len(expected):
        problems.append("variant_analysis: each row must stay, in order, with only a moved cause's keys changed "
                        "as the split-map says")
    added = set()
    for row in extra:
        rid = row.get("invariant_id") if isinstance(row, dict) else None
        if isinstance(rid, str) and rid in required and rid not in added and canonical(row) in required[rid]:
            added.add(rid)
        else:
            problems.append("variant_analysis: unexpected row for " + shown(rid))
    for rid in sorted(set(required) - added):
        problems.append("variant_analysis: " + shown(rid) + " needs one row with only the invariant_id, pattern"
                        " and places of its moved cause (Issue #44 B)")
    return problems


def rewrite_differences(before, after, pointers, moves, common, selected, projects=None, ledger=None):
    """Why a listed plan's rewrite is not one of the allowed changes; [] when it is."""
    if not (isinstance(before, dict) and isinstance(after, dict)):
        return ["a plan must be a JSON object"]
    problems = []
    for key in sorted(before.keys() | after.keys()):
        if key not in before or key not in after:
            problems.append("field " + shown(key) + ": added or removed")
        elif key == "context":
            problems += context_differences(before[key], after[key], common, pointers, projects or {}, ledger)
        elif key == "variant_analysis":
            problems += variant_differences(before[key], after[key], moves, selected)
        else:
            problems += differences(before[key], after[key], (key,), pointers)
    return problems


def assessment_ids(plan):
    rows = plan.get("assessments") if isinstance(plan, dict) else None
    return {row["id"] for row in rows or [] if isinstance(row, dict) and isinstance(row.get("id"), str)}


def check_rewrite_batch(*, base_plans, candidate_plans, changed_paths, base_sha, base_allowlist, candidate_allowlist,
                        split_map_bytes, base_inputs, candidate_inputs, check_plan, check_publication=None,
                        review_dir=".review", common_invariants=(), selected_invariants=None):
    """Check the changed plans of one PR. `base_plans`/`candidate_plans`: path -> plan of each tree (a missing path
    is a new or deleted plan). `candidate_inputs` is never used for a decision. Optional: `common_invariants` adds the
    base's global invariant IDs to the split-map's; `selected_invariants(plan)` gives the invariants guard selects
    for a base plan (default: its assessments). Returns {"ok", "errors": [{"path", "message"}], "exempted_paths"}."""
    del candidate_inputs  # Only the base decides; the candidate's materials grant nothing.
    errors = []

    def fail(path, message):
        errors.append({"path": path, "message": message})

    prefix = review_dir.rstrip("/") + "/plans/"
    plans = sorted({p for p in changed_paths if isinstance(p, str) and p.startswith(prefix) and p.endswith(".json")})
    if candidate_allowlist is not None:
        problem = allowlist_problem(candidate_allowlist)
        if problem:
            fail(list_path(review_dir), "candidate list: " + problem)
    pointers = {}
    if base_allowlist is not None:
        problem = allowlist_problem(base_allowlist)
        if problem:
            fail(list_path(review_dir), "base list: " + problem)
        else:
            pointers = {e["path"]: [pointer_tokens(p) for p in e["editable_text"]] for e in base_allowlist["plans"]}
    rewrites = [p for p in plans if p in pointers]
    ordinary = [p for p in plans if p not in pointers]

    split = None
    if rewrites:
        if not isinstance(split_map_bytes, bytes):
            problem = "the split-map is missing"
        elif hashlib.sha256(split_map_bytes).hexdigest() != base_allowlist["split_map_sha256"]:
            problem = "the split-map does not match split_map_sha256 of the base list"
        else:
            try:
                split = read_split_map(split_map_bytes)
            except (ValueError, UnicodeDecodeError) as exc:
                problem = str(exc)
        if split is None:
            for path in rewrites:
                fail(path, "not a listed rewrite: " + problem)

    allowed = []
    for path in rewrites:
        if path not in base_plans:
            fail(path, "a new plan is never a listed rewrite")
        elif path not in candidate_plans:
            fail(path, "a deleted plan is never a listed rewrite")
        elif split is not None:
            moves, common, projects = split
            try:
                selected = (set(selected_invariants(base_plans[path])) if selected_invariants
                            else assessment_ids(base_plans[path]))
            except CHECK_ERRORS as exc:
                fail(path, "selected invariants: " + str(exc))
                continue
            problems = rewrite_differences(base_plans[path], candidate_plans[path], pointers[path], moves,
                                           common | set(common_invariants), selected, projects,
                                           base_inputs.get("ledger") if isinstance(base_inputs, dict) else None)
            for message in problems:
                fail(path, message)
            if not problems:
                allowed.append(path)

    # Unlisted plans keep the rules before the list: one changed plan, on the PR's base.
    if len(ordinary) > 1 or not plans:
        for path in ordinary or [prefix]:
            fail(path, "include exactly one changed preflight plan in this PR (listed rewrites aside)")
    for path in ordinary:
        if path not in candidate_plans:
            fail(path, "a deleted plan cannot be checked: include exactly one changed preflight plan")
        elif not isinstance(candidate_plans[path], dict) or candidate_plans[path].get("base_sha") != base_sha:
            fail(path, "stale or invalid base_sha: regenerate/recheck plan")

    callbacks = [("plan check", check_plan,
                  {name: base_inputs[name] for name in ("catalog", "ledger", "global_ids", "config")})]
    if check_publication is not None:
        callbacks.append(("publication check", check_publication, {}))
    for path in plans:
        if path not in candidate_plans:
            continue
        for label, callback, materials in callbacks:
            try:
                passed = callback(path, deepcopy(candidate_plans[path]), **materials)
            except CHECK_ERRORS as exc:
                fail(path, label + ": " + str(exc))
                continue
            if passed is not True:
                fail(path, label + " failed")

    failed = {error["path"] for error in errors}
    return {"ok": not errors, "errors": errors, "exempted_paths": [p for p in allowed if p not in failed]}
