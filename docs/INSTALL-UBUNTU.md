# ENJOY Signage on Ubuntu

This guide sets up the signage **server** on an Ubuntu computer. The server starts by itself at power-on, restarts itself if it ever crashes, and keeps your content safe through updates. It also shows how to turn an Ubuntu PC behind a TV into a **player**. Either part can be used on its own.

Works on **Ubuntu 22.04, 24.04 and 26.04 LTS**, desktop or server edition, including a mini PC or an old office PC. Nothing extra is needed: the installer sets up Node.js itself.

---

## 1. Before you start

- **Use a computer that stays on.** It doesn't need much: 2 GB RAM is plenty. The disk only needs room for your videos.
- **Give it a fixed address on the network.** In your router, add a *DHCP reservation* for this computer, so the TV links never change. Do this first. You'll see the address the installer uses at the end of step 3.
- **Have internet access during the install**, so Node.js can be downloaded. After that, it only needs the internet for YouTube or web-page items and for Spotify.

## 2. Copy the files over

Copy `enjoy-signage-1.10.1.tar.gz` to the Ubuntu computer, for example with a USB stick or by downloading it. Then open a **Terminal** (Ctrl+Alt+T) in that folder and extract it:

```bash
tar -xzf enjoy-signage-1.10.1.tar.gz
cd enjoy-signage
```

> **Moving from the Windows version?** Copy the whole `data` folder from the Windows computer into this `enjoy-signage` folder before the next step. With the Windows installer it's in `AppData\Local\ENJOY Signage` (Start → ENJOY Signage → ENJOY Signage folder); with an older copy it sits next to `server.js`. The installer brings in all your screens, playlists, schedules and uploaded media automatically. TV links stay the same apart from the server address.

## 3. Install

```bash
sudo bash install-ubuntu.sh --timezone Australia/Sydney
```

It asks you to choose a password for the built-in **`admin`** account, the first administrator and your recovery login. TVs never need it. If you leave it blank, the installer generates one and prints it, so write it down.

When it finishes, it shows something like:

```
✅ ENJOY Signage is running
  Admin panel:  http://192.168.1.20:3000/
  TVs open:     http://192.168.1.20:3000/player
```

Open the admin panel address from any computer or phone on the church network. Sign in as **`admin`** with that password. Then go to **Users** to create your own administrator account, and editor accounts for anyone who only needs to upload content and edit certain playlists.

**Installer options** (all optional):

| Option | What it does |
|---|---|
| `--timezone Australia/Sydney` | Sets the computer's time zone. **Schedules and countdowns use this clock.** Ubuntu server installs often default to UTC. |
| `--port 8080` | Uses a different port instead of 3000. `--port 80` gives addresses with no `:3000` on the end. |
| `--password 'secret'` | Sets the password without being asked. |
| `--no-firewall` | Leaves the firewall alone. By default, if Ubuntu's `ufw` firewall is on, the port is opened. |

## 4. Where everything lives

| What | Where |
|---|---|
| Your content: screens, playlists, schedules, uploads, Spotify link | `/var/lib/church-signage` |
| Settings (port) | `/etc/church-signage/church-signage.env` |
| Built-in `admin` password | `/etc/church-signage/admin-password` (readable only by the server) |
| User accounts (hashed passwords) | `/var/lib/church-signage/users.json` |
| The program itself | `/opt/church-signage` (replaced on every update) |
| Background service | `church-signage.service`, which runs as its own locked-down `church-signage` user |

## 5. Everyday commands

| Command | What it does |
|---|---|
| `church-signage status` | Shows whether it's running, its addresses, the time zone and data size |
| `sudo church-signage logs` | Shows the live log. Press Ctrl+C to stop watching. |
| `sudo church-signage restart` | Restarts the server. `stop` and `start` work too. |
| `sudo church-signage password` | Changes the built-in `admin` (recovery) password. Everyone else's passwords are managed on the **Users** page. |
| `sudo church-signage port 8080` | Changes the port. Then update each TV's link to match. |
| `sudo church-signage backup` | Saves *everything* to a `.tar.gz` file in the current folder |
| `sudo church-signage restore FILE.tar.gz` | Puts a backup back, keeping a copy of the current data first |
| `sudo church-signage restore-folder DIR` | Uses a `data` folder copied from another computer |
| `sudo church-signage share-folders` | Shares the drop folders on the network as `\\SERVER-IP\signage` |
| `sudo church-signage update` | Installs the newest version from GitHub (see step 9) |
| `church-signage help` | Lists all the commands |

## 6. Connect the TVs

Add each screen in the admin panel (**Screens → Add screen**). Then open that screen's link on the device behind the TV.

### If the TV is driven by an Ubuntu PC

Log in to that PC's desktop as the normal user, open a Terminal, copy `platform/ubuntu/kiosk-ubuntu.sh` from the download onto it, and run:

```bash
bash kiosk-ubuntu.sh http://192.168.1.20:3000/player/SCREEN-ID --autologin
```

