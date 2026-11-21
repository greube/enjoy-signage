printf '%s %s' "$(date +%H:%M:%S)" "$1" >> "${MACLOG:-/dev/null}"; shift
for a in "$@"; do printf ' [%s]' "$a" >> "${MACLOG:-/dev/null}"; done; echo >> "${MACLOG:-/dev/null}"
