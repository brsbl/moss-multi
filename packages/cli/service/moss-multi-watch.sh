#!/bin/sh
# Runs `moss-multi watch <workspace>` for the launchd agent or the systemd user unit (docs/SYNC.md), with the server
# and agent key from an env file only its owner can read. Exit 78 (a bad env file) is not worth restarting for.
#   moss-multi-watch.sh <env file> <workspace>
# MOSS_MULTI_CLI (default ~/.local/lib/moss-multi/moss-multi.mjs) and MOSS_MULTI_NODE (default node) override paths.
set -eu
if [ "$#" -ne 2 ]; then
  echo "usage: moss-multi-watch.sh <env file> <workspace>" >&2
  exit 64
fi
env_file=$1
workspace=$2
case "$env_file" in /*) ;; *) env_file=./$env_file ;; esac
if [ ! -f "$env_file" ]; then
  echo "moss-multi-watch: no env file at $env_file" >&2
  exit 78
fi
mode=$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file")
case "$mode" in
  600 | 400) ;;
  *)
    echo "moss-multi-watch: $env_file holds the agent key but has mode $mode; chmod 600 it" >&2
    exit 78
    ;;
esac
set -a
. "$env_file"
set +a
MOSS_MULTI_NO_OPEN=1
export MOSS_MULTI_NO_OPEN
exec "${MOSS_MULTI_NODE:-node}" "${MOSS_MULTI_CLI:-$HOME/.local/lib/moss-multi/moss-multi.mjs}" watch "$workspace"
