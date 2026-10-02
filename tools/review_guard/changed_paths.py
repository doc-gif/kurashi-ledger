"""Git adapter for PR paths. Run this file from the trusted base, never candidate code."""
import argparse
from pathlib import Path
import subprocess
import sys

import guard


def changed_paths(repository, base, head):
    guard.require(guard.sha(base) and guard.sha(head), "base/head must be full SHAs")
    command = ["git", "-C", str(repository)]
    ancestor = subprocess.run(command + ["merge-base", "--is-ancestor", base, head],
                              capture_output=True)
    guard.require(ancestor.returncode == 0,
                  "base is not incorporated or ancestry is unavailable: incorporate base and recheck the existing plan")
    raw = subprocess.check_output(command + ["diff", "--no-ext-diff", "--no-textconv",
                                            "--no-renames", "--name-only", "-z", base + "..." + head])
    return guard.paths_list([p.decode("utf-8") for p in raw.split(b"\0") if p])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        guard.require_runtime()
        guard.write_json(args.output, changed_paths(args.repository, args.base_sha, args.head_sha))
        return 0
    except (guard.Invalid, OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"review-guard: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
