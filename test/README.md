# Test tools

Tools for checking ENJOY Signage by hand before a release. **Nothing here is part of the app.** Installs and
updates never include this folder: the installers copy named folders only, and `.gitattributes` keeps `test/`
out of GitHub's zip and tarball downloads, which are what people install from and what the updater fetches.

Everything writes its scratch files to `test/.work/`, which git ignores. Run everything from the repository's
top folder. The tools are for Linux, which is where the real-browser and stand-in tests were built. They mostly
work on a Mac too.

## What you need

- Node 18 or newer. The app and most tools need nothing else.
- **For the browser tests only:** Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
  If `require('playwright')` doesn't find it, set `PLAYWRIGHT=/path/to/node_modules/playwright`.
- **For the test videos:** ffmpeg. Run `bash test/fixtures/make-media.sh` once, adding `--long` for the 40 s
  clip that the power-cut tests use. The clips are VP9/WebM, because Playwright's Chromium has no H.264.

## The tools

| Run | What it checks | Time |
|---|---|---|
| `node test/browser/measure-sync.js [secs]` | Four TVs on one playlist, with one on a slow network (100 ms each way) and one on a slow CPU. Reports how far apart they change items and how closely their videos match. Expect a few ms. `--unmeasured` starts with no video lengths, as right after upgrading. | 75 s |
| `node test/browser/sync-scenarios.js` | Synced playback cases: a room (different playlists, same beat), a TV switched on late, a schedule starting on the minute, a takeover, a play-once schedule, and sync turned off. | 3 min |
| `node test/browser/play-once.js` | Play-once playlists: from a schedule, after a server restart (it shouldn't replay), after moving the start time (it should), as a one-video takeover (steps aside after one play), and as a screen's default (still loops). | 4 min |
| `node test/browser/power-cut.js` | The server PC loses power mid-video and comes back. Then a refresh, then a browser restart with its cache kept. Expected: the player recovers within about a second of the server returning. `--original` uses the non-synced engine. | 2 min |
| `node test/browser/stuck-video.js` | A browser whose download of a video is stuck. The player should notice and reload it from a fresh address, before and after F5. | 1 min |
| `bash test/mocks/spotify-scenarios.sh` | Resuming music after a video, against a pretend Spotify whose iPad stays active, goes inactive, falls asleep and wakes, or disappears. Includes the "keep trying" toggle turned off. One case: `node test/mocks/spotify-drive.js asleep`. | 6 min |
| `node test/browser/tv-power.js` | TV power end to end, with two pretend TVs (one ignores the on/off-only keys): pairing in the admin panel with a mistyped code first, On/Off, All TVs on/off, a power schedule switching both TVs on and off on the minute, an unplugged TV, forgetting a TV. | 3 min |
| `node test/mocks/tv-schedules.js` | Power schedule timing with a pretend clock: a normal Sunday, switching by hand in between, overlaps, overnight, a server that was off at the moment (catch-up), new schedules not acting on the past, an unreachable TV (retries, then gives up), and Melbourne daylight saving. | 2 s |
| `bash test/platform/windows-install.sh` | The Windows install on Linux, with stand-in Windows commands and a throwaway profile. Covers icons, Start menu, start at sign-in, the Apps-list entry, restart, crash recovery, stop, open and uninstall. | 30 s |
| `bash test/platform/check-shortcuts.sh [folder]` | Reads the `.lnk` shortcuts back with an independent parser (LnkParse3, fetched from GitHub) and shows what Windows would see. | 5 s |
| `bash test/platform/mac-install.sh` | The same for the Mac version, with a stand-in launchd that really runs the LaunchAgent. | 40 s |
| `bash test/platform/update-test.sh [windows\|mac]` | The updater against a pretend GitHub: a normal update, 504s, a codeload fallback, a cut-off download, a private repo with and without a token, GitHub down, a broken new version (rolled back), and `--check`. | 3 min |
| `sudo bash test/platform/ubuntu-install.sh`, then `ubuntu-update.sh` | The real `install-ubuntu.sh` and `church-signage` command, with stand-ins for systemd, ufw and timedatectl. **Only in a throwaway container or VM**, because it writes to `/opt`, `/etc` and `/var/lib`. | 30 s |

Each browser test prints a timeline of what each TV showed, with the expected result next to it. The platform
scripts print ✓ or ✗ for each check and exit non-zero on any ✗.

## The parts, if you're building a new test

- `common.js` has helpers to start the real server on a port with its own data folder, sign in as an
  administrator through the first-run setup, write a `db.json`, and find Playwright and the test clips.
  `SERVER_LOG=1` shows the server's output.
- `browser/sync-content.js` provides shared test playlists, and `INSTRUMENT`, which runs in each player page and
  records when each item appeared (`window.__ev`) and video positions (`window.__vs`).
- `net/power-cut-relay.js LISTEN SERVER CONTROL` sits between browser and server. `GET :CONTROL/crash` makes
  every connection go silent, like a PC that lost power, and `/up` lets new ones through. Options are in its header.
- `net/delay-proxy.js LISTEN SERVER MS` adds the same delay in both directions. (Chrome's own network throttling
  is one-sided, which skews clock-sync results.)
- `mocks/spotify.js PORT MODE` is a pretend Spotify. Point the server at it with `SPOTIFY_ACCOUNTS_BASE` and
  `SPOTIFY_API_BASE`.
- `mocks/tv.js HOST CONTROL-PORT` is a pretend Google TV on HOST:6466/6467 (use 127.0.0.2, 127.0.0.3 … for several). `GET :CONTROL-PORT/code` gives the pairing code it's showing; `/mode?unplugged=1`, `ignoreWake`, `noReport` and `delay` change how it behaves. The androidtvremote2 library (used by Home Assistant) pairs with it and controls it, which is how it was checked against the real protocol.
- `mocks/github.js PORT [VERSION]` is a pretend GitHub that serves the working tree as a newer version. Point the
  updater at it with `ENJOY_SIGNAGE_UPDATE_API`, `ENJOY_SIGNAGE_UPDATE_RAW` and `ENJOY_SIGNAGE_UPDATE_CODELOAD`.
  Failure switches are listed in its header.
- `stand-ins/windows/env.sh` and `stand-ins/mac/env.sh` point `PATH`, `HOME` or `USERPROFILE`/`APPDATA`, and the
  app's `ENJOY_SIGNAGE_TEST_WIN`/`_MAC` switch at stand-in OS commands that log every call. `stand-ins/ubuntu/env.sh`
  does the same for root on Ubuntu without systemd.
