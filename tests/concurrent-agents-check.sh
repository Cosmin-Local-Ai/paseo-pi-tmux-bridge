#!/usr/bin/env bash
# Concurrent-agent check: two Pi agents under the SAME daemon, each spawning its
# own Amos subagent. Proves the per-agent tmux session isolation that the whole
# plugin exists to provide (the original bug: every agent shared one inherited
# TMUX_PANE).
#
# Requires a daemon on $PASEO_HOME with pi-tmux-bridge running.
set -uo pipefail

CHECKOUT=${CHECKOUT:?set CHECKOUT to a Paseo checkout (>=0.13.0), e.g. export CHECKOUT=$HOME/src/paseo}
PASEO_HOME=${PASEO_HOME:-/tmp/paseo-plugin-test-home}
WS=${WS:-/tmp/pi-bridge-ws}
PREFIX=${PREFIX:-paseo-}
EVIDENCE=${EVIDENCE:-/tmp/pi-tmux-bridge-concurrent-evidence.txt}
CLI=(npx --prefix "$CHECKOUT" tsx "$CHECKOUT/packages/cli/src/index.ts" --home "$PASEO_HOME")

: > "$EVIDENCE"
note() { echo "$@" | tee -a "$EVIDENCE"; }

mkdir -p "$WS"

spawn() { # $1 = tag
  local tag=$1
  "${CLI[@]}" -q run --provider pi --cwd "$WS" --title "concurrent-$tag" --no-wait \
    "Call the subagent tool exactly once with agent=\"worker\" and task=\"Print exactly ${tag}_OK as shell output, then stop. Do not use any other tool.\" Then reply DONE. If the subagent tool is unavailable, reply NO_TOOL." \
    2>/dev/null | tail -1
}

note "=== 1. create two Pi agents at once ==="
A=$(spawn A); B=$(spawn B)
note "agentA=$A"
note "agentB=$B"
[ -n "$A" ] && [ -n "$B" ] && [ "$A" != "$B" ] || { note "FAIL: need two distinct agent ids"; exit 1; }
SA="${PREFIX}${A}"; SB="${PREFIX}${B}"

note ""
note "=== 2. each agent must get its OWN tmux session + pane target ==="
sleep 5
for pair in "A:$SA" "B:$SB"; do
  tag=${pair%%:*}; sess=${pair#*:}
  pid=$(pgrep -x pi | while read -r p; do
    tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qx "PASEO_AGENT_ID=${pair#*:}" && echo "$p"
  done | head -1)
  # match the pi process by its session env instead of the agent id
  pid=$(pgrep -x pi | while read -r p; do
    tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qx "PASEO_TMUX_SESSION=$sess" && echo "$p"
  done | head -1)
  env_line=$(tr '\0' '\n' < "/proc/${pid:-0}/environ" 2>/dev/null | grep -E '^(TMUX|TMUX_PANE)=' | paste -sd' ' -)
  note "$tag session=$sess pi_pid=${pid:-none} $env_line"
done

note ""
note "=== 3. wait for BOTH sessions to reach 2 panes ==="
deadline=$((SECONDS + 240)); a2=0; b2=0
while [ $SECONDS -lt $deadline ]; do
  ca=$(tmux list-panes -t "$SA" 2>/dev/null | wc -l)
  cb=$(tmux list-panes -t "$SB" 2>/dev/null | wc -l)
  [ "$ca" -ge 2 ] && a2=1
  [ "$cb" -ge 2 ] && b2=1
  [ $a2 -eq 1 ] && [ $b2 -eq 1 ] && break
  sleep 3
done
sleep 6
note "panesA=$ca panesB=$cb secondPaneA=$a2 secondPaneB=$b2"

note ""
note "=== 4. pane sets must be disjoint (no cross-agent pane sharing) ==="
PA=$(tmux list-panes -t "$SA" -F '#{pane_id}' | sort | paste -sd, -)
PB=$(tmux list-panes -t "$SB" -F '#{pane_id}' | sort | paste -sd, -)
note "panesA=[$PA]"
note "panesB=[$PB]"
shared=$(comm -12 <(tmux list-panes -t "$SA" -F '#{pane_id}' | sort) \
                   <(tmux list-panes -t "$SB" -F '#{pane_id}' | sort) | paste -sd, -)
note "sharedPanes=[$shared]"

note ""
note "=== 5. each session's child pane runs its own pi ==="
for pair in "A:$SA" "B:$SB"; do
  tag=${pair%%:*}; sess=${pair#*:}
  note "$tag: $(tmux list-panes -t "$sess" -F '#{pane_id} cmd=#{pane_current_command} #{pane_width}x#{pane_height}' | paste -sd' | ' -)"
done
aOK=$(tmux capture-pane -p -t "$SA" -S -40 2>/dev/null | grep -c 'OK' || true)
bOK=$(tmux capture-pane -p -t "$SB" -S -40 2>/dev/null | grep -c 'OK' || true)
note "OKlinesA=$aOK OKlinesB=$bOK"

note ""
note "=== 6. verdict ==="
verdict=PASS
[ $a2 -eq 1 ] && [ $b2 -eq 1 ] || verdict=FAIL
[ -z "$shared" ] || verdict=FAIL
note "concurrent-agents-check: $verdict"

note ""
note "=== 7. cleanup ==="
"${CLI[@]}" archive --force "$A" 2>&1 | tail -1 | tee -a "$EVIDENCE"
"${CLI[@]}" archive --force "$B" 2>&1 | tail -1 | tee -a "$EVIDENCE"
sleep 4
note "leftoverA=$(tmux has-session -t "$SA" 2>/dev/null && echo 'STILL EXISTS' || echo 'gone')"
note "leftoverB=$(tmux has-session -t "$SB" 2>/dev/null && echo 'STILL EXISTS' || echo 'gone')"
note "paseoSessionsRemaining=$(tmux ls 2>/dev/null | grep -c "^${PREFIX}" || echo 0)"
