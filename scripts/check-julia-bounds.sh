#!/usr/bin/env bash
# Checks that the julia bounds in JETLS_VERSION.json mirror the pinned
# JETLS release's `julia` compat entry, which is required to stay in the
# `<lower> - <upper>` hyphen-range form this comparison assumes; drift in
# either direction fails the check.
#
# The pinned release's Project.toml is read through the GitHub contents
# API via `gh api`.
set -euo pipefail

cd "$(dirname "$0")/.."

MANIFEST=JETLS_VERSION.json
REVISION=$(node -p "require('./$MANIFEST').revision")
JULIA_LOWER=$(node -p "require('./$MANIFEST').julia.lower")
JULIA_UPPER=$(node -p "require('./$MANIFEST').julia.upper")

JETLS_REPOSITORY=aviatesk/JETLS.jl
PROJECT_TOML=$(gh api "repos/$JETLS_REPOSITORY/contents/Project.toml?ref=$REVISION" \
    --jq .content | base64 -d)

COMPAT=$(printf '%s\n' "$PROJECT_TOML" |
    sed -n '/^\[compat\]/,/^\[/p' | sed -n 's/^julia = "\(.*\)"$/\1/p')
if [[ -z "$COMPAT" ]]; then
    echo "Error: could not read the julia compat entry of the pinned release $REVISION."
    exit 1
fi
if [[ "$COMPAT" != "$JULIA_LOWER - $JULIA_UPPER" ]]; then
    echo "Error: julia bounds in $MANIFEST ($JULIA_LOWER - $JULIA_UPPER)" \
        "do not match the pinned release's julia compat ($COMPAT)."
    exit 1
fi
echo "julia bounds in $MANIFEST match the pinned release $REVISION ($COMPAT)."
