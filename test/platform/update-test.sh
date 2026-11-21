#!/usr/bin/env bash
# The updater against a pretend GitHub (test/mocks/github.js), on the Windows or Mac version with stand-ins.
# Each scenario serves a newer version than the last. About 3 minutes.
#   bash test/platform/update-test.sh [windows|mac]
set -u
. "$(dirname "$0")/lib.sh"
PLAT=${1:-windows}; PORT=3914; GH=4501
cur=$(node -p "require('$REPO/package.json').version"); major=${cur%.*}; patch=${cur##*.}
if [ "$PLAT" = mac ]; then
  [ -f "$REPO/test/.work/mac-home/launchd.json" ] && bash "$REPO/test/stand-ins/mac/stop-all.sh"
  rm -rf "$REPO/test/.work/mac-home"; . "$REPO/test/stand-ins/mac/env.sh"
  APP="$HOME/Library/Application Support/ENJOY Signage/app"
  (cd "$REPO" && node install-mac.js --no-open --no-dock --port $PORT) >/dev/null
else
  rm -rf "$REPO/test/.work/win-home"; . "$REPO/test/stand-ins/windows/env.sh"
  APP="$LOCALAPPDATA/ENJOY Signage/app"
  (cd "$REPO" && node install-windows.js --no-open --port $PORT) >/dev/null
fi
ENJOY="$APP/platform/$PLAT/enjoy.js"
export ENJOY_SIGNAGE_UPDATE_API=http://127.0.0.1:$GH ENJOY_SIGNAGE_UPDATE_RAW=http://127.0.0.1:$GH/raw ENJOY_SIGNAGE_UPDATE_CODELOAD=http://127.0.0.1:$GH/codeload
installed() { node -p "require('$APP/package.json').version"; }
wait_for answers 40 $PORT || echo "  (server didn't start after installing)"
n=0
scenario() { # "description" expect(new|old) [ENV=...] -- [update args]
  local what=$1 expect=$2; shift 2; local envs=(); while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  n=$((n+1)); local v="$major.$((patch+n))" before; before=$(installed)
  echo; echo "== $n. $what (GitHub has $v, installed $before)"
  env "${envs[@]}" node "$REPO/test/mocks/github.js" $GH "$v" > "$REPO/test/.work/github-$n.log" 2>&1 & local gh=$!
  sleep 1.5
  (cd /tmp && node "$ENJOY" update --yes "$@" 2>&1) | sed 's/^/    /'
  kill $gh 2>/dev/null; wait $gh 2>/dev/null
  sed 's/^/    github: /' "$REPO/test/.work/github-$n.log" | grep -v 'mock GitHub on'
  if [ "$expect" = new ]; then check "now on $v" test "$(installed)" = "$v"; else check "still on $before" test "$(installed)" = "$before"; fi
  check "server running" wait_for answers 40 $PORT
}
scenario "normal update" new --
scenario "GitHub answers 504 twice, then works" new FAIL_VERSION=2 FAIL_API_TARBALL=2 --
scenario "the API download keeps failing: falls back to codeload" new FAIL_API_TARBALL=all --
scenario "download cut off halfway: tries again" new CUT=1 --
scenario "private repo without a token: explains, changes nothing" old PRIVATE=1 --
scenario "private repo with --token" new PRIVATE=1 -- --token ghp_TESTTOKEN0123456789abcdef
scenario "GitHub down completely: gives up politely, changes nothing" old FAIL_ALL=1 --
scenario "the new version is broken: puts the old one back" old BROKEN=1 --
scenario "--check only reports" old -- --check
[ "$PLAT" = mac ] && launchctl reset
[ "$PLAT" = windows ] && node "$ENJOY" stop >/dev/null
summary
