#!/usr/bin/env bash
# church-signage: everyday commands for the ENJOY Signage server on Ubuntu.
# Installed to /usr/local/bin/church-signage by install-ubuntu.sh.

set -euo pipefail

APP_DIR=/opt/church-signage
DATA_DIR=/var/lib/church-signage
CONF_DIR=/etc/church-signage
ENV_FILE=$CONF_DIR/church-signage.env
PW_FILE=$CONF_DIR/admin-password
UNIT=/etc/systemd/system/church-signage.service
SVC=church-signage
SVC_USER=church-signage

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "This needs sudo:  sudo church-signage $*"; }
port() { local p; p=$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -1); echo "${p:-3000}"; }
password_set() { [ -s "$PW_FILE" ]; }

set_var() { # NAME VALUE: rewrite one setting in the env file
  local name=$1 val=$2 tmp
  tmp=$(mktemp "$CONF_DIR/.env.XXXXXX")
  grep -v "^$name=" "$ENV_FILE" > "$tmp" || true
  echo "$name=$val" >> "$tmp"
  chmod 644 "$tmp"; mv "$tmp" "$ENV_FILE"
}

urls() {
  local p ips; p=$(port)
  ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' || true)
  echo "  Admin panel:  $(for ip in $ips; do printf 'http://%s:%s/   ' "$ip" "$p"; done)"
  echo "  TVs open:     http://$(echo "$ips" | head -1):$p/player"
}

swap_in_data() { # SOURCE_DIR: replace the live data with a copy of SOURCE_DIR (keeps the old one)
  local src=$1 keep
  [ -f "$src/db.json" ] || die "$src does not contain a db.json, so it isn't a ENJOY Signage data folder."
  keep="$DATA_DIR.before-restore-$(date +%Y%m%d-%H%M%S)"
  systemctl stop "$SVC"
  cp -a "$DATA_DIR" "$keep"
  find "$DATA_DIR" -mindepth 1 -delete
  cp -a "$src/." "$DATA_DIR/"
  mkdir -p "$DATA_DIR/uploads"
  chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
  systemctl start "$SVC"
  ok "Restored. The previous data was kept in $keep (delete it once you're happy)."
}

cmd=${1:-help}
shift || true
case "$cmd" in
  status)
    v=$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo '?')
    if systemctl is-active --quiet "$SVC"; then st=$'\033[32mrunning\033[0m'; else st=$'\033[31mstopped\033[0m'; fi
    echo
    echo "  ENJOY Signage $v is $st (starts at boot: $(systemctl is-enabled "$SVC" 2>/dev/null || true))"
    urls
    echo "  Data:         $DATA_DIR ($(sudo -n du -sh "$DATA_DIR" 2>/dev/null | cut -f1 || echo '?'))"
    echo "  Time zone:    $(timedatectl show -p Timezone --value 2>/dev/null || echo '?') · now $(date '+%a %d %b %H:%M')"
    if [ -r "$PW_FILE" ]; then
      if password_set; then echo "  Built-in admin login: on"; else warn "Built-in admin login is off (sudo church-signage password to turn it on)"; fi
    fi
    echo
    ;;
  urls) urls ;;
  logs)
    need_root logs
    journalctl -u "$SVC" -n 100 -f --no-hostname -o short-iso
    ;;
  start|stop|restart)
    need_root "$cmd"
    systemctl "$cmd" "$SVC"
    ok "ENJOY Signage: $cmd done"
    ;;
  password)
    need_root password
    pw=${1:-}
    if [ -z "$pw" ]; then
      read -rsp "New password for the built-in admin account (blank = turn that login off): " pw; echo
      if [ -n "$pw" ]; then read -rsp "Type it again: " pw2; echo; [ "$pw" = "$pw2" ] || die "They didn't match."; fi
    fi
    if [[ "$pw" == *$'\n'* ]]; then die "The password can't contain line breaks"; fi
    ( umask 077; printf '%s' "$pw" > "$PW_FILE.tmp" )
    chown root:"$SVC_USER" "$PW_FILE.tmp"; chmod 640 "$PW_FILE.tmp"; mv "$PW_FILE.tmp" "$PW_FILE"
    systemctl restart "$SVC"
    if [ -n "$pw" ]; then ok "Built-in admin password changed (sign in as: admin)"; else warn "Built-in admin login turned off. Make sure another administrator account exists (Users page)."; fi
    ;;
  port)
    need_root port
    new=${1:-}
    [[ "$new" =~ ^[0-9]+$ && "$new" -ge 1 && "$new" -le 65535 ]] || die "Usage: sudo church-signage port 3000"
    old=$(port)
    set_var PORT "$new"
    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
      ufw allow "$new/tcp" comment 'ENJOY Signage' >/dev/null
      ufw delete allow "$old/tcp" >/dev/null 2>&1 || true
    fi
    systemctl restart "$SVC"
    ok "Port changed from $old to $new"
    warn "Update each TV's player link to the new port."
    warn "If Spotify is connected, add http://127.0.0.1:$new/spotify/callback as a Redirect URI in your Spotify app."
    urls
    ;;
  backup)
    need_root backup
    dir=${1:-.}
    [ -d "$dir" ] || die "Folder $dir does not exist"
    file="$(cd "$dir" && pwd)/church-signage-backup-$(date +%Y-%m-%d-%H%M).tar.gz"
    tar -czf "$file" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
    [ -n "${SUDO_USER:-}" ] && chown "$SUDO_USER:" "$file" || true
    ok "Backed up everything (screens, playlists, schedules, uploads, Spotify link) to:"
    echo "    $file ($(du -h "$file" | cut -f1))"
    ;;
  restore)
    need_root restore
    file=${1:-}
    [ -f "$file" ] || die "Usage: sudo church-signage restore church-signage-backup-….tar.gz"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    tar -xzf "$file" -C "$tmp"
    src=$(dirname "$(find "$tmp" -maxdepth 3 -name db.json -print -quit)")
    [ -n "$src" ] && [ "$src" != "." ] || die "No db.json found inside $file"
    swap_in_data "$src"
    ;;
  restore-folder)
    need_root restore-folder
    [ -d "${1:-}" ] || die "Usage: sudo church-signage restore-folder /path/to/data   (e.g. the data folder copied from Windows)"
    swap_in_data "$(cd "$1" && pwd)"
    ;;
  share-folders)
    need_root share-folders
    # Share the drop folders on the network (SMB), so staff can drag files in from Windows or Mac.
    root=$(node -e "try{const d=require('$DATA_DIR/db.json');process.stdout.write((d.settings&&d.settings.foldersDir)||'')}catch{}" 2>/dev/null || true)
    root=${root:-$DATA_DIR/folders}
    [ -d "$root" ] || install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$root"
    if ! command -v smbd >/dev/null; then
      echo "  Installing Samba (Windows file sharing)…"
      apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null
    fi
    id signage >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$SVC_USER" signage
    pw=${1:-}
    if [ -z "$pw" ]; then
      read -rsp "Choose a password for the shared folder (username will be 'signage'): " pw; echo
      read -rsp "Type it again: " pw2; echo
      [ "$pw" = "$pw2" ] || die "They didn't match."
    fi
    [ -n "$pw" ] || die "The shared folder needs a password."
    printf '%s\n%s\n' "$pw" "$pw" | smbpasswd -s -a signage >/dev/null
    smbpasswd -e signage >/dev/null
    conf=/etc/samba/smb.conf
    cp "$conf" "$conf.bak-signage" 2>/dev/null || true
    sed -i '/^# BEGIN church-signage/,/^# END church-signage/d' "$conf"
    cat >> "$conf" <<EOF
