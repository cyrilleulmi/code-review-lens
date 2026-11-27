#!/usr/bin/env bash
# Updates the overview of the image on Docker Hub (short description + DOCKERHUB.md).
#
#   DOCKERHUB_TOKEN=dckr_pat_... ./dockerhub-overview.sh
#
# Needs a Docker Hub personal access token with "Read, Write, Delete" (hub.docker.com → Account settings → Personal
# access tokens; "Read & Write" is not enough to change the description: "insufficient scope"); the account is the image's namespace unless DOCKERHUB_USER says otherwise. release.sh calls this when
# DOCKERHUB_TOKEN is set. Windows: run in Git Bash. Needs: curl, node.
set -euo pipefail
cd "$(dirname "$0")"

REPO=culmi/code-review-lens
SHORT="Code review by meaning, not by file: quick wins and data flows for GitHub PRs and GitLab MRs"
export DOCKERHUB_USER="${DOCKERHUB_USER:-${REPO%%/*}}"

[ -n "${DOCKERHUB_TOKEN:-}" ] || { echo "dockerhub-overview: set DOCKERHUB_TOKEN (personal access token, Read, Write, Delete)" >&2; exit 1; }

# the token goes to curl on stdin, not on the command line
jwt=$(node -e 'process.stdout.write(JSON.stringify({ username: process.env.DOCKERHUB_USER, password: process.env.DOCKERHUB_TOKEN }))' \
  | curl -fsS -H 'Content-Type: application/json' --data-binary @- https://hub.docker.com/v2/users/login \
  | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).token))')

answer=$(mktemp)
trap 'rm -f "$answer" "$answer.status"' EXIT
node -e 'const fs = require("fs"); process.stdout.write(JSON.stringify({ description: process.argv[1], full_description: fs.readFileSync("DOCKERHUB.md", "utf8") }))' "$SHORT" \
  | curl -sS -o "$answer" -w '%{http_code}' -X PATCH -H "Authorization: Bearer $jwt" -H 'Content-Type: application/json' \
    --data-binary @- "https://hub.docker.com/v2/repositories/$REPO/" > "$answer.status"
status=$(cat "$answer.status")
if [ "$status" != 200 ]; then
  echo "dockerhub-overview: Docker Hub answered $status: $(head -c 300 "$answer")" >&2
  exit 1
fi

echo "Overview updated: https://hub.docker.com/r/$REPO"
