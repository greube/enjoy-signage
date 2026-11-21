# Source this to run the Windows code paths on Linux/macOS with stand-in Windows commands:
#   source test/stand-ins/windows/env.sh      (fake profile: $WIN_HOME, default test/.work/win-home)
# Then e.g.  node install-windows.js --no-open   ·   node "$LOCALAPPDATA/ENJOY Signage/app/platform/windows/enjoy.js" stop
# Every stand-in command is logged to $WINLOG. NET_ADMIN=1 makes "net session" succeed (= running as administrator).
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WIN_HOME="${WIN_HOME:-$(cd "$_here/../.." && pwd)/.work/win-home}"
mkdir -p "$WIN_HOME/AppData/Roaming" "$WIN_HOME/AppData/Local" "$WIN_HOME/Desktop"
export ENJOY_SIGNAGE_TEST_WIN=1
export USERPROFILE="$WIN_HOME" APPDATA="$WIN_HOME/AppData/Roaming" LOCALAPPDATA="$WIN_HOME/AppData/Local"
export WINLOG="$WIN_HOME/stand-ins.log" WINREG="$WIN_HOME/registry.json"
case ":$PATH:" in *":$_here:"*) ;; *) export PATH="$_here:$PATH" ;; esac
unset _here