# BEGIN church-signage (managed by: church-signage share-folders)
[signage]
   comment = ENJOY Signage drop folders
   path = $root
   browseable = yes
   read only = no
   valid users = signage
   force user = $SVC_USER
   force group = $SVC_USER
   create mask = 0640
   directory mask = 0750
   veto files = /._*/.DS_Store/
   delete veto files = yes
# END church-signage
EOF
    testparm -s "$conf" >/dev/null 2>&1 || { cp "$conf.bak-signage" "$conf"; die "Samba didn't accept the settings; nothing was changed."; }
    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then ufw allow samba >/dev/null; fi
    systemctl restart smbd 2>/dev/null || systemctl restart samba 2>/dev/null || true
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    ok "Drop folders are shared on the network:"
    echo "    Windows:  \\\\${ip}\\signage      (File Explorer address bar)"
    echo "    Mac:      smb://${ip}/signage      (Finder → Go → Connect to Server)"
    echo "    Username: signage   Password: the one you just chose"
    echo "    Tip: in Windows, right-click the share → Map network drive, so it's always in File Explorer."
    ;;
  unshare-folders)
    need_root unshare-folders
    sed -i '/^# BEGIN church-signage/,/^# END church-signage/d' /etc/samba/smb.conf 2>/dev/null || true
    systemctl restart smbd 2>/dev/null || true
    ok "The drop folders are no longer shared on the network (the files are untouched)."
    ;;
  update)
    need_root update
    exec node "$APP_DIR/platform/update.js" ubuntu "$@"
    ;;
  version)
    node -p "require('$APP_DIR/package.json').version"
    ;;
  uninstall)
    need_root uninstall
    purge=0; [ "${1:-}" = "--purge" ] && purge=1
    systemctl disable --now "$SVC" >/dev/null 2>&1 || true
    rm -f "$UNIT"; systemctl daemon-reload
    rm -rf "$APP_DIR" "$APP_DIR.previous"
    rm -f /usr/local/bin/church-signage
    if [ $purge = 1 ]; then
      rm -rf "$DATA_DIR" "$CONF_DIR"
      userdel "$SVC_USER" 2>/dev/null || true
      ok "ENJOY Signage and ALL its data were removed."
    else
      ok "ENJOY Signage was removed. Your data is still in $DATA_DIR and settings in $CONF_DIR;"
      echo "    reinstalling picks them up again. To delete them too:"
      echo "    sudo rm -rf $DATA_DIR $CONF_DIR && sudo userdel $SVC_USER"
    fi
    ;;
  help|-h|--help|*)
    cat <<'EOF'

church-signage: manage the ENJOY Signage server

  church-signage status              Is it running? Addresses, time zone, data size
  church-signage urls                Show the admin and TV addresses
  sudo church-signage logs           Live log (Ctrl+C to stop watching)
  sudo church-signage restart        Restart the server (also: start, stop)
  sudo church-signage password       Set the built-in "admin" (recovery) password
  sudo church-signage port 8080      Change the web port
  sudo church-signage backup [folder]        Save everything to a .tar.gz
  sudo church-signage restore FILE.tar.gz    Put a backup back (keeps a copy of the current data)
  sudo church-signage restore-folder DIR     Use a data folder copied from another computer (e.g. Windows)
  sudo church-signage share-folders          Share the drop folders on the network (\\SERVER\signage)
  sudo church-signage unshare-folders        Stop sharing them
  sudo church-signage update [--check]       Install the newest version from GitHub
  sudo church-signage uninstall [--purge]    Remove it (--purge also deletes all data)

  To update from a download instead: extract it and run  sudo bash install-ubuntu.sh  from it.

EOF
    ;;
esac
