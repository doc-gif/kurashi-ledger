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
    args = parser.parse_args()
    try:
        paths = guard.paths_list(guard.read_json(args.paths_file))
        candidate = args.candidate
        guard.validate(guard.read_json(inside(candidate, ".review/invariants.json")),
                       guard.read_json(inside(candidate, ".review/findings.json")))
        plans = [p for p in paths if p.startswith(".review/plans/") and p.endswith(".json")]
        guard.require(len(plans) == 1, "include exactly one changed preflight plan in this PR")
        baseline = Path(__file__).resolve().parents[2]
        result = guard.check(guard.read_json(baseline / ".review/invariants.json"),
                             guard.read_json(baseline / ".review/findings.json"),
                             guard.read_json(inside(candidate, plans[0])), paths, args.base_sha)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (guard.Invalid, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"review-guard: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
