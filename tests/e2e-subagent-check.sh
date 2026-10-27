#!/usr/bin/env bash
# Phase C end-to-end check: a real Paseo Pi agent, running under the plugin,
# calls the Amos `subagent` tool and really produces a second pane inside its
# own bridge tmux session.
#
# Requires a daemon already running on $PASEO_HOME with pi-tmux-bridge enabled.
# Everything it creates is cleaned up (the agent is archived, which triggers the
# plugin's own kill-session path).
set -uo pipefail

CHECKOUT=${CHECKOUT:?set CHECKOUT to a Paseo checkout (>=0.13.0), e.g. export CHECKOUT=$HOME/src/paseo}
PASEO_HOME=${PASEO_HOME:-/tmp/paseo-plugin-test-home}
WS=${WS:-/tmp/pi-bridge-ws}
PREFIX=${PREFIX:-paseo-}
AGENT_TITLE=${AGENT_TITLE:-bridge-e2e}
EVIDENCE=${EVIDENCE:-/tmp/pi-tmux-bridge-e2e-evidence.txt}
CLI=(npx --prefix "$CHECKOUT" tsx "$CHECKOUT/packages/cli/src/index.ts" --home "$PASEO_HOME")

: > "$EVIDENCE"
note() { echo "$@" | tee -a "$EVIDENCE"; }

note "=== 1. create a Pi agent ==="
AGENT_ID=$("${CLI[@]}" -q run --provider pi --cwd "$WS" --title "$AGENT_TITLE" --no-wait \
  "Reply with exactly READY. Do not use any tools." 2>/dev/null | tail -1)
note "agentId=$AGENT_ID"
if [ -z "$AGENT_ID" ]; then note "FAIL: no agent id"; exit 1; fi
SESSION="${PREFIX}${AGENT_ID}"

# The agent process is what carries the injected env, so read it from /proc.
sleep 4
note ""
note "=== 2. env of the agent's pi process ==="
# The installed `pi` launcher shows up in `ps` as just `pi`, so match on the
# process name and then confirm identity through /proc/<pid>/environ.
PI_PID=$(pgrep -x pi | while read -r p; do
  if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qx "PASEO_AGENT_ID=$AGENT_ID"; then echo "$p"; fi
done | head -1)
note "pi pid=$PI_PID"
if [ -n "$PI_PID" ]; then
  tr '\0' '\n' < "/proc/$PI_PID/environ" 2>/dev/null \
    | grep -E '^(TMUX|TMUX_PANE|PASEO_TMUX_SESSION|PI_SUBAGENT_SHELL_READY_DELAY_MS)=' | tee -a "$EVIDENCE"
fi

note ""
note "=== 3. attach terminal created by the plugin (daemon plugin log) ==="
"${CLI[@]}" plugin logs pi-tmux-bridge 2>/dev/null | grep -E "$AGENT_ID" | tail -4 | tee -a "$EVIDENCE" || true

note ""
note "=== 4. watch for a second pane while the agent spawns a subagent ==="
(
  for _ in $(seq 1 180); do
    count=$(tmux list-panes -t "$SESSION" 2>/dev/null | wc -l)
    if [ "$count" -ge 2 ]; then
      # Amos waits PI_SUBAGENT_SHELL_READY_DELAY_MS before typing the launch
      # command into a fresh pane, so sample after that window.
      sleep 6
      {
        echo "--- second pane detected at $(date -u +%H:%M:%S) ---"
        tmux list-panes -t "$SESSION" -F \
          '#{pane_id} idx=#{pane_index} cmd=#{pane_current_command} pid=#{pane_pid} #{pane_width}x#{pane_height} active=#{pane_active}'
        echo "--- window layout ---"
        tmux list-windows -t "$SESSION" -F '#{window_name} layout=#{window_layout}'
        for row in $(tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_pid}'); do :; done
        echo "--- process tree of each pane (recursive) ---"
        PS_SNAPSHOT=$(ps -eo pid=,ppid=,args=)
        tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_pid}' | while read -r pane pid; do
          echo "pane $pane (shell pid $pid):"
          DESCENDANTS="$pid"
          for _ in 1 2 3 4; do
            CHILDREN=$(echo "$PS_SNAPSHOT" | awk -v list="$DESCENDANTS" '
              BEGIN { split(list, a, " "); for (i in a) want[a[i]] = 1 }
              want[$2] { print $1 }')
            [ -z "$CHILDREN" ] && break
            DESCENDANTS="$DESCENDANTS $CHILDREN"
          done
          echo "$PS_SNAPSHOT" | awk -v list="$DESCENDANTS" '
            BEGIN { split(list, a, " "); for (i in a) want[a[i]] = 1 }
            want[$1] && $1 != a[1] { printf "    %s %s\n", $1, substr($0, index($0, $3)) }'
        done
      } >> "$EVIDENCE"
      # keep watching so we also record the subagent actually doing the work
      for _ in $(seq 1 90); do
        for pane in $(tmux list-panes -t "$SESSION" -F '#{pane_id}'); do
          # Match the command's own output line, not the task text that Amos
          # prints into the pane.
          if tmux capture-pane -p -t "$pane" -S -300 2>/dev/null | grep -Eq '^[[:space:]]*BRIDGE_OK[[:space:]]*$'; then
            echo "--- BRIDGE_OK output line seen in pane $pane at $(date -u +%H:%M:%S) ---" >> "$EVIDENCE"
            tmux capture-pane -p -t "$pane" -S -300 | grep -n -B2 -A1 -E '^[[:space:]]*BRIDGE_OK[[:space:]]*$' | head -12 >> "$EVIDENCE"
            exit 0
          fi
        done
        sleep 2
      done
      exit 0
    fi
    sleep 1
  done
) &
WATCHER=$!

"${CLI[@]}" send "$AGENT_ID" \
  'Use the subagent tool exactly once with agent="worker" and task="Run the shell command echo BRIDGE_OK with the bash tool, then stop." Do not do the work yourself.' \
  2>&1 | tail -2 | tee -a "$EVIDENCE"
wait "$WATCHER"

note ""
note "=== 5. verdict ==="
PANES_SEEN=$(grep -c "second pane detected" "$EVIDENCE")
PI_IN_PANE=$(sed -n '/process tree of each pane/,/BRIDGE_OK\|=== 5/p' "$EVIDENCE" | grep -cE '[[:space:]]pi( |$)')
BRIDGE=$(grep -c "BRIDGE_OK output line seen in pane" "$EVIDENCE")
note "secondPaneObserved=$PANES_SEEN piProcessObserved=$PI_IN_PANE bridgeOkObserved=$BRIDGE"

note ""
note "=== 6. cleanup: archive the agent (drives the plugin kill path) ==="
"${CLI[@]}" archive --force "$AGENT_ID" 2>&1 | tail -2 | tee -a "$EVIDENCE"
sleep 3
if tmux has-session -t "$SESSION" 2>/dev/null; then
  note "FAIL: tmux session $SESSION still exists"
  RESULT=FAIL
else
  note "tmux session $SESSION is gone"
  RESULT=PASS
fi

if [ "$PANES_SEEN" -ge 1 ] && [ "$BRIDGE" -ge 1 ] && [ "$RESULT" = "PASS" ]; then
  note "e2e-subagent-check: PASS"
  exit 0
fi
note "e2e-subagent-check: PARTIAL (see counters above)"
exit 1
