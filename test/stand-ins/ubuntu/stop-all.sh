#!/usr/bin/env bash
# Stops every service the stand-in systemctl started.
for p in /run/systemd-stand-in/*.pid; do [ -f "$p" ] && kill -TERM -- "-$(cat "$p")" 2>/dev/null; rm -f "$p"; done; true
