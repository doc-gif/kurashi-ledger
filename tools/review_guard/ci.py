"""Trusted-base adapter. Does not execute candidate code or contact GitHub."""
import argparse
import json
from pathlib import Path
import sys

import guard


def inside(root, relative):
    path = root / relative
    guard.require(path.resolve().is_relative_to(root.resolve()), "review data escapes checkout")
    return path


def present(path):
    return path.exists() or path.is_symlink()


def read_bytes(path):
    """The exact bytes the base list's digest pins, with read_json's limits."""
    guard.require(not path.is_symlink(), "split-map symlinks are not accepted")
    guard.require(path.stat().st_size <= 1_048_576, "split-map exceeds 1 MiB limit")
    return path.read_bytes()


def check_with_rewrites(args, paths, plans, review_dir, baseline, global_ids, base_inputs, candidate_inputs):
    """Issue #46: the changed plans when a rewrite list exists. A listed plan is checked by guard with its own
    base_sha and its own path (its coverage stays as reviewed); the one ordinary plan, if any, with the PR's base and
    every other path. A PR of listed rewrites alone changes nothing but those plans and the split-map, and every PR
    that rewrites a listed plan deletes the list (owner, PR #49)."""
    import plan_rewrites  # the base copy next to this file, never the candidate's

    candidate = args.candidate
    list_name = plan_rewrites.list_path(review_dir)
    map_name = plan_rewrites.map_path(review_dir)

    def load(tree, relative):
        path = inside(tree, relative)
        return guard.read_json(path) if present(path) else None

    # A list file that exists is a list whatever it holds: `null` is not "no list" (PR49-R001).
    lists = {side: guard.read_json(inside(tree, list_name))
             for side, tree in (("base", baseline), ("candidate", candidate)) if present(inside(tree, list_name))}
    base_list, candidate_list = lists.get("base"), lists.get("candidate")
    split_map = None
    for tree in (candidate, baseline):
        if split_map is None and present(inside(tree, map_name)):
            split_map = read_bytes(inside(tree, map_name))
    base_plans = {p: load(baseline, p) for p in plans if present(inside(baseline, p))}
    candidate_plans = {p: load(candidate, p) for p in plans if present(inside(candidate, p))}
    listed = plan_rewrites.listed_paths(base_list)
    rewritten = [p for p in plans if p in listed]
    # The split-map is the rewrites' input, pinned by the base list, and the list's deletion is part of the
    # rewrites: neither is a path of the ordinary plan.
    ordinary_paths = [p for p in paths if p not in rewritten and not (rewritten and p in (map_name, list_name))]
    rules = guard.with_extensions(guard.validate(base_inputs["catalog"], base_inputs["ledger"], global_ids)[0],
                                  guard.path_extensions(base_inputs["config"], global_ids))
    reports = {}

    def check_plan(path, plan, *, catalog, ledger, global_ids, config):
        own, base = ([path], plan.get("base_sha")) if path in listed else (ordinary_paths, args.base_sha)
        reports[path] = guard.check(catalog, ledger, plan, own, base, review_dir, global_ids,
                                    guard.path_extensions(config, global_ids))
        return True

    result = plan_rewrites.check_rewrite_batch(
        base_plans=base_plans, candidate_plans=candidate_plans, changed_paths=paths, base_sha=args.base_sha,
        base_allowlist=base_list, candidate_allowlist=candidate_list, split_map_bytes=split_map,
        base_inputs=base_inputs, candidate_inputs=candidate_inputs, check_plan=check_plan, review_dir=review_dir,
        common_invariants=guard.global_rule_ids(global_ids) if global_ids is not None else (),
        selected_invariants=lambda plan: guard.affected(rules, guard.paths_list(plan.get("planned_paths"))))
    errors = list(result["errors"])
    errors += [{"path": list_name, "message": side + " list: the list must be a JSON object, not null"}
               for side, value in lists.items() if value is None]
    if rewritten and "candidate" in lists:
        # The rewrite happens once: the PR that rewrites listed plans deletes the list (owner, PR #49).
        errors.append({"path": list_name, "message": "a PR that rewrites listed plans deletes the rewrite list"})
    exempted = set(result["exempted_paths"])
    if result["ok"] and exempted == set(plans):
        others = sorted(p for p in paths if p not in exempted and p not in (map_name, list_name))
        if others:
            errors.append({"path": list_name, "message": "a PR of listed rewrites alone changes only those plans and"
                           " the split-map; plan the other paths in one ordinary plan: " + guard.listed(others)})
    if errors:
        for error in errors:
            print("review-guard: " + json.dumps(error, ensure_ascii=True), file=sys.stderr)
        return 1
    print(json.dumps({"exempted_paths": sorted(exempted), "plans": reports}, ensure_ascii=True, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--paths-file", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--review-dir", default=".review",
                        help="the review directory (catalog, ledger and plans) in both trees; default .review")
    args = parser.parse_args()
    try:
        guard.require_runtime()
        review_dir = guard.review_directory(args.review_dir)
        paths = guard.paths_list(guard.read_json(args.paths_file))
        candidate = args.candidate
        baseline = Path(__file__).resolve().parents[2]
        # Design 8: the global ID catalogue comes from the trusted base copy only; a candidate cannot change the
        # coverage it requires. Without it the project ledger alone applies.
        ids_path = inside(baseline, review_dir + "/mekiki/global-ids.json")
        global_ids = guard.read_json(ids_path) if ids_path.is_file() else None
        # The project ledger is in <review-dir>/causes/ (design 8) when the base has it there; a base from before
        # the split keeps it in <review-dir>/. The base decides for both trees.
        ledger_dir = review_dir + "/causes" if inside(baseline, review_dir + "/causes/invariants.json").is_file() else review_dir
        candidate_catalog = guard.read_json(inside(candidate, ledger_dir + "/invariants.json"))
        candidate_ledger = guard.read_json(inside(candidate, ledger_dir + "/findings.json"))
        guard.validate(candidate_catalog, candidate_ledger, global_ids)
        # [causes.paths] (design 8) selects from the base's settings (A7): a candidate that removes a line cannot
        # narrow its own check. The candidate's settings are validated so a broken file never becomes the base.
        base_config = guard.read_config(inside(baseline, review_dir + "/config.toml"))
        candidate_config = guard.read_config(inside(candidate, review_dir + "/config.toml"))
        extensions = guard.path_extensions(base_config, global_ids)
        guard.path_extensions(candidate_config, global_ids)
        plans = [p for p in paths if p.startswith(guard.plans_prefix(review_dir)) and p.endswith(".json")]
        # Issue #46: with a rewrite list in either tree, plan_rewrites decides the plan rules (only the base's list
        # grants anything). Without one, the rules stay as they were.
        rewrite_list = any(present(inside(tree, review_dir + "/mekiki/plan-rewrites.json"))
                           for tree in (baseline, candidate))
        if not rewrite_list:
            guard.require(len(plans) == 1, "include exactly one changed preflight plan in this PR")
        base_catalog = guard.read_json(inside(baseline, ledger_dir + "/invariants.json"))
        base_ledger = guard.read_json(inside(baseline, ledger_dir + "/findings.json"))
        changes = guard.policy_changes(base_catalog, candidate_catalog)
        # Report even when the subsequent plan check fails.
        print(json.dumps({"policy_changes_to_review": changes,
                          "ledger_changed": base_ledger != candidate_ledger,
                          "notice": "Changed policy needs independent review before it becomes the next base."}))
        if rewrite_list:
            return check_with_rewrites(args, paths, plans, review_dir, baseline, global_ids,
                                       {"catalog": base_catalog, "ledger": base_ledger, "global_ids": global_ids,
                                        "config": base_config},
                                       {"catalog": candidate_catalog, "ledger": candidate_ledger, "global_ids": None,
                                        "config": candidate_config})
        result = guard.check(base_catalog, base_ledger,
                             guard.read_json(inside(candidate, plans[0])), paths, args.base_sha, review_dir,
                             global_ids, extensions)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (guard.Invalid, OSError, ValueError, TypeError, KeyError, AttributeError, ImportError) as exc:
        print(f"review-guard: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
