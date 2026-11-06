#!/usr/bin/env bash
# ENJOY Signage: installer / updater for Ubuntu (22.04, 24.04, 26.04; desktop or server).
#
#   sudo bash install-ubuntu.sh                 # first install (asks for the built-in admin's password)
#   sudo bash install-ubuntu.sh                 # run again from a newer copy to update (keeps your data and settings)
#
# Options:
#   --port N            web port (default 3000; first install only, later use: church-signage port N)
#   --password X        password for the built-in "admin" account (first install only; later: church-signage password)
#   --timezone Area/City   set the computer's time zone, e.g. Australia/Sydney (schedules use it)
#   --no-firewall       don't open the port in ufw
#   --distro-node       use Ubuntu's own Node.js package even if it is old (must be 18+)
#
# What it sets up:
#   /opt/church-signage                    the program (replaced on every update)
#   /var/lib/church-signage                your data: db.json, uploads/, spotify.json (never touched by updates)
#   /etc/church-signage/                   church-signage.env (port) and admin-password
#   church-signage.service                 systemd service: starts at boot, restarts if it crashes
#   /usr/local/bin/church-signage          helper command: status, logs, password, backup …

set -euo pipefail

APP_DIR=/opt/church-signage
DATA_DIR=/var/lib/church-signage
CONF_DIR=/etc/church-signage
ENV_FILE=$CONF_DIR/church-signage.env   # port etc. (readable by everyone)
PW_FILE=$CONF_DIR/admin-password        # just the admin password (root and the service only)
UNIT=/etc/systemd/system/church-signage.service
SVC_USER=church-signage
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT_ARG="" PASSWORD_ARG="" TZ_ARG="" FIREWALL=1 DISTRO_NODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT_ARG="${2:-}"; shift 2 ;;
    --password) PASSWORD_ARG="${2:-}"; shift 2 ;;
    --timezone) TZ_ARG="${2:-}"; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    --distro-node) DISTRO_NODE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 1 ;;
  esac
done

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo:  sudo bash $0"
command -v apt-get >/dev/null || die "This installer is for Ubuntu (apt was not found)."
command -v systemctl >/dev/null || die "systemd was not found; this installer needs a normal Ubuntu install."
[ -f "$SRC/server/server.js" ] && [ -f "$SRC/server/accounts.js" ] && [ -d "$SRC/public" ] || die "Run this from inside the extracted enjoy-signage folder."
if [ -n "$PORT_ARG" ] && ! [[ "$PORT_ARG" =~ ^[0-9]+$ && "$PORT_ARG" -ge 1 && "$PORT_ARG" -le 65535 ]]; then die "--port must be a number from 1 to 65535"; fi

UPDATE=0
[ -f "$ENV_FILE" ] && UPDATE=1
bold "ENJOY Signage: $([ $UPDATE = 1 ] && echo 'updating' || echo 'installing') on $(. /etc/os-release && echo "$PRETTY_NAME")"

# ---------------------------------------------------------------- Node.js
bold "1. Node.js"
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -ge 18 ]; then
  ok "Node.js $(node -v) is already installed"
else
  apt-get update -qq
  cand=$(apt-cache policy nodejs | awk '/Candidate:/ {print $2}' | sed -E 's/^[0-9]+://; s/[^0-9].*//')
  cand=${cand:-0}
  if [ "$cand" -ge 20 ] || { [ "$DISTRO_NODE" = 1 ] && [ "$cand" -ge 18 ]; }; then
    echo "  Installing Node.js $cand from Ubuntu…"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  else
    echo "  Ubuntu's own Node.js is too old ($cand). Adding NodeSource's Node.js 24 LTS…"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  fi
  [ "$(node_major)" -ge 18 ] || die "Node.js 18 or newer could not be installed. Install it yourself and run this again."
  ok "Node.js $(node -v) installed"
fi
NODE_BIN="$(command -v node)"

# ---------------------------------------------------------------- user and folders
bold "2. Service account and folders"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  ok "Created system user '$SVC_USER'"
else
  ok "System user '$SVC_USER' exists"
fi
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR/uploads"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR/folders"
install -d -m 755 "$CONF_DIR"

# Bringing data over from another computer (e.g. the Windows install): put its "data" folder next to this script.
if [ -f "$SRC/data/db.json" ] && [ "$SRC/data" != "$DATA_DIR" ]; then
  if [ -f "$DATA_DIR/db.json" ]; then
    warn "Found a 'data' folder next to the installer, but $DATA_DIR already has data, so it was NOT copied."
    warn "To replace the current data with it: sudo church-signage restore-folder \"$SRC/data\""
  else
    cp -a "$SRC/data/." "$DATA_DIR/"
    chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
    ok "Copied your existing data ($(ls "$DATA_DIR/uploads" | wc -l) uploaded files) into $DATA_DIR"
  fi
fi
ok "Data lives in $DATA_DIR"

