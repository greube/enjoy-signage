# ENJOY Signage: the full guide

A small, self-hosted alternative to Yodeck for running the screens around your church. Everything stays on your own network: one computer runs the server, and every TV just opens a web page.

- **Screens.** Each TV gets its own player link. Pick it once on the device and it remembers.
- **Playlists.** Each screen plays its own default loop of images, videos, web pages / YouTube, text slides and service countdowns.
- **Schedules.** At set times, a playlist takes over chosen screens (e.g. Sundays 9:30–12:00, Youth on Fridays, a one-off Christmas Eve). Overlaps are settled by priority, and overnight and date-limited schedules work.
- **Takeover now.** One click pushes a playlist to some or all screens immediately, for a set time or until you stop it.
- **Live status.** See which screens are online, what each is showing and why (default, schedule or takeover). **Identify** flashes a screen's name on the TV.
- **Drop folders.** Link a playlist to a folder. Images and videos dropped into it go on the screens by themselves, and deleting a file takes it off.
- **Background music.** Optional Spotify link: the church's music fades out and pauses while a chosen video plays with sound, then fades back in when it finishes.
- **Robust players.** If the server or Wi-Fi drops, screens keep playing what they have and reconnect by themselves.
- **No dependencies.** Only Node.js is needed: no database and no `npm install`. Data is a single JSON file plus an uploads folder.

---

## 1. Install & run the server

> **Using it from outside the church?** See **[REMOTE-ACCESS.md](REMOTE-ACCESS.md)**: a free Cloudflare Tunnel with email sign-in, or Tailscale.
>
> **On Windows?** Follow **[INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)**. One command (`node install-windows.js`) installs it with a desktop icon, runs it in the background and starts it when you sign in. It works with Smart App Control on.
>
> **On a Mac?** Follow **[INSTALL-MAC.md](INSTALL-MAC.md)**. One command (`node install-mac.js`) adds an ENJOY Signage app to Applications and the Dock, and runs the server in the background from login.
>
> **On Ubuntu?** Follow **[INSTALL-UBUNTU.md](INSTALL-UBUNTU.md)** instead. One command installs it as a service that starts at boot, with a helper for passwords, backups and updates.

