# Switching the TVs on and off

ENJOY Signage can switch the Google TVs on and off, by hand or on a schedule, the same way Google's TV remote app on a phone does. It's free: no Fully Kiosk PLUS licence is needed. Everything is on the **TV power** page of the admin panel (administrators only).

It works with Google TVs and Android TVs, such as the Kogan TVs. Computers running the player in Chrome can't be switched this way, so leave those without a TV.

---

## Before you start (once per TV)

1. **Find the TV's address.** On the TV: **Settings → Network & Internet →** your network. It looks like `192.168.1.50`.
2. **Give it a fixed address** (recommended). In your router, add a *DHCP reservation* for the TV, just as for the server. TVs usually keep the same address anyway, but a reservation makes sure, and the server finds each TV by its address.
3. **Turn on network standby** if the TV has it. Look in **Settings → System → Power & Energy**; it may be called *Network standby*, *Wake on LAN* or *Wake on Wi-Fi*. Without it, the TV can't hear the server while it's off. If the Google TV phone app can switch the TV on after it's been off overnight, it's fine.

## Pair each TV (once)

1. Switch the TV on, so you can see its screen.
2. In the admin panel, go to **TV power**, and click **Set up** next to the screen. (Or **TV power** on the screen's card on the Screens page.)
3. Type the TV's address and click **Pair**.
4. A 6-character code appears on the TV. Type it in and click **Finish pairing**. It's numbers and the letters A–F; capitals or not, either is fine. If you mistype it, you're asked again.

The TV now trusts this server. Pairing again is only needed if the TV is factory reset, or its address changes.

## Switching by hand

- **On** and **Off** buttons are on the TV power page, and on each screen's card on the Screens page.
- **All TVs on** and **All TVs off** at the top of the TV power page switch every paired TV at once.
- Each TV shows whether it's **On**, **In standby**, or **Can't reach the TV**, and which app is in front. If an app other than Fully Kiosk is in front, it's shown in orange, so you know the screen isn't showing the signage. The server checks every couple of minutes; **↻** asks the TV now.

Switching usually takes a second or two. Some TVs ignore the on-only and off-only buttons the server presses first. For those, it presses the normal power button instead, which takes about 10 seconds. It always checks first that the TV really is in the other state, so it can't switch a TV the wrong way.

## Power schedules

**TV power → + Power schedule.** Choose the TVs, the days, when to switch on and when to switch off. For example: *Sunday*, every Sunday, on at 8:00am, off at 1:30pm.

- A schedule only acts at its on and off moments. In between, anyone can still switch a TV by hand, and the schedule won't undo it.
- Where schedules overlap on the same TV, it's switched on when the first one starts and off when the last one ends.
- An off time earlier than the on time switches off the next day (overnight).
- **All day** switches the TVs on at 12am and off at midnight. If the next day is ticked too (e.g. Saturday and Sunday), they stay on through the night and switch off at the end of the last day.
- For a one-off event, set both dates to the same day.
- **If the server was off** when a TV should have switched (a power cut, an update), it catches up as soon as it starts again. Only the latest moment counts, so a server that was off all day doesn't switch TVs on and off again.
- **If a TV can't be reached**, the server tries again every minute for an hour, then gives up until the next moment and says so on the TV power page.
- A new or changed schedule only acts on moments after you saved it. Making a 8:00–1:30 schedule at 3pm won't switch anything off straight away.
- Schedules use the server computer's clock and time zone, like all other schedules.
- The TV power page shows each TV's next switch, e.g. *Switches off 1:30 PM*, and a week view of the schedules.

When a TV switches back on, Fully Kiosk carries on showing the signage. The screen's player keeps running while the TV is off.

## What the messages mean

| Message | What to do |
|---|---|
| *Can't reach the TV* / *Couldn't reach the TV at …* | It's switched off at the wall, its network sleeps in standby (see network standby, above), or its address has changed. |
| *isn't paired with this computer yet, or has forgotten it* | Click **Set up** → **Pair again**. TVs forget after a factory reset, and sometimes after a big software update. |
| *answered but refused the connection* | That address isn't a Google TV, or the TV's remote service is off. Check the address. |
| *didn't accept the code* | Pair again and type the new code carefully. |
| *Gave up switching … after trying for an hour* | The TV couldn't be reached for the whole hour. Check it's plugged in and on the network. |

## Where it's kept

The pairings, and the server's own security certificate that the TVs trust, are kept in `tvs.json` in the data folder. They aren't included in **Download backup**: a pairing belongs to this server, so after moving to a new computer, pair each TV again. The TV addresses and power schedules *are* in the backup.

---

## For troubleshooting: the command-line tool

`server/tvpower.js` talks to one TV directly, separately from the server. It has its own pairing, so pair it first. Open a terminal in the program folder:

- **Windows:** Start → ENJOY Signage → ENJOY Signage folder → `app` → right-click → **Open in Terminal**
- **Mac:** `cd ~/Library/Application\ Support/ENJOY\ Signage/app`
- **Ubuntu:** `cd /opt/church-signage`

| Command | What it does |
|---|---|
| `node server/tvpower.js pair 192.168.1.50` | Pairs this tool with the TV (a code appears on the TV) |
| `node server/tvpower.js status 192.168.1.50` | On or in standby, model, which app is in front, and how long the TV took to answer |
| `node server/tvpower.js on 192.168.1.50` / `off …` | Switches it, and says which button worked and how long it took |
| `node server/tvpower.js watch 192.168.1.50` | Checks every 5 minutes (`--every 30` for 30) and writes it down, also to `enjoy-signage-tv-watch.log` in your user folder. Handy for seeing whether a TV stays reachable overnight. |

Don't use `sudo` for these. The tool's pairing is kept in `.enjoy-signage-tv-remote.json` in your user folder.
