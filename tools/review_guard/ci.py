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
        extensions = guard.path_extensions(guard.read_config(inside(baseline, review_dir + "/config.toml")), global_ids)
        guard.path_extensions(guard.read_config(inside(candidate, review_dir + "/config.toml")), global_ids)
        plans = [p for p in paths if p.startswith(guard.plans_prefix(review_dir)) and p.endswith(".json")]
        guard.require(len(plans) == 1, "include exactly one changed preflight plan in this PR")
        base_catalog = guard.read_json(inside(baseline, ledger_dir + "/invariants.json"))
        base_ledger = guard.read_json(inside(baseline, ledger_dir + "/findings.json"))
        changes = guard.policy_changes(base_catalog, candidate_catalog)
        # Report even when the subsequent plan check fails.
        print(json.dumps({"policy_changes_to_review": changes,
                          "ledger_changed": base_ledger != candidate_ledger,
                          "notice": "Changed policy needs independent review before it becomes the next base."}))
        result = guard.check(base_catalog, base_ledger,
                             guard.read_json(inside(candidate, plans[0])), paths, args.base_sha, review_dir,
                             global_ids, extensions)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (guard.Invalid, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"review-guard: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
