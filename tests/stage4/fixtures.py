"""Synthetic inputs from design 8, not from the implementation or real ledgers."""
import copy
import hashlib

BASE = "a" * 40
GLOBAL_CATALOG = {"schema_version": 1, "invariants": [
    {"id": "G-A", "condition": "ＳＹＮＴＨＥＴＩＣ ＲＥＤ ＢＡＬＬＯＯＮ keeps its fictional identity across every midnight boundary.",
     "paths": ["src/*"], "related": ["G-B"],
     "scenarios": [{"id": "read", "question": "Does the imaginary violet lantern retain seventeen independent handles?"}]},
    {"id": "G-B", "condition": "合成の銀色の風車は深夜の交換でも七つの架空の歯車を失わない。",
     "paths": ["lib/*"], "related": ["G-A"],
     "scenarios": [{"id": "race", "question": "合成の二人の観測者は紫色の紙の鍵を同時に取得できないか。"}]}]}
GLOBAL_LEDGER = {"schema_version": 1, "findings": [
    {"id": "C-0001", "invariant_id": "G-A", "cause_key": "fictional-identity",
     "lesson": "A synthetic copper telescope must preserve twenty three numbered cardboard lenses.",
     "sources": ["https://synthetic-global.example.test/private/rose-atlas"]},
    {"id": "C-0002", "invariant_id": "G-B", "cause_key": "fictional-identity",
     "lesson": "合成の青い飛行船は折り畳んだ架空の地図を交換後も保管する。",
     "sources": ["https://synthetic-global.example.test/private/blue-compass"]}]}
LOCAL_CATALOG = {"schema_version": 1, "invariants": [
    {"id": "L-A", "condition": "The synthetic local garden keeps its own fence.", "paths": ["local/*"],
     "related": ["G-A"], "scenarios": [{"id": "write", "question": "Does the local garden retain its gate?"}]}]}
LOCAL_LEDGER = {"schema_version": 1, "findings": [
    {"id": "C-0003", "invariant_id": "L-A", "cause_key": "local-fence",
     "lesson": "The local synthetic fence remains stable.", "sources": ["https://synthetic-local.example.test/fence"]}]}


def digest(invariant, cause):
    return hashlib.sha256((invariant + "\n" + cause).encode("utf-8")).hexdigest()


def index():
    """Expected public data schema. Built independently from the table in design 8."""
    return {"schema_version": 1, "invariants": [
        {"id": r["id"], "paths": copy.deepcopy(r["paths"]), "related": copy.deepcopy(r["related"]),
         "scenarios": [{"id": s["id"]} for s in r["scenarios"]]} for r in GLOBAL_CATALOG["invariants"]],
        "findings": [{"id": f["id"], "invariant_id": f["invariant_id"],
                      "cause_key_hash": digest(f["invariant_id"], f["cause_key"])}
                     for f in GLOBAL_LEDGER["findings"]]}


def merged():
    return ({"schema_version": 1, "invariants": copy.deepcopy(GLOBAL_CATALOG["invariants"] + LOCAL_CATALOG["invariants"])},
            {"schema_version": 1, "findings": copy.deepcopy(GLOBAL_LEDGER["findings"] + LOCAL_LEDGER["findings"])})


def selected(paths):
    # Fixed synthetic cases; never compute an oracle with guard.affected.
    if any(p.startswith("local/") for p in paths):
        return ["G-A", "G-B", "L-A"]
    if any(p.startswith(("src/", "lib/")) for p in paths):
        return ["G-A", "G-B"]
    return []


def plan(paths, analyzed=True):
    catalog, ledger = merged()
    ids = selected(paths)
    rules = {r["id"]: r for r in catalog["invariants"]}
    causes = {f["invariant_id"]: f["cause_key"] for f in ledger["findings"]}
    return {"schema_version": 2, "task_id": "SYN-4", "base_sha": BASE, "planned_paths": list(paths),
            "conflicts": [], "assessments": [
                {"id": rid, "disposition": "preserve", "reason": "Check this synthetic boundary independently.",
                 "checks": [{"id": s["id"], "method": "Two independent synthetic observations.",
                             "expected": "Both observe the same fictional resource."} for s in rules[rid]["scenarios"]]}
                for rid in ids],
            "boundaries": [{"id": "B1", "direction": "entry", "location": paths[0], "data": "synthetic input",
                            "trust": "untrusted", "control": "Validate before the fictional operation."}] if ids else [],
            "variant_analysis": [dict({"invariant_id": rid, "pattern": "The same synthetic boundary elsewhere.",
                                       "places": [{"location": paths[0], "result": "Same fictional identity retained."}]},
                                      **({"cause_key": causes[rid]} if analyzed else {})) for rid in ids],
            "context": {"L-A": {"condition": rules["L-A"]["condition"],
                                     "scenarios": copy.deepcopy(rules["L-A"]["scenarios"]),
                                     "history": copy.deepcopy(LOCAL_LEDGER["findings"])}} if "L-A" in ids else {}}


def global_texts():
    return ([r["condition"] for r in GLOBAL_CATALOG["invariants"]] +
            [s["question"] for r in GLOBAL_CATALOG["invariants"] for s in r["scenarios"]] +
            [f["lesson"] for f in GLOBAL_LEDGER["findings"]] +
            [s for f in GLOBAL_LEDGER["findings"] for s in f["sources"]])
