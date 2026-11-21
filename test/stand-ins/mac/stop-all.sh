#!/usr/bin/env bash
# Stops every agent the stand-in launchctl started.
. "$(dirname "$0")/env.sh" && launchctl reset
