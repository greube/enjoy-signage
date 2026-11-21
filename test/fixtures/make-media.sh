#!/usr/bin/env bash
# Makes the test video clips (VP9/WebM: the Chromium that Playwright ships can't play H.264).
#   bash test/fixtures/make-media.sh          short clips only (seconds)
#   bash test/fixtures/make-media.sh --long   also the 40 s, ~160 MB clip used by the power-cut tests (about a minute)
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/.work/media"
mkdir -p "$OUT"
cd "$OUT"
vp9() { ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=$1:rate=30" -t "$2" ${3:+-vf $3} -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v "$4" ${5:+-minrate $5} -row-mt 1 "$6"; }
[ -f v7.webm ] || vp9 1280x720 7 '' 3M '' v7.webm        # 7 s
[ -f v5.webm ] || vp9 1280x720 5 hue=h=200 3M '' v5.webm # 5 s, different colour
[ -f a.webm ] || vp9 1920x1080 6 '' 8M '' a.webm         # 6 s, 1080p
if [ "${1:-}" = "--long" ] && [ ! -f long.webm ]; then
  vp9 1920x1080 40 '' 50M 45M long.webm                  # 40 s, ~160 MB: big enough that a crash happens mid-download
fi
for f in *.webm; do printf '%-10s %6s  %ss\n' "$f" "$(du -h "$f" | cut -f1)" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"; done
