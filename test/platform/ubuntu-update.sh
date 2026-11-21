#!/usr/bin/env bash
# The updater on Ubuntu (sudo church-signage update) against the pretend GitHub. Needs ubuntu-install.sh first,
# in the same throwaway container.   sudo bash test/platform/ubuntu-update.sh
set -u
. "$(dirname "$0")/lib.sh"
. "$REPO/test/stand-ins/ubuntu/env.sh"
GH=4501; PORT=$(sed -n 's/^PORT=//p' /etc/church-signage/church-signage.env | tail -1)
cur=$(node -p "require('/opt/church-signage/package.json').version"); v="${cur%.*}.$((${cur##*.}+1))"
export ENJOY_SIGNAGE_UPDATE_API=http://127.0.0.1:$GH ENJOY_SIGNAGE_UPDATE_RAW=http://127.0.0.1:$GH/raw ENJOY_SIGNAGE_UPDATE_CODELOAD=http://127.0.0.1:$GH/codeload
node "$REPO/test/mocks/github.js" $GH "$v" & gh=$!; sleep 1.5
church-signage update --yes | sed 's/^/    /'
kill $gh
check "now on $v" test "$(node -p "require('/opt/church-signage/package.json').version")" = "$v"
check "server running" wait_for answers 40 "$PORT"
summary
