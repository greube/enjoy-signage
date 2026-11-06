# ENJOY Signage

Self-hosted digital signage for the screens around the church. One computer runs the server, and every TV just opens a web page. Everything stays on your own network: no subscription, no cloud account, and nothing to install except Node.js.

## Install it

First install **Node.js** (the LTS version from https://nodejs.org). Then run the installer for the computer that will be the server:

| Server computer | Run this in this folder | Guide |
|---|---|---|
| **Windows** 10 or 11 | `node install-windows.js` | [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) |
| **Mac** (macOS 11 or newer) | `node install-mac.js` | [docs/INSTALL-MAC.md](docs/INSTALL-MAC.md) |
| **Ubuntu** 22.04 or newer | `sudo bash install-ubuntu.sh` | [docs/INSTALL-UBUNTU.md](docs/INSTALL-UBUNTU.md) |

Each installer sets it up to run in the background and start by itself. It also brings in your content from an older copy if you have one, and opens the admin panel when it's done. To update later, use the update command, which installs the newest version from GitHub and rolls back if it doesn't start. Or run a new download's installer the same way. Your content is kept either way. See [docs/UPDATES.md](docs/UPDATES.md).

## Then

- **Set up screens, playlists and schedules:** see [docs/GUIDE.md](docs/GUIDE.md). It covers drop folders, Spotify background music, user accounts and connecting each TV.
- **Use the admin panel from home:** see [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md) (free Cloudflare Tunnel or Tailscale).

## What's in this folder

| | |
|---|---|
| `install-windows.js`, `install-mac.js`, `install-ubuntu.sh` | The installers |
| `server/` | The server: web API, schedules, uploads, accounts, drop folders, Spotify |
| `public/` | The admin panel, the TV player and the sign-in page |
| `platform/` | Helper files for each platform (Windows icon and shortcuts, the Mac app, Ubuntu commands and TV kiosk setup) and the updater |
| `docs/` | The guides |
| `data/` | Your content when running it by hand with `node server/server.js` (created on first start; the installers keep it elsewhere) |
