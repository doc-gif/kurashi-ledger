#!/bin/sh
# Owner command for PR48-R008 (docs/review-dispatch-implementation.md): the CI trust digest of one
# commit, the same value as ciTrustDigest() in scripts/lib/review-dispatch/github.ts.
#   sh <trusted copy>/tools/review_dispatch/ci-trust-digest.sh <repository> <commit>
# Run it from the trusted copy, never from the PR checkout. It only reads the repository with git.
# -z keeps paths unquoted (core.quotePath=false as well), so a non-ASCII path hashes like the API path.
# The path list must match CI_TRUST_PATHS and CI_TRUST_EXCLUDED in github.ts.
set -eu
if [ "$#" -ne 2 ]; then
  echo "usage: sh ci-trust-digest.sh <repository> <commit>" >&2
  exit 2
fi
repo=$1
commit=$2
# Without this check a wrong commit would print the digest of an empty list.
git -C "$repo" cat-file -e "${commit}^{commit}"
tab=$(printf '\t')
git -C "$repo" -c core.quotePath=false ls-tree -r -z --full-tree "$commit" \
  | tr '\000' '\n' \
  | grep -E "${tab}(\\.github/|\\.npmrc\$|package\\.json\$|tools/review_guard/|scripts/check-test-skips\\.ts\$|scripts/lib/test-skips\\.ts\$|docs/development\\.md\$)" \
  | grep -Ev "${tab}(.*/)?tests/|\\.test\\.[cm]?[jt]s\$|${tab}(.*/)?test_[^/]*\\.py\$" \
  | LC_ALL=C sort -t "$tab" -k2,2 \
  | shasum -a 256 \
  | cut -d ' ' -f 1