**Running it without an installer** (for example on a Raspberry Pi or a NAS): you need **Node.js 18 or newer** (https://nodejs.org, the LTS version). Use a computer that stays on, such as an office PC, a mini PC, a Raspberry Pi 4/5 or a NAS.

```bash
cd enjoy-signage
node server/server.js
```

The console prints the addresses, for example:

```
Admin panel:   http://192.168.1.20:3000/
Screens open:  http://192.168.1.20:3000/player
```

**Give the server a fixed IP address.** In your router, add a *DHCP reservation* for this computer, so the TV links never change.

### Options

Set these as environment variables before starting:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Web port |
| `ADMIN_PASSWORD` | *(none)* | Password for the built-in **`admin`** recovery account. Everyday sign-ins use the accounts you create under **Users**. |
| `ADMIN_PASSWORD_FILE` | *(none)* | Reads that password from this file instead. The server refuses to start if the file can't be read. |
| `DATA_DIR` | `./data` | Where `db.json` and `uploads/` are stored |
| `MAX_UPLOAD_MB` | `4096` | Largest upload size |

```bash
# Linux / Mac
ADMIN_PASSWORD=changeme PORT=8080 node server/server.js
# Windows (PowerShell)
$env:ADMIN_PASSWORD="changeme"; node server/server.js
```

Player links never ask for a password. Only the admin panel does.

### Keep it running after reboots

**Ubuntu.** Run `sudo bash install-ubuntu.sh`. See [INSTALL-UBUNTU.md](INSTALL-UBUNTU.md).

**Windows.** Run `node install-windows.js`. See [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).

**Mac.** Run `node install-mac.js`. See [INSTALL-MAC.md](INSTALL-MAC.md).

---

### Signing in and user accounts

Everyone signs in with their own username and password. TV player links never need to sign in.

- **First start:** if no administrator exists yet, the server window shows a 6-digit **setup code** (also saved in `data/setup-code.txt`). Open the admin panel, enter the code, and create your own administrator account. Upgrading from an older version that used `ADMIN_PASSWORD` skips this: sign in as **`admin`** with that password.
- **Users page (administrators):** add a person and choose their role:
  - **Administrator:** everything.
  - **Editor:** sees only **Media** and **Playlists**. Editors can upload files and create slides, edit or delete only content they added, and edit only the playlists you tick for them: reorder, add and remove items, set timings. They can't create or delete playlists, or see screens, schedules, music, settings, backups or other users.
- **Lockout:** after **5 wrong passwords in a row**, sign-in pauses for **30 seconds**. It's counted per username and per device.
- **Changes take effect immediately:** changing someone's password, role or disabling them signs them out everywhere.
- **Everyone** can change their own password, and sign out, from the bottom of the sidebar.
- **Recovery:** if `ADMIN_PASSWORD` is set on the server, username `admin` with that password always signs in as an administrator. On Ubuntu, `sudo church-signage password` sets it.
- **Where accounts are kept:** passwords are stored as scrypt hashes in `data/users.json`. They're not included in **Download backup**, so restoring a backup can't change who can sign in.

## 2. Set up content

1. **Media:** upload images and videos, or create text slides, countdowns and web pages / YouTube links.
2. **Playlists:** build loops. Drag to reorder and set seconds per item. Videos with a blank duration play to the end.
3. **Screens:** add each display and choose its *default playlist*.
4. **Schedules:** choose a playlist, screens, days and times to take over automatically.

**What a screen shows, highest priority first:**

1. An active **takeover**. The newest wins if several apply.
2. An active **schedule**. The highest priority wins if several overlap.
3. The screen's **default playlist**.

Schedule tips:

- An end time earlier than the start time runs overnight, e.g. 22:00 → 02:00.
- The same start and end time means all day.
- For a one-off event, set both dates to the same day.

**Play once:** for a playlist that should run through a single time at a set moment (a welcome video at 9:30, a countdown then a sermon intro), set the playlist's **At the end** to **Play once**. Then schedule it, or use it for a takeover.

- When the schedule's window starts, each of its screens plays the playlist through once. A single video plays to the end instead of looping. The screen then goes back to what it would otherwise show: a lower-priority schedule, or its default playlist.
- Make the schedule's window at least as long as the playlist, e.g. 9:30 → 10:00 for a 5-minute video. If the window closes first, the playlist stops there as usual.
- It plays once per window, so a schedule that repeats every Sunday plays it once every Sunday. Restarting or updating the server doesn't make it play again. Changing the schedule's start time does, which is handy for a rehearsal.
- A takeover with a play-once playlist plays once on each screen and then steps aside, even if the takeover itself runs longer.
- Used as a screen's default playlist, a play-once playlist still loops.
- The Screens page shows when a screen has finished one, e.g. *"Christmas Eve" has played once*.

**Video format:** MP4 with H.264 video and AAC audio plays everywhere. Keep files at 1080p unless your TVs are 4K. HEVC/H.265 and `.mov` files may not play in every browser.

**Web pages:** some sites refuse to be shown inside another page. Published Google Slides, Canva "public view" links, YouTube and most church-calendar embeds work fine. Use *Preview* to check.

---

## 3. Connect each TV

Any device with a modern browser works, for example:

- a mini PC or Intel NUC
- a Raspberry Pi 4/5
- a Chromebox
- a smart TV's browser
- an Android TV box with a kiosk browser app such as *Fully Kiosk Browser*

1. On the device, open `http://SERVER-IP:3000/player` and tap the screen it should be.
2. Use **Identify** in the admin panel to confirm.
3. Set the browser to start full-screen at boot (kiosk mode):

**Windows (Chrome).** Create a shortcut in `shell:startup` with this target:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-session-crashed-bubble --disable-infobars http://SERVER-IP:3000/player
```

**Raspberry Pi OS (Bookworm, desktop).** Add this to `~/.config/labwc/autostart`, or `~/.config/wayfire.ini` under `[autostart]`:

```
chromium-browser --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-session-crashed-bubble http://SERVER-IP:3000/player
```

Also turn off screen blanking with `sudo raspi-config` → Display Options → Screen Blanking → No.

**Notes:**

- `--autoplay-policy=no-user-gesture-required` lets video **sound** autoplay. Without it, browsers mute videos. Sound is also off per screen by default; tick *Play video sound* on the screen.
- To make a device switch to a different screen, open `/player?pick`.
- A small red dot in the bottom-right corner of a TV means it has lost contact with the server. It keeps playing and reconnects automatically.
- When the server restarts, screens reload themselves within a few seconds.

---

### Branding

The ENJOY Signage wordmark (the ENJOY logo with SIGNAGE in Helvetica Bold) appears in the admin panel and on the TVs when nothing is scheduled and on the "Which screen is this?" picker. The browser tab shows the round ENJOY badge. The image files are in `public/brand/`.

To show a different logo instead (for a campus or an event, say), go to **Setup & backup → Branding → Use a different logo**. **Back to ENJOY Signage** restores the wordmark.

---

### Keeping screens in sync

Screens play in step with each other:

- **Every screen showing the same playlist plays it in sync.** They change items at the same moment and keep videos lined up, typically within a few hundredths of a second. A screen that's switched on late, or reloads, jumps straight to the right point instead of starting from the top.
- **Screens in the same room change items together, even with different playlists.** Give screens a **Room** (Screens → Edit → Room, e.g. *Foyer*). At each step every screen in the room shows its own next item, and the room moves on when the longest of them has finished. A shorter item stays up until then: an image stays on screen, and a video holds on its last frame. If something new starts on any screen in the room (a schedule or takeover), the whole room starts its beat again together.
- **Scheduled changes happen on the moment.** Screens hear about a change a few seconds in advance, load it, and all switch on the exact second. A takeover starts about 3 seconds after you press **Start takeover**, so every screen has it ready and they all start together.
- Each screen card on the Screens page shows how closely that screen is keeping time, e.g. *⏱ Synced · within 4 ms*.

**Videos need their length known.** Videos uploaded in the admin panel are measured as they upload. Videos added before version 1.13, and drop-folder videos, are measured by a TV the first time it plays them. Until then the card says *Not synced yet* and the screen plays as before.

**Turning it off:** in a playlist, set **Screens** to **Each on its own**, and every screen plays it at its own pace, as in earlier versions.

**Sound:** if several screens in one room play the same video, let only one of them play sound (Screens → Edit → Sound). Even a few hundredths of a second between speakers can sound like an echo.

**How close it gets:** within a frame or two on mini PCs, Chromecast/Google TV and Fire TV devices. Older smart-TV built-in browsers can be a tenth of a second or so apart, and may occasionally skip a moment to catch up. Web pages and YouTube items switch on and off together, but what plays inside them can't be kept in step.

## 4. Drop folders: playlists that fill themselves

Link a playlist to a folder on the server, and images and videos dropped into it are added automatically. No admin panel needed: the office can save next week's notices straight into the folder. Once a file has been added, it's an ordinary item, so you can still fine-tune everything in the admin panel.

1. **Playlists** → open a playlist → **📁 Link a drop folder…** → pick a folder or create one → **Use this folder**. The link is saved straight away, and anything already in the folder is added.
2. Drop images (JPG, PNG, GIF, WebP) or videos (MP4, WebM, MOV) into the folder. Each one appears in the **Media** library, marked 📁, and at the end of the playlist (or the start, if you choose) within about 5–10 seconds. Images get the folder's default time and sizing; videos play to the end. Several files arriving at once are added in file-name order (`01`, `02`, … `10`).
3. From then on, each one is a **normal item**:
   - drag it anywhere
   - give it its own time, fit/fill and music setting
   - add it to other playlists
   - rename it in the Media library
   - remove it from one playlist with ✕. It stays in the folder and won't be added to that playlist again.

What happens when the folder changes:

| You do this in the folder | What happens |
|---|---|
| Add a file | It's added to every playlist linked to that folder |
| Save over a file (same name) | Screens show the new version; its position and settings stay |
| Delete a file | It's removed from the library and every playlist, just like deleting media |
| Rename a file | Treated as delete plus add, so it goes to the end with default settings |

Deleting a 📁 item in the **Media** library also deletes the file from the folder, otherwise the folder would just bring it back.

Safety details:

- **Half-copied files are never shown.** A file is only used once it has stopped changing for a few seconds.
- **Temporary files are ignored.** Files from Office, browsers and sync apps (`~$…`, `.crdownload`, `.part`, `Thumbs.db` and so on) never appear.
- **A missing folder deletes nothing.** If the whole folder or location temporarily disappears (a network or sync hiccup), its items are skipped until it's back.
- **No jumps back to the start.** Screens carry on from what they're showing when a playlist changes.

**Where the folders live.** By default they're in `data/folders`: on Windows that's `AppData\Local\ENJOY Signage\data\folders` (Start → ENJOY Signage → ENJOY Signage folder), on a Mac `~/Library/Application Support/ENJOY Signage/data/folders`, and on Ubuntu `/var/lib/church-signage/folders`. **Setup & backup → Drop folders** shows each folder's full path and which playlists use it. You can change the location there, for example to a OneDrive, Dropbox or Google Drive folder synced to the server. That lets staff drop files from anywhere. On OneDrive, set the folder to *Always keep on this device*.

**Letting staff drop files from their own computers:**

- **Windows server:** right-click the `folders` folder (inside `data` in the ENJOY Signage folder) → *Properties → Sharing → Share…*, add the people who should be able to drop files, and give them *Read/Write*. They open `\\SERVERNAME\folders` in File Explorer. *Map network drive* keeps it there permanently.
- **Mac server:** System Settings → General → Sharing → File Sharing → ⓘ → add the `folders` folder.
- **Ubuntu server:** run `sudo church-signage share-folders`. It shares them as `\\SERVER-IP\signage` (username `signage`, with a password you choose).

Only image and video files that are directly inside a drop folder can ever be served to screens. Nothing else on the computer can be reached through this feature.

---

## 5. Background music (Spotify), optional

If you play background music from Spotify, the signage server can pause it while a video with sound plays, then fade it back in afterwards. It doesn't play music itself. It remote-controls whichever device Spotify is already playing on, such as the sound desk PC, a smart speaker or a phone.

**You need:** a **Spotify Premium** account (Spotify only allows playback control for Premium), and the server needs internet access.

### Connect it (once)

1. Go to https://developer.spotify.com/dashboard and sign in with the church's Spotify account, the one that plays the music. Click **Create app** and give it any name.
2. Under **Redirect URIs**, add exactly `http://127.0.0.1:3000/spotify/callback` (use your port if it isn't 3000), and tick **Web API**. The Setup page shows the exact address with a Copy button.
3. Copy the app's **Client ID** into **Setup & backup → Background music** and click **Connect Spotify**.
   - **On the server computer itself:** you'll come straight back connected.
   - **From another computer:** after you click *Agree*, that tab lands on a `127.0.0.1` page that can't load. This is expected, because Spotify only accepts `127.0.0.1` sign-in addresses without HTTPS. Copy the whole address from that tab and paste it into the box on the Setup page.

### Choose which videos pause the music

- **Per playlist:** in the playlist editor, set **Music** to *Keep playing* (the default), *Pause for videos* (videos and YouTube items), or *Pause the whole time*. Takeovers and schedules use the playlist's setting.
- **Per item:** each item has a **♪** setting. *Auto* follows the playlist, *Pause* always pauses and *Keep* never does. Items that will pause the music show a green **pauses music** tag.
- Only screens with **Play video sound** turned on pause the music. A muted foyer TV playing the same video won't stop the music in the auditorium.

### How it behaves

- When a video starts, the music fades down over about 2 seconds and pauses, while the video's sound fades in. In **turn-down mode**, the music just drops to a lower volume instead.
- When the video finishes, the server waits a few seconds (*Resume after*) and then resumes the music and fades it back up. Back-to-back videos don't make it flicker.
- **It doesn't fight people.** If Spotify wasn't playing when the video started, nothing changes. If someone presses play, moves the music to another device, or changes the volume during the video, the server leaves it alone.
- **It's fail-safe.** Each TV renews its request every few seconds. If a TV is switched off mid-video, or the server restarts, the music comes back by itself within about 30 seconds.
- The **Screens** page shows what's playing, which screen is holding the music, and play/pause/skip buttons, plus **Resume music now**.
- Fades need a device whose volume Spotify can control. Some speakers don't allow it; on those, the music simply pauses and resumes.
- **It keeps trying to resume.** Some devices, iPhones and iPads especially, drop out of Spotify soon after being paused. If the first try doesn't work, the server keeps trying for about 3½ minutes, so the music carries on by itself as soon as someone opens Spotify on the device again. If it still can't, the Music page says so and asks you to press play on that device. For a device that never drops out, play the music from the Spotify app on a computer, or keep Spotify open on screen on the iPad with Auto-Lock set to Never.

The Spotify sign-in is stored in `data/spotify.json`. It isn't included in **Download backup**, so after restoring on a new computer you only need to click Connect again.

---

### The Music page

Once Spotify is connected, the **Music** page gives you:

- **Player controls:** play/pause, skip, shuffle, repeat, volume, **Fade out & stop**, and **Move music here** to switch the music to another speaker or computer signed in to the church account.
- **Play now:** pick one of the church account's playlists (or paste any Spotify link: … → Share → Copy link), choose the device, volume and shuffle, then press Play.
- **Music schedules:** a playlist starts by itself on chosen days and times, e.g. *Sunday pre-service, 8:30–9:55am, Sunday Welcome playlist on the Sound desk PC at 40%, shuffled*. When it ends, it fades out (or keeps playing, if you choose). Overlaps are settled by priority, and a weekly timeline shows the week at a glance. **▶** on a schedule plays it straight away.

How schedules behave:

- They only act when they start and end, so anyone can still change the music by hand in between.
- If a schedule starts or ends while the music is paused for a video, the switch happens as soon as the video finishes, with no blip of the old music.
- The chosen device needs Spotify open when the schedule starts. If it isn't available, the Music page says so and the server tries again every minute.

**Connected Spotify before version 1.6?** To see your playlists in the lists, reconnect once: Setup & backup → Background music → Disconnect, then Connect. Spotify needs the extra "read your playlists" permission. Pasted links work either way.

---

## 6. Backup

**Setup & backup → Download backup** saves screens, playlists, schedules and slides as a single JSON file. Uploaded images and videos live in `data/uploads/`, so copy the whole `data` folder for a complete backup.

The server also keeps `data/db.backup.json`, which is a copy taken each time it starts.

To move to a new computer, copy the whole `enjoy-signage` folder, including `data/`, and start it there. (With the Windows, Mac or Ubuntu installer, copy the `data` folder and see that platform's guide.)

---

## How it works (for the tech team)

- `server/server.js` is a plain Node `http` server. It handles the JSON API, schedule resolution, streamed uploads, and file serving with HTTP Range support for video seeking. It holds state in memory and writes it atomically to `data/db.json` on every change.
- `public/player.html` polls `GET /api/player/:id/state` every 5 seconds. The response includes a content hash, and the player only restarts its loop when that hash changes. That poll is also the heartbeat shown in the admin panel. Playback uses two stacked layers to crossfade, and images and videos are cached by the browser.
- `public/admin.*` is the admin single-page app, written in vanilla JS with no build step.
- Schedules use the **server computer's clock and time zone**, so check it is set correctly. Countdowns use the server's time too.

API summary:

- `GET /api/state` returns everything the admin panel needs.
- `POST|PUT|DELETE` on `/api/screens`, `/api/playlists`, `/api/schedules` and `/api/media` manage each kind of item.
- `POST /api/uploads/start`, `PUT /api/uploads/:id?offset=N`, `POST /api/uploads/:id/finish` upload a file in pieces (any size, resumable). `POST /api/media/upload?name=file.mp4` still takes a whole file in one request.
- Changes (anything but GET) from the admin panel must send the header `X-Signage: 1`; this blocks forged cross-site requests. Uploaded files are served with a sandboxing Content-Security-Policy, and SVG uploads are refused.
- `POST /api/overrides` with `{playlistId, allScreens|screenIds, minutes}` starts a takeover.
- `DELETE /api/overrides/:id` stops a takeover.
- `POST /api/folders` with `{name}` creates a drop folder. `POST /api/settings` with `{foldersDir}` changes where drop folders live. `server/folders.js` holds the scanning logic.
- `POST /api/player/:id/music?hold=1|0` is what a player sends when an item that should pause the music starts or ends. `server/spotify.js` holds all the Spotify logic.