Use the screen's own link from the admin panel (**Screens → Copy**). The script:

- installs Chromium if there's no Chrome or Chromium yet
- makes the player open full-screen every time the PC starts, with video sound allowed
- turns off screen blanking, the lock screen, sleep and pop-up notifications
- with `--autologin`, logs in by itself at power-on, so the TV recovers from a power cut without anyone touching it

Restart the PC (`sudo reboot`) to check it comes up on its own. To get out of the player, press **Alt+F4**. To undo the setup, run `bash kiosk-ubuntu.sh --remove`.

> The server PC can also drive a TV itself. Run the kiosk script on it with `http://127.0.0.1:3000/player/SCREEN-ID`.

### Other devices

Mini PCs running Windows, Raspberry Pis, smart TV browsers and Android TV boxes all work too. See *Connect each TV* in [GUIDE.md](GUIDE.md).

## 7. Drop folders (optional)

Playlists can fill themselves from a folder (see *Drop folders* in [GUIDE.md](GUIDE.md)). On Ubuntu the folders live in `/var/lib/church-signage/folders`. To let staff drag files in from their own Windows PCs or Macs, share them on the network:

```bash
sudo church-signage share-folders
```

It installs Samba (Windows file sharing), asks you to choose a password, and prints the address. On Windows that's `\\SERVER-IP\signage`: type it in File Explorer's address bar, sign in as **signage** with that password, and tick *Remember my credentials*. Right-click it → *Map network drive* to keep it in File Explorer. On a Mac, use Finder → Go → Connect to Server → `smb://SERVER-IP/signage`. To stop sharing, run `sudo church-signage unshare-folders`.

If you point the drop folders at another location (Setup & backup → Drop folders), use somewhere outside `/home`, such as `/srv/signage`. For safety, the service isn't allowed to read home folders. Then make the folder readable by the service: `sudo chgrp -R church-signage /srv/signage && sudo chmod -R g+rX /srv/signage`.

## 8. Spotify background music (optional)

Follow *Background music (Spotify)* in [GUIDE.md](GUIDE.md). On Ubuntu, two things are different:

- The Redirect URI to add in your Spotify app is `http://127.0.0.1:3000/spotify/callback`. Use your port if you changed it.
- If this is a server with **no screen**, do the **Connect Spotify** step from the admin panel on another computer. After you click *Agree*, that tab ends on a `127.0.0.1` page that won't load. That's expected. Copy the whole address from that tab into the box on the Setup page.

## 9. Updating to a new version

```bash
sudo church-signage update
```

It checks GitHub for a newer version and installs it. If the new version doesn't start, it puts the previous one back. Add `--check` to only look. See [UPDATES.md](UPDATES.md), including the one-time setup for a private repository.

Or, from a download, extract the new version and run its installer:

```bash
tar -xzf enjoy-signage-NEW.tar.gz
cd enjoy-signage
sudo bash install-ubuntu.sh
```

Your content, password, port and Spotify connection are all kept. TVs reload themselves within a few seconds. It's still worth running `sudo church-signage backup` first.

## 10. Backups

```bash
sudo church-signage backup /media/usb-stick     # or any folder
```

This one file holds everything, including uploaded videos. To set it up on a replacement computer, install as in step 3, then run `sudo church-signage restore church-signage-backup-….tar.gz`.

The **Download backup** button in the admin panel saves only screens, playlists, schedules and slides, without the uploaded media. Use the command above for a complete backup.

## 11. Uninstalling

```bash
sudo church-signage uninstall           # removes the program, keeps your content and settings
sudo church-signage uninstall --purge   # removes everything, including all content
```

---

## Troubleshooting

**The admin panel won't open from other computers.**
1. Run `church-signage status` on the server. It should say *running*.
2. Try the address on the server itself: `http://127.0.0.1:3000/`.
3. If it works there but not elsewhere, check the address matches the fixed IP from step 1.
4. If you use a firewall other than `ufw`, open the port in it.

**It says *stopped*, or keeps restarting.**
Run `sudo church-signage logs` to see why. Common causes:
- *Address already in use*: another program has port 3000, so use `sudo church-signage port 8080`.
- *Could not read the admin password file*: set one again with `sudo church-signage password`.

**Schedules switch at the wrong time.**
The computer's time zone is wrong. Fix it with:
```bash
sudo timedatectl set-timezone Australia/Sydney
sudo church-signage restart
```

**A TV shows a small red dot in the corner.**
It has lost contact with the server. It keeps playing what it had and reconnects by itself. Check the server is running and the TV is on the network.

**Videos have no sound on an Ubuntu TV PC.**
1. Tick *Play video sound* on that screen in the admin panel.
2. Check the PC's sound output (Settings → Sound) is set to the TV's HDMI.
3. Make sure the player was started by the kiosk script, which allows video sound.

**The installer said Node.js could not be installed.**
The computer probably had no internet at the time. Connect it and run the installer again.
