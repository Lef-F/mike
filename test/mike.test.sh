#!/usr/bin/env bash
# Test the ./mike wrapper's mode → profile-flag mapping.
# Calls `./mike --print-profiles` against a fake .env and asserts the
# computed flags. Does not actually invoke docker compose.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0

write_env() {
  cat > "$TMPDIR/.env" <<EOF
MIKE_SUPABASE_MODE=$1
MIKE_STORAGE_MODE=$2
EOF
}

run_case() {
  local name="$1" sup="$2" sto="$3" expected="$4"
  write_env "$sup" "$sto"
  local got
  got="$(cd "$TMPDIR" && "$REPO_ROOT/mike" --print-profiles 2>&1 || true)"
  if [ "$got" = "$expected" ]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "    expected: $expected"
    echo "    got:      $got"
    FAIL=$((FAIL + 1))
  fi
}

run_case "bundled-full + bundled"      "bundled-full"   "bundled"  "--profile db-bundled --profile supabase-shim --profile storage-bundled"
run_case "bundled-full + external"     "bundled-full"   "external" "--profile db-bundled --profile supabase-shim"
run_case "bundled-byo-db + bundled"    "bundled-byo-db" "bundled"  "--profile supabase-shim --profile storage-bundled"
run_case "bundled-byo-db + external"   "bundled-byo-db" "external" "--profile supabase-shim"
run_case "external + bundled"          "external"       "bundled"  "--profile storage-bundled"
run_case "external + external"         "external"       "external" ""

# Reject invalid modes.
write_env "garbage" "bundled"
if (cd "$TMPDIR" && "$REPO_ROOT/mike" --print-profiles >/dev/null 2>&1); then
  echo "  FAIL: invalid MIKE_SUPABASE_MODE should reject"; FAIL=$((FAIL + 1))
else
  echo "  PASS: invalid MIKE_SUPABASE_MODE rejected"; PASS=$((PASS + 1))
fi

write_env "bundled-full" "wat"
if (cd "$TMPDIR" && "$REPO_ROOT/mike" --print-profiles >/dev/null 2>&1); then
  echo "  FAIL: invalid MIKE_STORAGE_MODE should reject"; FAIL=$((FAIL + 1))
else
  echo "  PASS: invalid MIKE_STORAGE_MODE rejected"; PASS=$((PASS + 1))
fi

# Verify the read_var regex: '#' is only a comment when preceded by whitespace.
# (1) Value containing '#' with NO leading whitespace must be preserved verbatim,
#     which means mode validation should reject it as an invalid mode value.
cat > "$TMPDIR/.env" <<EOF
MIKE_SUPABASE_MODE=bundled-full#nopecomment
MIKE_STORAGE_MODE=bundled
EOF
if (cd "$TMPDIR" && "$REPO_ROOT/mike" --print-profiles >/dev/null 2>&1); then
  echo "  FAIL: 'bundled-full#nopecomment' should fail validation (regex must NOT treat '#' as comment without whitespace)"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: '#' without leading whitespace preserved (no premature truncation)"
  PASS=$((PASS + 1))
fi

# (2) Value with whitespace then '#' IS a comment — should be stripped, parsed as bundled-full.
cat > "$TMPDIR/.env" <<EOF
MIKE_SUPABASE_MODE=bundled-full   # this is a real comment
MIKE_STORAGE_MODE=bundled
EOF
got="$(cd "$TMPDIR" && "$REPO_ROOT/mike" --print-profiles 2>&1 || true)"
expected="--profile db-bundled --profile supabase-shim --profile storage-bundled"
if [ "$got" = "$expected" ]; then
  echo "  PASS: trailing '# comment' (with leading whitespace) correctly stripped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: trailing comment stripping broke"
  echo "    expected: $expected"
  echo "    got:      $got"
  FAIL=$((FAIL + 1))
fi

echo
echo "Results: $PASS passed, $FAIL failed"
exit $FAIL
