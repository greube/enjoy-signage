#!/usr/bin/env bash
# Runs install-ubuntu.sh for real, as root, with stand-ins for systemd, ufw and timedatectl. ONLY in a throwaway
# container or VM: it writes /opt/church-signage, /etc/church-signage, /var/lib/church-signage, /usr/local/bin.
# About 30 seconds.   sudo bash test/platform/ubuntu-install.sh [PORT=3913]
set -u
. "$(dirname "$0")/lib.sh"
PORT=${1:-3913}
[ "$(id -u)" = 0 ] || { echo "Run as root (in a throwaway container or VM)."; exit 1; }
[ -d /run/systemd/system ] && { echo "This machine has real systemd: use a throwaway container instead."; exit 1; }
. "$REPO/test/stand-ins/ubuntu/env.sh"
bash "$REPO/test/stand-ins/ubuntu/stop-all.sh"
echo "Install"
(cd "$REPO" && bash install-ubuntu.sh --port "$PORT" --password a-good-password-1 --timezone Australia/Sydney) | sed 's/^/    /'
check "program copied" test -f /opt/church-signage/server/server.js
check "no test tools copied" test ! -e /opt/church-signage/test
check "church-signage command" test -x /usr/local/bin/church-signage
check "service enabled" systemctl is-enabled church-signage
check "server answers on $PORT" wait_for answers 40 "$PORT"
check "runs as the church-signage user" bash -c "ps -eo user:20=,comm=,args= | awk '\$2==\"node\" && /church-signage\/server\/server.js/ {print \$1}' | grep -qx church-signage"
check "port opened in ufw" grep -q "$PORT/tcp" /run/systemd-stand-in/ufw-rules.txt
check "time zone set" grep -q Australia/Sydney /etc/timezone
echo "church-signage status / restart / port"
church-signage status | sed 's/^/    /'
church-signage restart >/dev/null; check "answers after restart" wait_for answers 40 "$PORT"
NEW=$((PORT+1)); church-signage port "$NEW" >/dev/null
check "moved to port $NEW" wait_for answers 40 "$NEW"
church-signage port "$PORT" >/dev/null; wait_for answers 40 "$PORT"
echo "Server crash (Restart=always should bring it back)"
crash /opt/church-signage/server/server.js; sleep 1
check "answers again by itself" wait_for answers 40 "$PORT"
echo "Reinstall over the top (as an update does)"
(cd "$REPO" && bash install-ubuntu.sh) >/dev/null
check "still answers, same port" wait_for answers 40 "$PORT"
echo "  (stand-in command log: $UBULOG; server output: /var/log/stand-in-church-signage.log)"
echo "  Remove with:  church-signage uninstall   (then bash test/stand-ins/ubuntu/stop-all.sh)"
summary
