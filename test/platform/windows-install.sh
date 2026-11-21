#!/usr/bin/env bash
# Installs, runs, restarts, stops and uninstalls the Windows version on Linux, with stand-in Windows commands,
# into a throwaway user profile (test/.work/win-home). About 30 seconds.
#   bash test/platform/windows-install.sh [PORT=3911]
set -u
. "$(dirname "$0")/lib.sh"
PORT=${1:-3911}
rm -rf "$REPO/test/.work/win-home"
. "$REPO/test/stand-ins/windows/env.sh"
HOME_DIR="$LOCALAPPDATA/ENJOY Signage"; ENJOY="$HOME_DIR/app/platform/windows/enjoy.js"
MENU="$APPDATA/Microsoft/Windows/Start Menu/Programs"
echo "Install (fake profile in $WIN_HOME)"
(cd "$REPO" && node install-windows.js --no-open --port "$PORT") | sed 's/^/    /'
check "program copied" test -f "$HOME_DIR/app/server/server.js"
check "no test tools copied" test ! -e "$HOME_DIR/app/test"
check "desktop icon" test -f "$WIN_HOME/Desktop/ENJOY Signage.lnk"
check "Start menu: 6 entries" test "$(ls "$MENU/ENJOY Signage" | wc -l)" -ge 6
check "start at sign-in" test -f "$MENU/Startup/ENJOY Signage server.lnk"
check "Apps-list (uninstall) entry in the registry" grep -q 'UNINSTALL' "$WINREG"
check "server answers on $PORT" wait_for answers 40 "$PORT"
echo "Restart"
node "$ENJOY" restart | sed 's/^/    /'
check "server answers after restart" wait_for answers 40 "$PORT"
echo "Server crash (the supervisor should bring it back)"
crash "$HOME_DIR/app/server/server.js"
sleep 1; check "server answers again by itself" wait_for answers 40 "$PORT"
echo "Stop"
node "$ENJOY" stop | sed 's/^/    /'
check "server stopped" wait_for silent 20 "$PORT"
echo "Open (the desktop icon)"
node "$ENJOY" open
check "server started by the icon" wait_for answers 40 "$PORT"
check "browser opened at the admin panel (or first-run setup)" grep -q "127.0.0.1:$PORT" "$WIN_HOME/last-opened-url.txt"
echo "Uninstall"
node "$ENJOY" uninstall --yes | sed 's/^/    /'
check "server stopped" wait_for silent 20 "$PORT"
check "program removed" test ! -e "$HOME_DIR/app"
check "desktop icon removed" test ! -e "$WIN_HOME/Desktop/ENJOY Signage.lnk"
check "content kept" test -d "$HOME_DIR/data/uploads"
echo "  (stand-in command log: $WINLOG)"
summary
