#!/bin/bash
# T0.9d probe (temporary): per-process disk writes and reads each ~0.5 s, keyed to the wrangler.log line count.
log="$1"
declare -A prevw prevr
while true; do
  out=""
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    io=$(cat "$d/io" 2>/dev/null) || continue
    r=$(echo "$io" | awk '/^read_bytes/{print $2}'); w=$(echo "$io" | awk '/^write_bytes/{print $2}')
    c=$(cat "$d/comm" 2>/dev/null); s=$(awk '{print $3}' "$d/stat" 2>/dev/null)
    dw=$(( w - ${prevw[$p]:-$w} )); dr=$(( r - ${prevr[$p]:-$r} ))
    prevw[$p]=$w; prevr[$p]=$r
    if [ "$dw" -gt 65536 ] || [ "$dr" -gt 65536 ] || [ "$s" = D ]; then out+="  $p $c $s w=$((dw/1024))K r=$((dr/1024))K"$'\n'; fi
  done
  echo "== $(date +%T.%N) L=$(wc -l < "$log" 2>/dev/null) $(grep -E '^(Dirty|Writeback):' /proc/meminfo | tr -s ' ' | tr '\n' ' ') io:$(head -1 /proc/pressure/io 2>/dev/null)"
  printf '%s' "$out"
  sleep 0.4
done
