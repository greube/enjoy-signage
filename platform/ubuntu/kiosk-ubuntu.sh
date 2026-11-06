#!/usr/bin/env bash
# ENJOY Signage: turn an Ubuntu desktop PC into a TV player (full-screen kiosk that starts by itself).
# Run it as the normal desktop user on the PC connected to the TV, not with sudo:
#
#   bash kiosk-ubuntu.sh http://192.168.1.20:3000/player/SCREEN-ID
#   bash kiosk-ubuntu.sh http://192.168.1.20:3000/player --autologin     # also log in automatically at power-on
#   bash kiosk-ubuntu.sh --remove                                         # undo
#
# Tip: copy the screen's own link from the admin panel (Screens → Copy) so the TV never shows the picker.
# Works with Ubuntu Desktop (GNOME) 22.04, 24.04 and 26.04. Uses Google Chrome if installed, otherwise Chromium.

set -euo pipefail

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

AUTOSTART="$HOME/.config/autostart/church-signage-player.desktop"
LAUNCHER="$HOME/.local/bin/church-signage-player"

[ "$(id -u)" -ne 0 ] || die "Run this as the normal desktop user (without sudo). It asks for sudo itself when needed."

URL="" AUTOLOGIN=0
for a in "$@"; do
  case "$a" in
    --autologin) AUTOLOGIN=1 ;;
    --remove)
      rm -f "$AUTOSTART" "$LAUNCHER"
      ok "Removed the player autostart. (Screen-blanking and auto-login settings were left as they are.)"
      exit 0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    http://*|https://*) URL="$a" ;;
    *) die "Unknown option: $a" ;;
  esac
done
[ -n "$URL" ] || die "Give the player address, e.g.  bash $0 http://192.168.1.20:3000/player"
[[ "$URL" == */player* ]] || warn "That address doesn't end in /player…; the TV link usually looks like http://SERVER:3000/player/abc123"

echo
echo "Setting up this PC as a ENJOY Signage player → $URL"

# ---- browser
BROWSER=""
for b in google-chrome-stable google-chrome chromium chromium-browser; do
  if command -v "$b" >/dev/null; then BROWSER="$(command -v "$b")"; break; fi
done
if [ -z "$BROWSER" ]; then
  echo "  No Chrome or Chromium found. Installing Chromium (needs your password)…"
  sudo snap install chromium
  BROWSER=/snap/bin/chromium
fi
ok "Browser: $BROWSER"

# ---- launcher (clears the "restore pages?" bubble after a power cut, then starts kiosk mode)
mkdir -p "$(dirname "$LAUNCHER")" "$(dirname "$AUTOSTART")"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Started at login by ~/.config/autostart/church-signage-player.desktop (made by kiosk-ubuntu.sh)
for p in "\$HOME/.config/google-chrome/Default/Preferences" "\$HOME/.config/chromium/Default/Preferences" "\$HOME/snap/chromium/common/chromium/Default/Preferences"; do
  [ -f "\$p" ] && sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "\$p"
done
sleep 5   # give the network a moment after login
exec "$BROWSER" --kiosk --start-fullscreen \\
  --autoplay-policy=no-user-gesture-required \\
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
  --no-first-run --no-default-browser-check --password-store=basic \\
  --disable-features=Translate,TranslateUI --check-for-update-interval=31536000 \\
  "$URL"
EOF
chmod +x "$LAUNCHER"
cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=ENJOY Signage player
Comment=Full-screen signage player
Exec=$LAUNCHER
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
NoDisplay=false
EOF
ok "The player will start full-screen every time this user logs in"

# ---- keep the screen on
if command -v gsettings >/dev/null; then
  gs() { gsettings set "$@" 2>/dev/null; }
  if gs org.gnome.desktop.session idle-delay 0; then
    gs org.gnome.desktop.screensaver lock-enabled false || true
    gs org.gnome.desktop.screensaver idle-activation-enabled false || true
    gs org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' || true
    gs org.gnome.settings-daemon.plugins.power idle-dim false || true
    gs org.gnome.desktop.notifications show-banners false || true
    gs com.ubuntu.update-notifier no-show-notifications true || true
    ok "Turned off screen blanking, screen lock, sleep and pop-up notifications"
  else
    warn "Couldn't change the desktop settings (run this from a terminal on the TV's desktop, not over SSH)."
    warn "Or set them by hand: Settings → Power → Screen Blank: Never, Automatic Suspend: Off; Settings → Privacy → Screen Lock: Off."
  fi
fi

# ---- automatic login (so it recovers from a power cut on its own)
if [ $AUTOLOGIN = 1 ]; then
  CONF=/etc/gdm3/custom.conf
  [ -f "$CONF" ] || die "$CONF not found; set automatic login in Settings → Users instead."
  echo "  Turning on automatic login for '$USER' (needs your password)…"
  sudo cp "$CONF" "$CONF.bak-signage"
  sudo sed -i -E "/^\[daemon\]/,/^\[/{s/^#?[[:space:]]*AutomaticLoginEnable[[:space:]]*=.*/AutomaticLoginEnable=true/;s/^#?[[:space:]]*AutomaticLogin[[:space:]]*=.*/AutomaticLogin=$USER/}" "$CONF"
  grep -q '^AutomaticLoginEnable=true' "$CONF" || sudo sed -i "/^\[daemon\]/a AutomaticLoginEnable=true" "$CONF"
  grep -q "^AutomaticLogin=$USER" "$CONF" || sudo sed -i "/^\[daemon\]/a AutomaticLogin=$USER" "$CONF"
  ok "This PC will log '$USER' in automatically at power-on"
else
  echo "  Tip: add --autologin so the TV comes back by itself after a power cut."
fi

echo
echo "Done. Restart the PC to check it comes up on its own:  sudo reboot"
echo "To get out of the full-screen player: press Alt+F4. To undo all this: bash $0 --remove"
echo