# ---------------------------------------------------------------- program files
bold "3. Program files"
STAGE="$(mktemp -d /opt/.church-signage.XXXXXX)"
cp -a "$SRC/server" "$SRC/public" "$SRC/docs" "$SRC/package.json" "$SRC/README.md" "$STAGE/"
# The installer and updater go along too, so the installed copy can reinstall itself if an update has to be undone.
cp -a "$SRC/install-ubuntu.sh" "$STAGE/"
mkdir -p "$STAGE/platform" && cp -a "$SRC/platform/ubuntu" "$SRC/platform/update.js" "$STAGE/platform/"
chown -R root:root "$STAGE"
chmod -R u=rwX,go=rX "$STAGE"
rm -rf "$APP_DIR.old"
if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$STAGE" "$APP_DIR"
rm -rf "$APP_DIR.old"
install -m 755 "$SRC/platform/ubuntu/church-signage-ctl.sh" /usr/local/bin/church-signage
ok "Installed version $(node -p "require('$APP_DIR/package.json').version") to $APP_DIR"
ok "Installed the 'church-signage' helper command"

# ---------------------------------------------------------------- settings
bold "4. Settings"
write_env() { # port password
  cat > "$ENV_FILE.tmp" <<EOF
# ENJOY Signage settings. Change the port with: sudo church-signage port N
PORT=$1
# Largest single upload, in MB:
MAX_UPLOAD_MB=4096
EOF
  chmod 644 "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"
  ( umask 077; printf '%s' "$2" > "$PW_FILE.tmp" )
  chown root:"$SVC_USER" "$PW_FILE.tmp"; chmod 640 "$PW_FILE.tmp"; mv "$PW_FILE.tmp" "$PW_FILE"
}
GENERATED=""
if [ $UPDATE = 1 ]; then
  ok "Keeping your existing settings in $CONF_DIR"
  if [ -n "$PORT_ARG$PASSWORD_ARG" ]; then warn "--port/--password are ignored on update. Use: sudo church-signage port N / sudo church-signage password"; fi
else
  PORT=${PORT_ARG:-3000}
  PW=$PASSWORD_ARG
  if [ -z "$PW" ] && [ -t 0 ]; then
    echo "  Choose a password for the built-in 'admin' account (your first administrator and recovery login)."
    while :; do
      read -rsp "  Admin password (leave blank to generate one): " PW; echo
      [ -z "$PW" ] && break
      read -rsp "  Type it again: " PW2; echo
      [ "$PW" = "$PW2" ] && break
      warn "They didn't match, try again."
    done
  fi
  if [ -z "$PW" ]; then PW="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")"; GENERATED=1; fi
  if [[ "$PW" == *$'\n'* ]]; then die "The password can't contain line breaks"; fi
  write_env "$PORT" "$PW"
  ok "Saved port $PORT to $ENV_FILE and the admin password to $PW_FILE"
fi
PORT=$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1); PORT=${PORT:-3000}

# ---------------------------------------------------------------- systemd
bold "5. Background service"
cat > "$UNIT" <<EOF
[Unit]
Description=ENJOY Signage server
Documentation=file://$APP_DIR/docs/INSTALL-UBUNTU.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
Environment=DATA_DIR=$DATA_DIR
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
Environment=ADMIN_PASSWORD_FILE=$PW_FILE
ExecStart=$NODE_BIN $APP_DIR/server/server.js
Restart=always
RestartSec=3
# Allow ports below 1024 (e.g. 80) without running as root:
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# Lock it down: it can only write to its data folder.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable church-signage >/dev/null 2>&1
systemctl restart church-signage
ok "church-signage.service is enabled (starts at boot) and running"

# ---------------------------------------------------------------- firewall
if [ "$FIREWALL" = 1 ] && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow "$PORT/tcp" comment 'ENJOY Signage' >/dev/null
  ok "Opened port $PORT in the ufw firewall"
fi

# ---------------------------------------------------------------- time zone
bold "6. Clock"
if [ -n "$TZ_ARG" ]; then
  timedatectl set-timezone "$TZ_ARG" || die "Unknown time zone '$TZ_ARG' (list them with: timedatectl list-timezones)"
  systemctl restart church-signage
fi
TZ_NOW="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
ok "Time zone: $TZ_NOW · now $(date '+%a %d %b %H:%M')"
if [ "$TZ_NOW" = "Etc/UTC" ] || [ "$TZ_NOW" = "UTC" ]; then
  warn "This computer is on UTC. Schedules and countdowns use this clock, so set your local zone, e.g.:"
  warn "  sudo timedatectl set-timezone Australia/Sydney && sudo systemctl restart church-signage"
fi

# ---------------------------------------------------------------- check it answers
ready=0
for _ in $(seq 1 20); do
  if "$NODE_BIN" -e "fetch('http://127.0.0.1:$PORT/api/player-list').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  sleep 0.5
done

IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' || true)
FIRST_IP=$(echo "$IPS" | head -1)
bold "$([ $ready = 1 ] && echo '✅ ENJOY Signage is running' || echo '⚠ Installed, but the server did not answer yet')"
[ $ready = 1 ] || echo "  See what went wrong with:  sudo church-signage logs"
echo
echo "  Admin panel:  $(for ip in $IPS; do printf 'http://%s:%s/   ' "$ip" "$PORT"; done)"
echo "  TVs open:     http://${FIRST_IP:-SERVER-IP}:$PORT/player"
echo "  Sign in as \"admin\" with the password you chose, then add people under Users."
if [ -n "$GENERATED" ]; then
  echo
  echo "  Sign in as:  admin   Password (generated, write it down):  $PW"
  echo "  Change it any time with:  sudo church-signage password"
fi
echo
echo "  Useful commands:  church-signage status | sudo church-signage logs | sudo church-signage backup"
echo "  Instructions:     $APP_DIR/docs/INSTALL-UBUNTU.md"
echo
