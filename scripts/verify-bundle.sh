#!/usr/bin/env bash
#
# Verify the installed form of the plugin — the shape a user gets from
# `dsh plugin add github:Smartloe/dsh-catpaw`, not the repo checkout that the
# other smoke tests load.
#
# It packs this repository, installs the tarball into a throwaway DSH home whose
# profile lists `dsh-catpaw` as a bundle, then composes the profile and (unless
# --offline) answers one prompt through it. The vendored `bin/catpaw-cli` must
# be the binary that runs, so the resolution order is exercised too.
#
#   ./scripts/verify-bundle.sh              # compose + one real model call
#   ./scripts/verify-bundle.sh --offline    # compose only (no model call)
#
# Requires: node, npm, dsh, and a signed-in 妙手 account for the model call.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OFFLINE=0
[ "${1:-}" = "--offline" ] && OFFLINE=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PROFILE="$TMP/home/profiles/verify"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "packing $REPO"
TARBALL="$(cd "$TMP" && npm pack --silent "$REPO" | tail -1)"
[ -f "$TMP/$TARBALL" ] || { echo "pack failed" >&2; exit 1; }

say "building a throwaway profile"
mkdir -p "$TMP/home/profiles"
cp -R "$HOME/.dsh/profiles/headless" "$PROFILE"
python3 - "$PROFILE" "$TMP/$TARBALL" <<'PY'
import json, sys
profile, tarball = sys.argv[1], sys.argv[2]
path = f"{profile}/package.json"
pkg = json.load(open(path, encoding="utf-8"))
pkg["name"] = "dsh-profile-verify"
pkg.setdefault("dependencies", {})["dsh-catpaw"] = f"file:{tarball}"
bundles = pkg["dsh"]["profile"]["bundles"]
if "dsh-catpaw" not in bundles:
    bundles.append("dsh-catpaw")
json.dump(pkg, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY

# the headless app boots whichever provider the profile names, so point it here
cat >>"$PROFILE/cordis.patch.yml" <<'YAML'
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: catpaw
    model: "10002544"
YAML

( cd "$PROFILE" && npm install --silent --no-audit --no-fund >/dev/null )

say "composing the profile"
DSH_HOME="$TMP/home" dsh verify --dump-config 2>/dev/null | grep -q -- "- id: dsh-catpaw" \
  || { echo "the bundle row is missing from the composed profile" >&2; exit 1; }
echo "bundle row present"

if [ "$OFFLINE" = "1" ]; then
  say "offline mode: skipping the model call"
  exit 0
fi

say "answering one prompt through the installed bundle"
OUT="$(DSH_HOME="$TMP/home" dsh verify "只回复两个字：你好" 2>/dev/null | tail -1)"
[ "$OUT" = "你好" ] || { echo "unexpected answer: $OUT" >&2; exit 1; }
echo "answer: $OUT"

say "asking the installed copy for its own health report"
REPORT="$(DSH_HOME="$TMP/home" dsh verify "调用 catpaw_doctor 工具，把 report 里的第一行原样贴出来" 2>/dev/null | tail -3)"
echo "$REPORT" | grep -q "catpaw-cli:" || { echo "catpaw_doctor did not answer: $REPORT" >&2; exit 1; }
echo "$REPORT" | grep "catpaw-cli:" | head -1

say "checking the vendored CLI survived packing"
CLI="$PROFILE/node_modules/dsh-catpaw/bin/catpaw-cli"
[ -f "$CLI" ] || { echo "the tarball does not carry bin/catpaw-cli" >&2; exit 1; }
[ -x "$CLI" ] || { echo "bin/catpaw-cli lost its executable bit through npm pack" >&2; exit 1; }
echo "vendored CLI present and executable"

say "ok"
