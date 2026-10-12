"""Synthetic Issue #46 inputs based on the public README and plan specification.

No public plan text or implementation-derived schema is used here. Context and
places use the I46-R003 shapes; split-map uses its named top-level/row keys.
README does not specify the nested from/to or new_invariants JSON: the shapes
below are proposals, not verified compatibility with split/rewrite-plans.
The API is documented in test_plan_rewrites.py. Digests cover exact map bytes.
"""

from copy import deepcopy
import hashlib
import json


BASE_SHA = "a" * 40
OLD_SHA = "b" * 40
PLAN_A = ".review/plans/SYNTHETIC-A.json"
PLAN_B = ".review/plans/SYNTHETIC-B.json"
OPS_LEDGER = ".review/plans/OPS-LEDGER-PR10-PR12.json"
OPS_REVIEWER = ".review/plans/OPS-github-app-reviewer.json"
SHARED_TEXT = "Synthetic shared sentence reserved for a host publication fixture."


def variant(cause_key="old-a", invariant_id="INV-OLD"):
    return {
        "invariant_id": invariant_id,
        "cause_key": cause_key,
        "pattern": "synthetic-pattern",
        "places": [{"location": "src/synthetic.py", "result": "Synthetic boundary remains covered."}],
        "disposition": "preserve",
        "reason": "Keep the synthetic boundary.",
        "notes": "Synthetic analysis note.",
    }


def fallback(row):
    # Issue #44 B: retain coverage, without inventing a cause decision.
    return {key: deepcopy(row[key]) for key in ("invariant_id", "pattern", "places")}


def plan(task_id):
    return {
        "schema_version": 2,
        "task_id": task_id,
        "base_sha": OLD_SHA,
        "planned_paths": ["src/synthetic.py"],
        "assessments": [
            {
                "id": invariant_id,
                "disposition": "preserve",
                "reason": "Preserve the synthetic requirement.",
                "checks": [{"id": "SYNTHETIC-1", "method": "Inspect fixture.", "expected": "Fixture remains covered."}],
                "decision_references": [],
            }
            for invariant_id in ("INV-OLD", "INV-GLOBAL")
        ],
        "boundaries": [{"id": "B1", "direction": "entry", "location": "src/synthetic.py",
                        "data": "Synthetic input.", "trust": "untrusted", "control": "Reject unknown input."}],
        "variant_analysis": [variant()],
        "context": {
            "INV-GLOBAL": {"condition": SHARED_TEXT,
                           "scenarios": [{"id": "SYNTHETIC-1", "question": "Is the synthetic shared boundary covered?"}],
                           "history": [{"id": "PR1-R001", "invariant_id": "INV-OLD", "cause_key": "old-a", "lesson": SHARED_TEXT}]},
            "INV-OLD": {"condition": "Synthetic project condition.",
                        "scenarios": [{"id": "SYNTHETIC-1", "question": "Is the synthetic project boundary covered?"}],
                        "history": [
                            {"id": "PR1-R003", "invariant_id": "INV-OLD", "cause_key": "local-a", "lesson": "Synthetic project history."},
                            {"id": "PR1-R001", "invariant_id": "INV-OLD", "cause_key": "old-a", "lesson": "Synthetic old global history."},
                            {"id": "PR1-R004", "invariant_id": "INV-OLD", "cause_key": "both-a", "lesson": "Synthetic old both history."},
                        ]},
        },
        "conflicts": [
            {"description": f"Synthetic conflict {index}.", "state": "resolved", "resolution": f"Synthetic resolution {index}."}
            for index in range(9)
        ],
        "notes": "Synthetic plan note.",
    }


def project_ledger():
    # Fixed synthetic base authority; text intentionally differs from old history.
    return {"schema_version": 1, "findings": [
        {"id": "C-0003", "invariant_id": "INV-OLD", "cause_key": "local-a",
         "lesson": "Synthetic authoritative project lesson.",
         "sources": ["https://example.invalid/synthetic-project-source"]},
        {"id": "C-0005", "invariant_id": "INV-OLD", "cause_key": "both-a",
         "lesson": "Synthetic authoritative project both lesson.",
         "sources": ["https://example.invalid/synthetic-project-both-source"]},
    ]}


