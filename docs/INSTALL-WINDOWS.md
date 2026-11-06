# ENJOY Signage on Windows

This guide installs the signage **server** on a Windows 10 or 11 computer. Afterwards you get:

- an **ENJOY Signage icon on the desktop** and in the Start menu, which opens the admin panel and starts the server first if needed
- a server that **runs in the background**, with no window to keep open, and **starts by itself** when you sign in to Windows
- a server that **restarts itself** if it ever crashes
- an entry in **Settings → Apps**, so you can uninstall it like any other program

It works with **Smart App Control** turned on. There are no `.bat`, PowerShell or unsigned programs: everything runs through Node.js, which is signed. Nothing needs administrator rights.

---

## 1. Install Node.js (once)

1. Go to **https://nodejs.org** and download the **LTS** version, the *Windows Installer (.msi)*.
2. Run it and click through with the default settings.

If you already run ENJOY Signage on this computer, Node.js is already installed. Version 18 or newer is fine.

## 2. Extract the download

Right-click `enjoy-signage-1.10.1.zip` → **Extract All…** → **Extract**. Any folder is fine, for example *Downloads*. You can delete this folder after installing.

## 3. Run the installer

1. Open the extracted **`enjoy-signage`** folder, the one containing `install-windows.js`.
2. Right-click an empty space in the folder and choose **Open in Terminal**.
   - On Windows 10: click the folder's address bar, type `cmd`, and press **Enter**.
3. Type this and press **Enter**:

   ```
   node install-windows.js
   ```

> Don't double-click `install-windows.js`. Windows would try to open it with the wrong program. It has to be started with `node` as shown above. This step is only needed once, and updates work the same way.

**Moving from an older copy?** The installer asks: *"Have content from an older ENJOY Signage on this computer?"*

1. Drag the old `church-signage` (or `enjoy-signage`) folder into the terminal window.
2. Press **Enter**.

All your screens, playlists, schedules, uploaded media, accounts and Spotify link are copied in. The old folder isn't changed. Press **Enter** without dragging anything to start fresh.

> **Close the old copy first.** Close its server window, and if you put a `start-windows.bat` shortcut in the Startup folder (Win+R → `shell:startup`), delete that shortcut. Otherwise both copies try to use port 3000.

When it finishes, your browser opens on the admin panel:

- **New installs:** create your administrator account. The setup code is already filled in. Then go to **Users** to add everyone else.
- **Brought-in content:** sign in with your usual account.

The installer also prints the address for the TVs, for example `http://192.168.1.20:3000/player`.

### The firewall

When the server first starts, Windows may ask whether **Node.js** may use the network. Tick **Private networks** and choose **Allow**. Otherwise TVs and other computers can't reach the server.

If you missed the prompt, run the installer once more from an **administrator** terminal:

1. Start → type `terminal` → right-click → **Run as administrator**.
2. Go to the folder with `cd "C:\path\to\enjoy-signage"`.
3. Run `node install-windows.js`.

It then adds the firewall rule itself.

## 4. Everyday use

| To… | Do this |
|---|---|
| Open the admin panel | Double-click **ENJOY Signage** on the desktop (or in the Start menu) |
| Restart the server | Start → ENJOY Signage → **Restart ENJOY Signage server** |
| Stop it until next time | Start → ENJOY Signage → **Stop ENJOY Signage server**. Opening ENJOY Signage or restarting the PC starts it again. |
| See your content, drop folders and logs | Start → ENJOY Signage → **ENJOY Signage folder** |
| Install the newest version | Start → ENJOY Signage → **Update ENJOY Signage** (see *Updating* below) |
| Uninstall | Settings → Apps → **ENJOY Signage** → Uninstall. It asks whether to keep your content. |

If something stops it starting, for example another program already using port 3000, the desktop icon opens a note in Notepad explaining what happened, with the end of the server's log.

## 5. Keep the TVs connected

- **Give the computer a fixed address.** In your router, add a *DHCP reservation* for it, so the TV links never change.
- **Stop it sleeping.** Go to Settings → System → Power & battery → Screen and sleep, and set "put my device to sleep" to **Never**. The screen can still turn off.
- **Sign in automatically.** The server starts when someone signs in to Windows. On a dedicated signage PC, turn on automatic sign-in so it recovers from a power cut on its own: press Win+R, type `netplwiz`, and untick *Users must enter a user name and password*. If that tick box is missing, turn off *Require Windows Hello sign-in* under Settings → Accounts → Sign-in options first.

## 6. Where everything lives

Everything is in your user's `AppData\Local\ENJOY Signage` folder (Start → ENJOY Signage → ENJOY Signage folder):

| What | Where |
|---|---|
| Your content: screens, playlists, schedules, uploads, accounts, Spotify link | `data` |
| Drop folders | `data\folders`, unless you chose another location under Setup & backup |
| The program itself (replaced on every update) | `app` |
| Server log | `logs\server.log` |
| Port | `config.json` |

**Backups:** copy the whole `data` folder somewhere safe, for example a USB stick. The **Download backup** button in the admin panel saves screens, playlists and schedules but not the media files.

## 7. Updating

Go to Start → ENJOY Signage → **Update ENJOY Signage**. It checks GitHub for a newer version and installs it. If the new version doesn't start, it puts the previous one back. See [UPDATES.md](UPDATES.md), including the one-time setup for a private repository.

Or, from a download: extract the new version and run `node install-windows.js` from it again, as in step 3. Either way, it:

- stops the server
- replaces the program
- keeps your content, port, password and Spotify link
- starts the server again

TVs reconnect by themselves within a few seconds.

## 8. Extra commands

Open **Start → ENJOY Signage → ENJOY Signage folder**, right-click an empty space → **Open in Terminal**, then type:

| Command | What it does |
|---|---|
| `node app\platform\windows\enjoy.js status` | Shows whether it's running, plus its addresses and folders |
| `node app\platform\windows\enjoy.js port 8080` | Changes the web port. Update each TV's link afterwards. |
| `node app\platform\windows\enjoy.js update --check` | Says whether a newer version is available. Without `--check`, it installs it. |
| `node app\platform\windows\enjoy.js password` | Sets a password for the built-in **`admin`** recovery account. Use it if everyone is locked out. Leave it blank to turn that login off again. |

If you move or reinstall Node.js somewhere else, run the installer again so the icons point at the new location.

## Troubleshooting

**The icon does nothing / Notepad says it didn't start.**
- *Port in use:* another program, often an old ENJOY Signage window, already uses the port. Close it, or change the port with `node app\platform\windows\enjoy.js port 8080`.
- Otherwise, read the end of `logs\server.log` in the ENJOY Signage folder.

**TVs show a red dot or can't connect, but the admin panel works on the server.**
The firewall is blocking them. See *The firewall* above. Also check the TV link uses the server's current address.

**Schedules switch at the wrong time.**
Check Windows' time zone under Settings → Time & language, then use **Restart ENJOY Signage server**.
