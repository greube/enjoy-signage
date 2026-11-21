# Shared by the platform scripts.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0; FAILS=0
check() { # check "description" command...
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then printf '  \033[32m✓\033[0m %s\n' "$what"; PASS=$((PASS+1)); else printf '  \033[31m✗ %s\033[0m\n' "$what"; FAILS=$((FAILS+1)); fi
}
answers() { node -e "fetch('http://127.0.0.1:$1/api/player-list').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
silent() { ! answers "$1"; }
wait_for() { for _ in $(seq 1 "${2:-40}"); do "$1" "$3" && return 0; sleep 0.5; done; return 1; }
summary() { echo; if [ "$FAILS" = 0 ]; then printf '\033[32mAll %s checks passed.\033[0m\n' "$PASS"; else printf '\033[31m%s of %s checks failed.\033[0m\n' "$FAILS" "$((PASS+FAILS))"; exit 1; fi; }
# Kills the node server process itself (not a shell loop around it whose command line also names server.js).
crash() { for p in $(pgrep -f "$1"); do [ "$(ps -o comm= -p "$p")" = node ] && kill -9 "$p"; done; true; }
