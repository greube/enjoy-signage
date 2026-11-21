#!/usr/bin/env bash
# Runs every mock-Spotify scenario (about 6 minutes). Expected results:
#   normal → playing at the first try · inactive → playing (by moving playback to the iPad)
#   asleep → playing once it wakes (WAKE=20) · gone → not playing, with a "press play on the iPad" problem after ≈3½ min
#   asleep with KEEP=0 → not playing: one try only, then the problem message
cd "$(dirname "$0")/../.."
run() { echo; echo "===== $*"; env "$@" 2>&1 | grep -E 'RESULT|\[server\]|▶|⏸|---'; }
run node test/mocks/spotify-drive.js normal 8 15
run node test/mocks/spotify-drive.js inactive 8 20
run WAKE=20 node test/mocks/spotify-drive.js asleep 8 45
run KEEP=0 WAKE=20 node test/mocks/spotify-drive.js asleep 8 30
run node test/mocks/spotify-drive.js gone 8 230