def rewrite(before):
    after = deepcopy(before)
    del after["context"]["INV-GLOBAL"]
    row = after["variant_analysis"][0]
    after["variant_analysis"].append(fallback(row))
    row["invariant_id"] = "INV-GLOBAL"
    row["cause_key"] = "new-a"
    # Owner decision 6116583631: source order survives, global-only is removed.
    # This fixture has fixed PR1-R003 and PR1-R004 project mappings, not an
    # implementation of the policy under test.
    after["context"]["INV-OLD"]["history"] = deepcopy(project_ledger()["findings"])
    return after


def split_map():
    return {
        "schema_version": 1,
        "repo": "synthetic/plan-rewrites",
        "new_invariants": ["INV-GLOBAL"],
        "findings": [
            {
                "source_id": "PR1-R001", "id": "C-0001", "both": False,
                "from": {"invariant_id": "INV-OLD", "cause_key": "old-a"},
                "scope": "global",
                "to": {"invariant_id": "INV-GLOBAL", "cause_key": "new-a"},
            },
            {
                "source_id": "PR1-R002", "id": "C-0002", "both": False,
                "from": {"invariant_id": "INV-OLD", "cause_key": "old-b"},
                "scope": "global",
                "to": {"invariant_id": "INV-GLOBAL", "cause_key": "new-b"},
            },
            {
                "source_id": "PR1-R003", "id": "C-0003", "both": False,
                "from": {"invariant_id": "INV-OLD", "cause_key": "local-a"},
                "scope": "project",
                "to": {"invariant_id": "INV-OLD", "cause_key": "local-a"},
            },
            {
                "source_id": "PR1-R004", "id": "C-0004", "both": True,
                "from": {"invariant_id": "INV-OLD", "cause_key": "both-a"},
                "scope": "global",
                "to": {"invariant_id": "INV-GLOBAL", "cause_key": "shared-both-a"},
            },
            {
                "source_id": "PR1-R004", "id": "C-0005", "both": True,
                "from": {"invariant_id": "INV-OLD", "cause_key": "both-a"},
                "scope": "project",
                "to": {"invariant_id": "INV-OLD", "cause_key": "both-a"},
            },
        ],
    }


def encode_map(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def make_batch(paths=(PLAN_A, PLAN_B)):
    map_bytes = encode_map(split_map())
    all_paths = (PLAN_A, PLAN_B, OPS_LEDGER, OPS_REVIEWER)
    base_plans = {path: plan(path.rsplit("/", 1)[1][:-5]) for path in all_paths}
    candidate_plans = deepcopy(base_plans)
    for path in paths:
        candidate_plans[path] = rewrite(base_plans[path])
    allowlist = {
        "schema_version": 1,
        "split_map_sha256": hashlib.sha256(map_bytes).hexdigest(),
        "plans": [
            {"path": PLAN_A, "editable_text": []},
            {"path": PLAN_B, "editable_text": []},
            {"path": OPS_LEDGER, "editable_text": ["/conflicts/5/resolution"]},
            {"path": OPS_REVIEWER, "editable_text": ["/conflicts/5", "/conflicts/8"]},
        ],
    }
    base_inputs = {name: {"fixture_source": "base", "kind": name} for name in ("catalog", "ledger", "global_ids", "config")}
    base_inputs["ledger"] = project_ledger()
    return {
        "base_plans": base_plans,
        "candidate_plans": candidate_plans,
        "changed_paths": list(paths),
        "base_sha": BASE_SHA,
        "base_allowlist": allowlist,
        "candidate_allowlist": deepcopy(allowlist),
        "split_map_bytes": map_bytes,
        # The exact existing guard input schemas are deliberately not inferred.
        # These values are distinguishable tokens for callback forwarding only.
        "base_inputs": base_inputs,
        "candidate_inputs": {name: {"fixture_source": "candidate", "kind": name} for name in ("catalog", "ledger", "global_ids", "config")},
    }
