#!/usr/bin/env bash
# Creates the GitHub release for the tag vX.Y.Z: the docker pull command, the version's section of CHANGELOG.md and the
# link to the full comparison. Skips a version that already has a release.
#
#   ./github-release.sh 1.0.0
#
# release.sh calls this after pushing the image. Windows: run in Git Bash. Needs: git, gh (logged in).
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-}"
fail() { echo "github-release: $*" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "usage: ./github-release.sh X.Y.Z"
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || fail "tag v$VERSION does not exist"
git ls-remote --exit-code --tags origin "v$VERSION" >/dev/null || fail "tag v$VERSION is not pushed"
if gh release view "v$VERSION" >/dev/null 2>&1; then
  echo "GitHub release v$VERSION exists already"
  exit 0
fi

# until 0.11.0 the tool was called SmartCodeReview, with its own image
if [[ "$VERSION" == 0.* ]]; then
  NAME=SmartCodeReview IMAGE=culmi/smart-code-review
else
  NAME=CodeReviewLens IMAGE=culmi/code-review-lens
fi

# the lines between "## [X.Y.Z]" and the next "## [", without leading blank lines
section=$(awk -v v="$VERSION" 'index($0, "## [" v "]") == 1 { on = 1; next } on && /^## \[/ { exit } on' CHANGELOG.md \
  | tr -d '\r' | sed '/./,$!d')
[ -n "$section" ] || fail "CHANGELOG.md has no section '## [$VERSION]'"
compare=$(tr -d '\r' < CHANGELOG.md | grep -m1 "^\[$VERSION\]: " | cut -d' ' -f2 || true)

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
{
  printf '```bash\ndocker pull %s:%s\n```\n\n' "$IMAGE" "$VERSION"
  printf '%s\n' "$section"
  [ -z "$compare" ] || printf '\n**Vollständiger Vergleich:** %s\n' "$compare"
} > "$notes"

gh release create "v$VERSION" --verify-tag --title "$NAME $VERSION" --notes-file "$notes"
