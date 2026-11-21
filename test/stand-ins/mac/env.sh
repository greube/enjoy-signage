# Source this to run the macOS code paths on Linux with stand-in macOS commands:
#   source test/stand-ins/mac/env.sh      (fake home: $MAC_HOME, default test/.work/mac-home)
# Then e.g.  node install-mac.js --no-open   ·   node "$HOME/Library/Application Support/ENJOY Signage/app/platform/mac/enjoy.js" status
# launchctl really runs the LaunchAgent's program (without caffeinate) and restarts it if it stops, like KeepAlive.
# Every stand-in command is logged to $MACLOG; launchd's state is in $MACSTATE.
# Run  launchctl reset  (or  bash test/stand-ins/mac/stop-all.sh)  afterwards to stop anything it started.
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MAC_HOME="${MAC_HOME:-$(cd "$_here/../.." && pwd)/.work/mac-home}"
mkdir -p "$MAC_HOME/Library/LaunchAgents" "$MAC_HOME/Applications"
export ENJOY_SIGNAGE_TEST_MAC=1 HOME="$MAC_HOME"
export MACLOG="$MAC_HOME/stand-ins.log" MACSTATE="$MAC_HOME/launchd.json"
case ":$PATH:" in *":$_here:"*) ;; *) export PATH="$_here:$PATH" ;; esac
unset _here
