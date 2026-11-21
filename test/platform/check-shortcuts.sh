#!/usr/bin/env bash
# Reads back the Windows shortcuts (.lnk) that the installer writes, with an independent parser (LnkParse3,
# fetched from GitHub into test/.work), and prints what Windows would see: target, arguments, folder, icon.
# With no folder it writes a few fresh ones (with an accented user name) to test/.work/lnk first.
#   bash test/platform/check-shortcuts.sh [FOLDER]
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LP="$REPO/test/.work/LnkParse3"
[ -d "$LP" ] || git clone -q --depth 1 https://github.com/Matmaus/LnkParse3 "$LP"
DIR=${1:-}
if [ -z "$DIR" ]; then # make some fresh ones without installing
  DIR="$REPO/test/.work/lnk"; rm -rf "$DIR"; mkdir -p "$DIR"
  node -e "
    const s = require('$REPO/platform/windows/shortcut.js');
    const w = s.write;
    w('$DIR/ENJOY Signage.lnk', { target: 'C:\\\\Program Files\\\\nodejs\\\\node.exe', args: '\"C:\\\\Users\\\\Église\\\\AppData\\\\Local\\\\ENJOY Signage\\\\app\\\\platform\\\\windows\\\\enjoy.js\" open', workingDir: 'C:\\\\Users\\\\Église\\\\AppData\\\\Local\\\\ENJOY Signage', icon: 'C:\\\\Users\\\\Église\\\\AppData\\\\Local\\\\ENJOY Signage\\\\enjoy.ico', description: 'Open the ENJOY Signage admin panel', show: 'minimized' });
  "
fi
find "$DIR" -name '*.lnk' -print0 | while IFS= read -r -d '' f; do
  echo "== ${f#$DIR/}"
  PYTHONPATH="$LP" python3 -I -c "
import sys, json
sys.path.insert(0, '$LP')
import LnkParse3
with open(sys.argv[1], 'rb') as fh: j = LnkParse3.lnk_file(fh).get_json()
d = j.get('data', {}); h = j.get('header', {})
items = [i.get('volume_name', '').rstrip(chr(92)) or i.get('primary_name') for i in (j.get('target', {}).get('items') or [])]
print('  ', 'target:     ', chr(92).join(str(x) for x in items if x))
for k, label in [('command_line_arguments','arguments:  '), ('working_directory','start in:   '), ('icon_location','icon:       '), ('description','comment:    ')]:
    print('  ', label, d.get(k, '—'))
print('  ', 'window:     ', h.get('windowstyle'))
" "$f"
done
