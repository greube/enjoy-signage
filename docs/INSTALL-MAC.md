# ENJOY Signage on a Mac

This guide installs the signage **server** on a Mac running macOS 11 (Big Sur) or newer. Both Apple Silicon and Intel Macs work. Afterwards you get:

- an **ENJOY Signage app** in Applications, which you can keep in the Dock. It opens the admin panel, and starts the server first if needed.
- a server that **runs in the background**, with no Terminal window to keep open. It **starts by itself** when you log in, and macOS restarts it if it ever stops.
- by default, the Mac **doesn't go to sleep** while the server runs. The display can still turn off.

It doesn't need an administrator password, and macOS won't show an "unidentified developer" warning: the app is created on your Mac by the installer, not downloaded.

---

## 1. Install Node.js (once)

Go to **https://nodejs.org**, download the **LTS** version (the *macOS Installer (.pkg)*), and run it. If you use Homebrew, `brew install node` works too. Version 18 or newer is needed.

## 2. Extract the download

Double-click `enjoy-signage-1.10.1.zip` in Downloads. It extracts to an **`enjoy-signage`** folder. You can delete that folder after installing.

## 3. Run the installer

1. Open **Terminal**: press Cmd+Space, type `Terminal`, and press Return.
2. Type `cd ` (with a space after it), drag the **`enjoy-signage`** folder onto the Terminal window, and press Return.
3. Type this and press Return:

   ```
   node install-mac.js
   ```

The installer asks two things:

- **"Have content from an older ENJOY Signage on this Mac?"** If you've been running it with `node server.js`, drag that old `church-signage` (or `enjoy-signage`) folder into the window and press Return. Your screens, playlists, schedules, media, accounts and Spotify link are copied in, and the old folder isn't changed. Otherwise just press Return.
- **"Add it to the Dock?"** Press Return for yes.

> **Running an old copy in Terminal?** Press Ctrl+C in that Terminal window first. Otherwise both copies try to use port 3000.

When it finishes, your browser opens on the admin panel:

- **New installs:** create your administrator account. The setup code is already filled in.
- **Brought-in content:** sign in with your usual account.

The installer also prints the address for the TVs, for example `http://192.168.1.20:3000/player`.

### Messages macOS may show

- **"Background Items Added"** mentioning `node`: that's the signage server. Leave it switched on in System Settings → General → Login Items → *Allow in the Background*. If it's switched off, the server won't start at login.
- **"Do you want the application node to accept incoming network connections?"** This only appears if the macOS firewall is on. Choose **Allow**, or TVs and other computers can't reach the server.

## 4. Everyday use

| To… | Do this |
|---|---|
| Open the admin panel | Click **ENJOY Signage** in the Dock or in Applications |
| See whether it's running | `node app/platform/mac/enjoy.js status` (see *Extra commands* below) |
| Restart / stop the server | `node app/platform/mac/enjoy.js restart` / `stop`. A stopped server starts again when you open the app or log in. |

If something stops it starting, for example another program already using port 3000, the app opens a note in TextEdit explaining what happened, with the end of the server's log.

## 5. Keep the TVs connected

- **Give the Mac a fixed address.** In your router, add a *DHCP reservation* for it, so the TV links never change.
- **Sleep:** while the server runs, the Mac doesn't idle-sleep. To allow normal sleep instead, run `node app/platform/mac/enjoy.js keep-awake off`. TVs then lose the server whenever the Mac sleeps. A MacBook still sleeps when its lid is closed, unless it's connected to a display and power.
- **After a power cut:**
  - Turn on System Settings → Energy (or Battery → Options) → **Start up automatically after a power failure**. Not every Mac has this.
  - Turn on System Settings → Users & Groups → **Automatically log in as…**. This isn't available while FileVault is on.

  The server starts when that user logs in.

## 6. Where everything lives

Everything is in `~/Library/Application Support/ENJOY Signage`. In Finder, press Cmd+Shift+G and paste that path.

| What | Where |
|---|---|
| Your content: screens, playlists, schedules, uploads, accounts, Spotify link | `data` |
| Drop folders | `data/folders`, unless you chose another location under Setup & backup |
| The program itself (replaced on every update) | `app` |
| Server log | `logs/server.log` |
| Port and sleep setting | `config.json` |
| Background service | `~/Library/LaunchAgents/org.enjoychurch.signage.plist` |

**Sharing drop folders with staff:** go to System Settings → General → Sharing → **File Sharing**, click ⓘ, and add the `folders` folder. Staff can then connect from Finder (Go → Connect to Server) or from Windows File Explorer.

**Drop folders elsewhere:** macOS privacy protection stops background programs reading your Desktop, Documents, Downloads or iCloud Drive. If you point the drop folders at one of those under Setup & backup, give Node.js access:

1. Open System Settings → Privacy & Security → **Full Disk Access** and click **+**.
2. Press Cmd+Shift+G and enter `/usr/local/bin/node`, or `/opt/homebrew/bin/node` if you used Homebrew.
3. Add it, then run `node app/platform/mac/enjoy.js restart`.

The default location needs none of this.

**Backups:** copy the whole `data` folder somewhere safe. Time Machine also includes it.

## 7. Updating

Run `node app/platform/mac/enjoy.js update` from the ENJOY Signage folder (see *Extra commands*). It checks GitHub for a newer version and installs it. If the new version doesn't start, it puts the previous one back. See [UPDATES.md](UPDATES.md), including the one-time setup for a private repository.

Or, from a download: extract the new version and run `node install-mac.js` from it again, as in step 3. Either way, it:

- stops the server
- replaces the program and the app
- keeps your content, port, password and Spotify link
- starts the server again

TVs reconnect by themselves within a few seconds.

## 8. Extra commands

In Terminal, first go to the ENJOY Signage folder:

```
cd ~/Library/Application\ Support/ENJOY\ Signage
```

| Command | What it does |
|---|---|
| `node app/platform/mac/enjoy.js status` | Shows whether it's running, plus its addresses and folders |
| `node app/platform/mac/enjoy.js restart` | Restarts the server |
| `node app/platform/mac/enjoy.js stop` | Stops it until you open the app or log in again |
| `node app/platform/mac/enjoy.js port 8080` | Changes the web port. Update each TV's link afterwards. |
| `node app/platform/mac/enjoy.js keep-awake off` | Lets the Mac sleep normally (`on` to undo) |
| `node app/platform/mac/enjoy.js password` | Sets a password for the built-in **`admin`** recovery account. Use it if everyone is locked out. Leave it blank to turn that login off again. |
| `node app/platform/mac/enjoy.js update` | Installs the newest version from GitHub (`--check` to only look). See [UPDATES.md](UPDATES.md). |
| `node app/platform/mac/enjoy.js uninstall` | Removes ENJOY Signage. It asks whether to keep your content. |

> Dragging the app to the Bin only removes the icon. The server keeps running in the background. Use the `uninstall` command to remove it properly.

If you upgrade or move Node.js, for example switching versions with nvm, run the installer again so everything points at the right `node`. Normal Node.js installer and Homebrew updates don't need this.
