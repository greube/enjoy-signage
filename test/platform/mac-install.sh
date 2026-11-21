#!/usr/bin/env bash
# Installs, runs, restarts, stops and uninstalls the Mac version on Linux, with a stand-in launchd that really
# runs the LaunchAgent, into a throwaway home folder (test/.work/mac-home). About 40 seconds.
#   bash test/platform/mac-install.sh [PORT=3912]
set -u
. "$(dirname "$0")/lib.sh"
PORT=${1:-3912}
[ -f "$REPO/test/.work/mac-home/launchd.json" ] && bash "$REPO/test/stand-ins/mac/stop-all.sh"
rm -rf "$REPO/test/.work/mac-home"
. "$REPO/test/stand-ins/mac/env.sh"
HOME_DIR="$HOME/Library/Application Support/ENJOY Signage"; ENJOY="$HOME_DIR/app/platform/mac/enjoy.js"
echo "Install (fake home in $MAC_HOME)"
(cd "$REPO" && node install-mac.js --no-open --dock --port "$PORT") | sed 's/^/    /'
check "program copied" test -f "$HOME_DIR/app/server/server.js"
check "no test tools copied" test ! -e "$HOME_DIR/app/test"
check "app made in Applications" test -d "$HOME/Applications/ENJOY Signage.app"
check "LaunchAgent written" test -f "$HOME/Library/LaunchAgents/org.enjoychurch.signage.plist"
check "keeps the Mac awake (caffeinate in the agent)" grep -q caffeinate "$HOME/Library/LaunchAgents/org.enjoychurch.signage.plist"
check "added to the Dock" test -s "$HOME/dock.txt"
check "server answers on $PORT" wait_for answers 40 "$PORT"
echo "Restart"
node "$ENJOY" restart | sed 's/^/    /'
check "server answers after restart" wait_for answers 40 "$PORT"
echo "Server crash (launchd's KeepAlive should bring it back)"
crash "$HOME_DIR/app/server/server.js"
sleep 1; check "server answers again by itself" wait_for answers 40 "$PORT"
echo "Stop"
node "$ENJOY" stop | sed 's/^/    /'
check "server stopped" wait_for silent 20 "$PORT"
echo "Open (the app icon)"
node "$ENJOY" open
check "server started by the app" wait_for answers 40 "$PORT"
check "browser opened at the admin panel (or first-run setup)" grep -q "127.0.0.1:$PORT" "$MAC_HOME/last-opened-url.txt"
echo "Uninstall"
node "$ENJOY" uninstall --yes | sed 's/^/    /'
check "server stopped" wait_for silent 20 "$PORT"
check "program removed" test ! -e "$HOME_DIR/app"
check "LaunchAgent removed" test ! -e "$HOME/Library/LaunchAgents/org.enjoychurch.signage.plist"
check "content kept" test -d "$HOME_DIR/data/uploads"
launchctl reset
echo "  (stand-in command log: $MACLOG)"
summary
