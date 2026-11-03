#!/usr/bin/env bash
#
# Check the packed package on its own — no DSH profile, no model call, no
# network. `scripts/verify-bundle.sh` proves the whole install path but needs a
# local DSH; this one is what CI can run on every push.
#
# It catches the mistakes that have actually happened here: a module imported by
# index.js but missing from `files`, test fixtures leaking into the tarball, and
# the vendored binary arriving without its executable bit.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "packing"
TARBALL="$(cd "$TMP" && npm pack --silent "$REPO" | tail -1)"
[ -f "$TMP/$TARBALL" ] || { echo "npm pack produced nothing" >&2; exit 1; }

say "inspecting the tarball"
FILES="$(tar -tzf "$TMP/$TARBALL" | sed 's|^package/||' | sort)"
for required in package.json index.js stream-text.mjs login.mjs cordis.patch.yml bin/catpaw-cli; do
  echo "$FILES" | grep -qx "$required" || { echo "missing from the tarball: $required" >&2; exit 1; }
  echo "  ok  $required"
done
for forbidden in '.*\.test\.mjs$' '^fixtures/' '^examples/' '^scripts/' 'auth\.json'; do
  if echo "$FILES" | grep -Eq "$forbidden"; then
    echo "must not ship: $(echo "$FILES" | grep -E "$forbidden" | tr '\n' ' ')" >&2
    exit 1
  fi
done
echo "  ok  no tests, fixtures, examples or credentials"

say "installing the tarball into a throwaway project"
mkdir -p "$TMP/app"
( cd "$TMP/app" && npm init -y >/dev/null 2>&1 && npm install --silent --no-audit --no-fund "$TMP/$TARBALL" >/dev/null )

say "loading it the way the harness does"
( cd "$TMP/app" && node -e "
import('dsh-catpaw').then((m) => {
  const missing = ['apply', 'inject', 'name'].filter((key) => !(key in m));
  if (missing.length) throw new Error('module is missing ' + missing.join(', '));
  const helpers = ['parseToolCalls', 'parseLongcatCalls', 'parseDsmlCalls', 'renderPrompt', 'readSettings'];
  const absent = helpers.filter((key) => !(key in m));
  if (absent.length) throw new Error('helpers missing: ' + absent.join(', '));
  const models = m.readSettings({}).models;
  if (models.length !== 12) throw new Error('catalogue has ' + models.length + ' models');
  console.log('loaded:', Object.keys(m).length, 'exports,', models.length, 'models');
}).catch((error) => { console.error(error.message); process.exit(1); });
" )

say "checking the vendored CLI is runnable"
CLI="$TMP/app/node_modules/dsh-catpaw/bin/catpaw-cli"
[ -x "$CLI" ] || { echo "bin/catpaw-cli lost its executable bit through packing" >&2; exit 1; }
echo "  ok  $CLI"

say "ok"
