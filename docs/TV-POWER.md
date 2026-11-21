# Switching the TVs on and off (testing)

ENJOY Signage is learning to switch the Google TVs on and off from the server, the same way Google's TV remote app on a phone does. It's free: no Fully Kiosk PLUS licence is needed.

**Right now this is a test tool,** run by typing commands, so it can be tried on the real TVs before it goes into the admin panel. Nothing in the admin panel or on the screens changes.

---

## Before you start

- The TV and the server must be on the same network.
- Find the TV's address: on the TV, **Settings → Network & Internet →** your network. It looks like `192.168.1.50`. Use your own TV's address in place of that below.
- Turn on the TV's network standby setting if it has one. Look in **Settings → System → Power & Energy** (the name varies, e.g. *Network standby*, *Wake on LAN* or *Wake on Wi-Fi*). Without it, the TV can't hear the server while it's off.

## Open a terminal in the program folder

**Windows:** Start → ENJOY Signage → **ENJOY Signage folder**, open the **`app`** folder, right-click an empty space, choose **Open in Terminal**. Or, in any terminal:

```
cd "$env:LOCALAPPDATA\ENJOY Signage\app"
```

**Mac:** open Terminal and type:

```
cd ~/Library/Application\ Support/ENJOY\ Signage/app
```

**Ubuntu:** open a terminal and type:

```
cd /opt/church-signage
```

Don't use `sudo` for these commands: the pairing is remembered for the person who ran `pair`.

## Pair each TV (once)

```
node server/tvpower.js pair 192.168.1.50
```

A 6-character code appears on the TV. Type it in and press Enter. (It's letters A–F and numbers. Capitals or not, either is fine.) The TV now trusts this computer.

## Then

| Command | What it does |
|---|---|
| `node server/tvpower.js status 192.168.1.50` | Says whether the TV is on or in standby, its model, and which app is in front (Fully Kiosk is `de.ozerov.fully`) |
| `node server/tvpower.js off 192.168.1.50` | Puts the TV into standby |
| `node server/tvpower.js on 192.168.1.50` | Switches it back on |
| `node server/tvpower.js watch 192.168.1.50` | Checks every 5 minutes and writes down what it finds. Leave the window open, and press Ctrl+C to stop. Add `--every 30` for every 30 minutes. |

`on` and `off` say how long they took and which button they used. *WAKEUP* and *SLEEP* are on-only and off-only buttons. *POWER* means the TV ignored those, so the tool pressed the normal power button instead, after first checking the TV was in the opposite state, so it can't switch the wrong way.

`watch` also saves what it finds to `enjoy-signage-tv-watch.log` in your user folder, so you can read it in the morning.

## What the messages mean

| Message | What to do |
|---|---|
| *isn't paired with this computer yet, or has forgotten it* | Run `pair` again. TVs forget after a factory reset, and sometimes after a big software update. |
| *Couldn't reach the TV* | It's switched off at the wall, its network goes to sleep in standby (see network standby, above), or its address has changed. |
| *answered but refused the connection* | That address isn't a Google TV, or the TV's remote service is off. Check the address. |
| *didn't accept the code* | Run `pair` again and type the new code carefully. |
| *Lost contact with the TV part-way through* | Run `status` to see whether it switched. |

## Good to know

- Pairing is per computer. The details are kept in `.enjoy-signage-tv-remote.json` in your user folder. If you delete that file, pair the TVs again.
- If a TV's address changes, pair it again on the new address. Giving each TV a fixed address in the router (a *DHCP reservation*) avoids this.
- When this goes into the admin panel, each TV will be paired again there, once.
