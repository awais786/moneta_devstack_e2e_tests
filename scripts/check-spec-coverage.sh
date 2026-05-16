#!/usr/bin/env bash
#
# check-spec-coverage.sh — verify every openspec requirement is either covered
# by a test (`// @spec module#slug` tag) OR explicitly deferred in
# docs/spec-coverage-deferred.md.
#
# Why this exists: docs/spec-coverage.md captures the current state, but the
# matrix drifts as new specs land upstream. This script regenerates the
# coverage delta deterministically and fails CI when a new requirement
# arrives without a corresponding tag or deferred-list entry.
#
# Inputs (in order of precedence):
#   $SPEC_DIR — path to a local sso-rules-moneta openspec/specs checkout.
#               If unset, fetches from GitHub raw.
#
# Outputs:
#   - stdout: markdown coverage table + delta
#   - exit 0 if every requirement is accounted for; exit 1 otherwise
#
# Tag format expected in tests/:
#   // @spec <module-slug>#<requirement-slug>
# where <module-slug> is the directory name under openspec/specs/ and
# <requirement-slug> is the lowercased title with non-alphanumeric runs
# collapsed to '-'.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DEFERRED_FILE="$REPO_ROOT/docs/spec-coverage-deferred.md"
TESTS_DIR="$REPO_ROOT/tests"

SPEC_MODULES=(
  proxy-auth-middleware
  oauth2-proxy-gateway
  forwardauth-traefik
  session-lifecycle
  cognito-claim-mapping
  logout-flow
  workspace-auto-join
)

# Slugify a requirement title: lowercase, collapse runs of non-alphanumerics
# to single '-', strip leading/trailing '-'. Same convention as the matrix.
slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'
}

# Read a spec file and emit the slugified requirement titles, one per line.
extract_reqs() {
  local module=$1 spec_path
  if [[ -n "${SPEC_DIR:-}" ]]; then
    spec_path="$SPEC_DIR/$module/spec.md"
    if [[ ! -f "$spec_path" ]]; then
      echo "ERROR: $spec_path not found (SPEC_DIR=$SPEC_DIR)" >&2
      return 1
    fi
    sed -nE 's/^### Requirement:[[:space:]]*(.+)$/\1/p' "$spec_path"
  else
    local url="https://raw.githubusercontent.com/awais786/sso-rules-moneta/main/openspec/specs/$module/spec.md"
    curl -fsSL "$url" 2>/dev/null \
      | sed -nE 's/^### Requirement:[[:space:]]*(.+)$/\1/p'
  fi
}

# Collect every `// @spec module#slug` tag from the test tree.
collect_tags() {
  if [[ ! -d "$TESTS_DIR" ]]; then
    return 0
  fi
  # grep returns 1 on no-match; mask it so `set -e` + pipefail don't abort.
  { grep -rhoE '// @spec [a-z0-9-]+#[a-z0-9-]+' "$TESTS_DIR" 2>/dev/null || true; } \
    | sed -E 's|^// @spec ||' \
    | sort -u
}

# Collect deferred entries from the deferred markdown file. The doc is
# organised by module header (`## <module-name>`) followed by list items of
# the form `- \`<requirement-title>\` — <category> — <rationale>`. Walk the
# file linearly, tracking the current module from the most recent `## ` line.
collect_deferred() {
  if [[ ! -f "$DEFERRED_FILE" ]]; then
    return 0
  fi
  awk '
    /^## / {
      module = $0
      sub(/^## +/, "", module)
      next
    }
    /^- `[^`]+`/ {
      if (module == "") next
      title = $0
      sub(/^- `/, "", title)
      sub(/`.*$/, "", title)
      print module "##" title
    }
  ' "$DEFERRED_FILE" \
    | while IFS='#' read -r module _ title; do
        # awk used `##` as separator so the empty middle field absorbs the
        # natural `#` in `module#title` without colliding with title text.
        printf '%s#%s\n' "$module" "$(slugify "$title")"
      done | sort -u
}

# ---------- main ----------

declare -a covered=()
declare -a deferred=()
declare -a missing=()
declare -a all_reqs=()

tags_blob=$(collect_tags)
deferred_blob=$(collect_deferred)

# Use newline-delimited blobs + grep instead of bash arrays + mapfile so the
# script runs on bash 3.2 (macOS default) as well as 4+/5+.
is_in_blob() {
  local needle=$1 blob=$2
  printf '%s\n' "$blob" | grep -Fqx "$needle"
}

for module in "${SPEC_MODULES[@]}"; do
  while IFS= read -r title; do
    [[ -z "$title" ]] && continue
    local_slug=$(slugify "$title")
    key="$module#$local_slug"
    all_reqs+=("$key")

    if is_in_blob "$key" "$tags_blob"; then
      covered+=("$key")
    elif is_in_blob "$key" "$deferred_blob"; then
      deferred+=("$key")
    else
      missing+=("$key")
    fi
  done < <(extract_reqs "$module")
done

total=${#all_reqs[@]}
n_cov=${#covered[@]}
n_def=${#deferred[@]}
n_miss=${#missing[@]}

echo "## SSO Spec Coverage Audit"
echo
echo "Contract: https://github.com/awais786/sso-rules-moneta/tree/main/openspec/specs"
echo
echo "| Status | Count |"
echo "|---|---|"
echo "| ✅ Covered (test tag found)  | $n_cov |"
echo "| ⚠️ Deferred (in deferred doc) | $n_def |"
echo "| ❌ Missing (no tag, no defer) | $n_miss |"
echo "| **Total requirements** | **$total** |"
echo

if [[ $n_miss -gt 0 ]]; then
  echo "### Missing — requirement landed upstream but not yet covered or deferred"
  echo
  for key in "${missing[@]}"; do
    echo "- \`$key\`"
  done
  echo
  echo "**Fix:** add a \`// @spec $key\` tag above the covering \`test()\` call,"
  echo "OR add an entry in \`docs/spec-coverage-deferred.md\` explaining why this"
  echo "requirement is not e2e-testable from this suite."
  exit 1
fi

echo "**All $total spec requirements are accounted for.**"
exit 0
