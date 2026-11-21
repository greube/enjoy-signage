printf '%s %s' "$(date +%H:%M:%S)" "$1" >> "${UBULOG:-/dev/null}"; shift
for a in "$@"; do printf ' [%s]' "$a" >> "${UBULOG:-/dev/null}"; done; echo >> "${UBULOG:-/dev/null}"
