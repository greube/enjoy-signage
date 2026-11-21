# Source this (as root, in a throwaway container or VM: the installer writes to /opt, /etc and /var/lib)
# to run install-ubuntu.sh and the church-signage command where there's no systemd:
#   sudo -s; source test/stand-ins/ubuntu/env.sh; bash install-ubuntu.sh --password a-good-password-1
# systemctl really runs the unit's ExecStart as its User (restarting it like Restart=always), and journalctl
# shows its output. ufw reports "active" (UFW_ACTIVE=0 for inactive). Calls are logged to $UBULOG.
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export UBULOG="${UBULOG:-/var/log/stand-ins.log}" STANDIN_RUN=/run/systemd-stand-in
case ":$PATH:" in *":$_here:"*) ;; *) export PATH="$_here:$PATH" ;; esac
unset _here
