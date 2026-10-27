
# VERIFICATION

Everything below was run in this environment. Commands and output are copied from real runs.
Nothing here is claimed without the output that backs it.

Environment: `tmux 3.6`, node `v24.21.0`, npm (no pnpm), uid `1000`, default tmux socket
`/tmp/tmux-1000/default`, `pi` at `/usr/local/share/npm-global/bin/pi`, Paseo checkout at
`<paseo-checkout>` (clean `v0.13.2`, detached HEAD `d294115`).

## Files created

All under `<plugin-dir>/` — nothing was written outside this folder.

```text
paseo-plugin.json   index.server.ts    index.client.tsx
shared/contracts.ts server/tmux.ts     server/bookkeeping.ts
client/panel.tsx    client/settings.tsx
tsconfig.json       README.md          VERIFICATION.md
tests/mechanism-spike.mjs  tests/unit.test.ts  tests/compile-check.mjs  tests/e2e-subagent-check.sh
```

Checkout integrity check after all work (must stay untouched, `stash@{0}` must survive):

```text
$ cd <paseo-checkout> && git status --short | head -5; git stash list; git log --oneline -1
stash@{0}: On (no branch): chatgpt-attempt: in-daemon pi-interactive-subagents adapter + registry registration
d294115 chore(release): cut 0.13.2
```

`git status --short` printed nothing (clean). `stash@{0}` intact. `~/.paseo` was never
touched — every daemon invocation used `--home /tmp/paseo-plugin-test-home`.

---

## Phase A — mechanism proof (PASS)

`tests/mechanism-spike.mjs`, run as `node tests/mechanism-spike.mjs both`.

It creates its own session `paseo-spike-<pid>` with a live placeholder pane, spawns
`pi --mode rpc --session-dir <tmp> --extension .../pi-extension/subagents/index.ts` with the
injected env, sends a JSONL `prompt` asking Pi to call the `subagent` tool with `agent="worker"`,
then asserts a second pane, a real `pi` process inside it, and parent-side tool events.

### A.1 positive (TMUX injected) — PASS

```text
[spike 8187] session=paseo-spike-8187 placeholderPane=%15 hostPanePid=8199 socket=/tmp/tmux-1000/default
[spike 8187] spawned pi pid=8210 TMUX=/tmp/tmux-1000/default,8187,0 TMUX_PANE=%15
[spike 8187] sent prompt asking pi to call the subagent tool
[spike 8187] protocol: tool_execution_start toolName=subagent

--- tmux evidence: list-panes -F ---
%15 0 bash 8199 pi-recovery-test
%16 1 bash 8263 pi-recovery-test
[spike 8187] second pane: %16 cmd=bash pid=8263
[spike 8187] protocol: tool_execution_end toolName=subagent
[spike 8187] paneStillThere=true pane_current_command=bash piProcessInPaneTree=true piTuiVisibleInCapture=true sawSPIKE_OK=true sentinel=false

--- process tree under the subagent pane ---
  7640 bash /tmp/pi-tmux-bridge-spike-ENWKB1/sessions/artifacts/.../subagent-scripts/worker-00af873d.sh
  7641 pi
[spike 8187] parent tool_execution events for toolName=subagent: start=1 end=1

--- parent tool_execution_end for the subagent tool (truncated) ---
{"type":"tool_execution_end","toolCallId":"call_3b678696de8248208b935723","toolName":"subagent",
 "result":{"content":[{"type":"text","text":"Sub-agent \"worker\" launched and is now running in the background..."}],
 "details":{"id":"aad93c5a","name":"worker","task":"Run the shell command `echo SPIKE_OK` using the bash tool, then stop.",
 "agent":"worker","sessionFile":"/home/agent/.pi/agent/sessions/--tmp-pi-tmux-bridge-spike-UGpdTQ--/...jsonl",
 "launchScriptFile":"/tmp/pi-tmux-bridge-spike-UGpdTQ/sessions/artifacts/.../worker-aad93c5a.sh","status":"started"}},
 "isError":false,"durationMs":2038}

--- verdict ---
POSITIVE (TMUX injected): PASS
```

The pane capture also showed the child Pi TUI rendering with the `worker` role and the task file,
i.e. Amos built a real subagent launch inside our session using only the fabricated env.
`durationMs: 2038` matches `PI_SUBAGENT_SHELL_READY_DELAY_MS=2000`, confirming that env var reached
Amos.

### A.2 negative control (TMUX unset) — PASS

```text
[spike 8187] spawned pi pid=8441 TMUX=<unset> TMUX_PANE=<unset>
[spike 8187] protocol: tool_execution_start toolName=subagent
[spike 8187] protocol: tool_execution_end toolName=subagent

--- tmux evidence: list-panes -F ---
%17 0 bash 8430 pi-recovery-test

--- Amos tmux refusal, as seen on the parent protocol stream ---
{"type":"tool_execution_end","toolCallId":"call_5c2af95d34894012b7689c86","toolName":"subagent",
 "result":{"content":[{"type":"text","text":"Subagents require tmux. Start pi inside tmux (`tmux new -A -s pi 'pi'`)."}],
 "details":{"error":"tmux not available"}},"isError":false,"durationMs":1}
[spike 8187] amos refused tmux=true paneCount=1

--- verdict ---
NEGATIVE (TMUX unset): PASS
```

Only one pane existed; no split happened. This proves the injected env is the thing that makes it
work, not incidental tmux reachability.

```text
PHASE A SUMMARY
positive  PASS
negative  PASS
overall: PASS
```

### Deviation from the SPEC in Phase A (deliberate, documented)

The SPEC's spike sketch used `pi --mode rpc --no-session`. Amos's `subagent` tool hard-requires a
session file (`index.ts:1795` → `"Error: no session file. Start pi with a persistent session to use
subagents."`), so `--no-session` makes the spike fail for an unrelated reason. The spike instead
uses `--session-dir <tmp dir under /tmp>`, which keeps sessions ephemeral inside a scratch dir.
This affects only the spike; the plugin itself never sets `--no-session`.

### Why the spike walks the process tree instead of trusting `pane_current_command`

First spike attempt asserted `pane_current_command == "pi"` and failed: tmux reported `bash`.
Cause: Amos launches the child through a non-interactive bash script (`sendLongCommand`), so the
foreground process-group leader of the pane tty is that script's `bash`, and tmux reports the
leader. The tree walk shows `7641 pi` plainly. This is an environment fact, not a mechanism
failure — but it means the panel's `pane_current_command` column will usually read `bash` for
Amos subagents, not `pi`.

---

## Phase B — static validation (PASS)

### B.1 typecheck

```text
$ <paseo-checkout>/node_modules/.bin/tsc --noEmit -p tsconfig.json
$ echo $?
0
```

`tsconfig.json` maps `@getpaseo/plugin`, `@getpaseo/plugin/server`, `@getpaseo/plugin/client`,
`@getpaseo/plugin/client/ui`, `@getpaseo/client` and `@getpaseo/protocol/*` to the checkout's
`packages/*/src` (read-only; the checkout was not modified and the plugin was not added to its
workspace), plus `zod`/`react`/`react-native` from the checkout's `node_modules`.

Two settings were needed and are worth knowing:
- `lib: ["ES2023","DOM"]` — the client package's own tsconfig uses DOM too; `AbortSignal.throwIfAborted`
  in `packages/client/src/daemon-client.ts:6262` is otherwise unresolved.
- a `paths` entry for the SDK's own ambient declaration
  `packages/plugin/src/client/use-sync-external-store.d.ts`, otherwise mapping to `src` produces
  TS7016/TS7006 inside Paseo's own files.

### B.2 unit tests

```text
$ node --test tests/unit.test.ts
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

Covered: session-name derivation and rejection of unsafe names; the `isOwnSessionName` kill guard;
the provider/purpose guard; `buildInjectedEnv` spreading the base env (and not mutating it) and
overwriting an inherited `TMUX`/`TMUX_PANE`; the fail-soft env (`TMUX === ""` and falsy);
`$SHELL` substitution and the `tail -f /dev/null` fallback; every argv builder; capture-line
clamping; output parsers rejecting malformed input; `TmuxClient.ensureSession` create / reuse
(never `kill-session`, re-reads the pane id) / placeholder fallback / fail-soft on repeated
`new-session` failure / refusing an unsafe name before touching tmux / pane-id and socket failure
stages; pane-op guards; and the bookkeeping map's terminal dedupe + resume persistence.

### B.3 Paseo's own plugin compiler

`tests/compile-check.mjs` calls the checkout's real `compilePlugin()`
(`packages/server/src/server/plugins/compiler.ts`), which enforces the SDK import boundaries and
produces the exact bundles the daemon loads.

```text
$ cd <paseo-checkout> && npx tsx <plugin-dir>/tests/compile-check.mjs
{
  "serverBundleBytes": 28114,
  "clientBundleBytes": 25260,
  "serverHasContribute": true,
  "serverRegistersSessionOpen": true,
  "serverHasKillGuard": true,
  "clientHasAgentPanel": true,
  "clientHasRpcNames": ["session-status","list-panes","capture-pane","select-pane","kill-pane","open-attach-terminal"],
  "serverHasRpcNames": ["session-status","list-panes","capture-pane","select-pane","kill-pane","open-attach-terminal"]
}
compile-check: PASS
```

This caught a real bug that `tsc` hid: I imported `./client/panel.ts` while the file is `panel.tsx`.
TypeScript mapped it silently; esbuild failed with `Could not resolve "./client/panel.ts"`. Fixed to
explicit `.tsx`.

Note on import boundaries: `@getpaseo/client` is **not** in `PLUGIN_SDK_SPECIFIERS`
(`packages/server/src/server/plugins/plugin-sdk-specifiers.ts`), so the plugin never imports it —
`PaseoApi` is obtained structurally as `PluginHookContext["paseo"]`. `shared/` imports into the
server bundle are legal (`compiler.ts:135` treats `shared` as allowed for both targets).

---

## Phase C — real daemon (PASS)

Daemon run from the checkout against an isolated home, never the real one.

```text
$ npx tsx packages/cli/src/index.ts daemon start --home /tmp/paseo-plugin-test-home
Started: PID 14042, listening on 127.0.0.1:6767
Logs: /tmp/paseo-plugin-test-home/daemon.log

$ npx tsx packages/cli/src/index.ts --home /tmp/paseo-plugin-test-home plugin install <plugin-dir>
Trusting plugin code: server code and preparation commands run unsandboxed on the daemon host...
PLUGIN                STATUS      ENABLED   SOURCE                                     ...
pi-tmux-bridge        disabled    yes       <plugin-dir>

$ npx tsx packages/cli/src/index.ts --home /tmp/paseo-plugin-test-home daemon config set pluginsEnabled true
$ npx tsx packages/cli/src/index.ts --home /tmp/paseo-plugin-test-home reload
... Run: paseo daemon restart --home "/tmp/paseo-plugin-test-home"
$ npx tsx packages/cli/src/index.ts --home /tmp/paseo-plugin-test-home plugin ls
pi-tmux-bridge        running     yes       <plugin-dir>
```

`pluginsEnabled` defaults to `false` (`packages/server/src/server/config.ts:637`), so the first
`plugin reload` failed with `Error: Request failed: Plugins are globally disabled`. Setting it and
restarting the daemon made the plugin load:

```text
$ npx tsx packages/cli/src/index.ts --home /tmp/paseo-plugin-test-home plugin logs pi-tmux-bridge
2026-10-27T19:39:29.513Z  stdout  [paseo] Loading plugin
2026-10-27T19:39:29.926Z  stdout  [pi-tmux-bridge] ready (prefix="paseo-" layout="even-horizontal" placeholder="$SHELL -l" fallback="tail -f /dev/null" PI_SUBAGENT_SHELL_READY_DELAY_MS=2000 PASEO_TMUX_SESSION=PASEO_TMUX_SESSION)
2026-10-27T19:39:29.926Z  stdout  [paseo] Plugin ready
```

### C.1 session created, env injected, attach terminal opened (PASS)

From `tests/e2e-subagent-check.sh` (agent `aee691f9-2d93-42e9-b1a6-14e994d2df46`):

```text
agentId=aee691f9-2d93-42e9-b1a6-14e994d2df46

=== 2. env of the agent's pi process ===
pi pid=19710
TMUX=/tmp/tmux-1000/default,15532,0
TMUX_PANE=%28
PASEO_TMUX_SESSION=paseo-aee691f9-2d93-42e9-b1a6-14e994d2df46
PI_SUBAGENT_SHELL_READY_DELAY_MS=2000

=== 3. attach terminal created by the plugin (daemon plugin log) ===
... [pi-tmux-bridge] agent aee691f9-2d93-42e9-b1a6-14e994d2df46 (create) -> tmux paseo-aee691f9-2d93-42e9-b1a6-14e994d2df46 pane %28 (created)
... [pi-tmux-bridge] opened attach terminal 65829965-9b36-4f68-bd65-5f5dc55228ea for agent aee691f9-... (paseo-aee691f9-...)
```

The env was read out of `/proc/<pid>/environ` of the actual Pi child, which is the strongest
available proof that the `agent.session_open` transform reached the launch. `PASEO_AGENT_ID` was
present in the same environ, which is how the script identifies the right process.

Terminal listing (confirms the SPEC's open question — terminal `name` does round-trip):

```text
$ ... terminal ls --workspace wks_cf2f15187d6daf95
ID        NAME                                          CWD                WORKSPACE
6b1e2c75  pi-tmux:3ddd383b-89e0-4ac5-a16f-98e234e91b10  /tmp/pi-bridge-ws  wks_cf2f15187d6daf95
```

The session also showed as `(attached)` in `tmux ls`, which proves the created terminal really ran
`tmux attach -t <session>`.

### C.2 subagent pane appears side by side (PASS)

The agent was asked to call the `subagent` tool with `agent="worker"`. Evidence captured while the
pane was alive:

```text
--- second pane detected at 19:57:00 ---
%28 idx=0 cmd=bash pid=19699 110x49 active=1
%29 idx=1 cmd=bash pid=19884 109x49 active=0
--- window layout ---
bash layout=d97d,220x49,0,0{110x49,0,0,28,109x49,111,0,29}
--- process tree of each pane (recursive) ---
pane %28 (shell pid 19699):
pane %29 (shell pid 19884):
    19907 bash /home/agent/.pi/agent/sessions/--tmp-pi-bridge-ws--/artifacts/.../subagent-scripts/worker-2f4a3c6c.sh
    19908 pi
--- BRIDGE_OK output line seen in pane %30 at 19:57:18 ---
8- $ echo BRIDGE_OK
9-
10: BRIDGE_OK
11-

=== 5. verdict ===
secondPaneObserved=1 piProcessObserved=1 bridgeOkObserved=1
e2e-subagent-check: PASS
```

Two panes at `110x49` and `109x49` inside one `220x49` window is the `even-horizontal` layout —
literally side by side. A real `pi` process (`19908`) ran under Amos's launch script in the second
pane, and the subagent's own shell printed `BRIDGE_OK` as command output.

A second, independent confirmation came from the agent's timeline:

```text
[scout] Run the shell command echo BRIDGE_OK with the bash tool, then stop.
Sub-agent "scout" launched and is now running in the background. ...
[Subagent result]
```

### C.3 cleanup on archive (PASS)

```text
$ ... archive --force 3ddd383b-89e0-4ac5-a16f-98e234e91b10
AGENT ID                              STATUS    ARCHIVED AT
3ddd383b-89e0-4ac5-a16f-98e234e91b10  archived  2026-10-27T19:43:12.740Z

... [pi-tmux-bridge] killed attach terminal 6b1e2c75-... for agent 3ddd383b-...
... [pi-tmux-bridge] killed tmux session paseo-3ddd383b-89e0-4ac5-a16f-98e234e91b10 (archived)
$ tmux ls
pi-recovery: 1 windows ...
pi-subagent-test: 1 windows ...
```

Final state after all testing:

```text
$ tmux ls | grep -c "^paseo-"
0
$ npx tsx packages/cli/src/index.ts --home /tmp/paseo-plugin-test-home daemon stop
stopped: /tmp/paseo-plugin-test-home
```

Only the two tmux sessions that already existed before this work (`pi-recovery`,
`pi-subagent-test`) remain; neither was ever touched.

---

## What I could NOT verify

- **The client UI at runtime.** `index.client.tsx`, `client/panel.tsx` and `client/settings.tsx`
  compile with Paseo's plugin compiler and typecheck against the real SDK types, but no Paseo
  client app was ever opened, so the panel, the settings screen, the 2s polling, the modal, and the
  buttons have **never been rendered or clicked**. This is the largest unverified area.
- **The six RPC handlers end-to-end.** They are registered in the compiled bundle (asserted by
  `compile-check`), but no client ever called them. Their server-side helpers are unit-tested only
  through `TmuxClient`, not through the `handle()` wiring.
- **Phase 3 (timeline transformer/renderer for Amos tool calls).** Not attempted — the SPEC marks it
  optional and only after 1–6, and I chose to spend the effort on real end-to-end proof instead.
- **`agent.closed` specifically.** Only `agent.archived` was exercised (archiving an agent). The
  `closed` handler is identical in code but was never fired by a real event.
- **`reason: "resume" | "refresh" | "import"` in a live daemon.** Idempotent reuse is unit-tested
  against a scripted tmux runner, and the hook logs `request.reason`, but I only ever observed
  `(create)` in the daemon logs. No agent was resumed or refreshed across a daemon restart.
- **macOS portability.** `$SHELL -l` as the placeholder and `tail -f /dev/null` as the fallback were
  only exercised on Linux. `tail -f /dev/null` in particular should be re-checked on macOS, where
  `sleep infinity` is the usual idiom.
- **Two plugins / two agents in parallel on one host.** Each agent gets its own session by name, and
  the mechanism spike and e2e each used one session; I never ran two Paseo agents concurrently to
  watch them split independently.
- **Behaviour when tmux is absent, in the live daemon.** The fail-soft path is unit-tested
  (`TMUX === ""`, `probe()` false, `ensureSession` failure stages) and the negative control proves
  Amos's own error message, but I never started a daemon with tmux off PATH.

## Known gaps and risks

1. **A daemon started inside an Amos subagent pane poisons subagent spawning.** In the first e2e run
   the agent inherited `PI_SUBAGENT_AGENT=worker` from the daemon, and Amos's self-spawn guard
   (`index.ts:1730-1740`) then refused `subagent({agent:"worker"})` with *"You are the worker agent —
   do not start another worker."* This is not a plugin bug — it is Paseo's env inheritance
   (`createExternalProcessEnv`) meeting Amos's identity vars — but it is a real trap. Workaround,
   verified: start the daemon with `env -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_NAME -u PI_SUBAGENT_ALLOWED
   -u PI_SUBAGENT_AUTO_EXIT`. I deliberately did **not** strip these in the plugin, because the SPEC
   fixes the returned env shape and silently deleting unrelated identity variables could break a
   user who wants them. If you want the plugin to strip them, that is a one-line change in
   `buildInjectedEnv` and should be a setting.
2. **`pane_current_command` is usually `bash`, not `pi`,** for Amos subagents (see Phase A note). The
   panel shows it because the SPEC asks for it, but it is not a reliable "is a subagent running here"
   signal on this box.
3. **Subagent panes disappear when the subagent exits.** Agents defined with `autoExit: true` (e.g.
   `worker`, `scout`) close their own pane, so a polling UI can miss them entirely. My first e2e poll
   at 10s intervals saw nothing; at 1s it caught it. A UI that wants stable panes should either poll
   fast or keep panes open.
4. **Terminal dedupe relies on the bookkeeping map first**, then falls back to a `terminals.list()`
   name match. The map is per-plugin-instance, so after a daemon restart the map is empty and dedupe
   depends on the name `pi-tmux:<agentId>` matching. `terminal ls` confirmed the name round-trips in
   0.13.2, but that is not a contractual guarantee in the SDK types.
5. **The placeholder pane is a plain shell, not the Pi process.** Pi still runs as a daemon child over
   stdio RPC; the pane exists only to give Amos a stable split target. Attaching shows the subagent
   panes plus one idle shell.
6. **`select-layout` re-applies on every session_open**, including refreshes. It is cosmetic and
   failures are ignored, but it will override a user's manual pane sizing on the next resume.
7. **`PASEO_TMUX_SESSION` is also set to `""` on the fail-soft path**, which is slightly beyond the
   SPEC's minimum (which only requires `TMUX: ""`); clearing `TMUX_PANE` too is the same deliberate
   hardening, so no stale pane reference survives.
8. **Console logging.** The plugin logs to stdout via `console.log` because the SPEC requires stdout
   logging on the fail-soft path; pi-lens flags `no-console-except-error` on those lines. Daemon-side
   this is what makes `paseo plugin logs pi-tmux-bridge` useful, which is how C.1/C.3 were verified.

## Install instructions for the user's real Paseo

```bash
paseo plugin install <plugin-dir>
paseo daemon config set pluginsEnabled true
paseo daemon restart
paseo plugin ls                       # expect pi-tmux-bridge  running  yes
paseo plugin logs pi-tmux-bridge      # expect "[pi-tmux-bridge] ready (...)"
```

Then open a Pi agent, open the **tmux** panel, and ask the agent to use `subagent`.
If the daemon itself was launched from inside an Amos pane, restart it with the `PI_SUBAGENT_*`
variables unset (risk 1 above).

---

## Independent re-verification (separate reviewer session, after the build)

Run against a fresh daemon; the builder's claims were reproduced rather than trusted.

| Check | How run by me | Result |
|---|---|---|
| Unit tests | `node --test tests/unit.test.ts` | **26/26 pass** |
| Paseo plugin compiler | `cd checkout && npx tsx tests/compile-check.mjs` | **PASS** (28 KB server / 25 KB client bundles, all 6 RPC names, kill guard present) |
| Real daemon load | `npx tsx packages/cli/src/index.ts daemon start --home /tmp/paseo-plugin-test-home` | plugin `STATUS=running` |
| Single-agent e2e | `bash tests/e2e-subagent-check.sh` | **PASS** — `TMUX=/tmp/tmux-1000/default,22041,0`, `TMUX_PANE=%31`, `PASEO_TMUX_SESSION=paseo-b9242b1d…`, second pane with `pi` in it, `BRIDGE_OK`, session gone after archive |
| **Concurrent agents** | `bash tests/concurrent-agents-check.sh` (added here) | **PASS** — two agents at once got separate sessions and **disjoint** panes (`%33,%35` vs `%34,%36`), each `110x49` / `109x49`; kill path fired for both (`killed tmux session paseo-afd4e6c3…`, `…paseo-641e74a1…`) |

Concurrent isolation is the property the whole plugin exists to provide (the original bug was every
agent inheriting one shared `TMUX_PANE`), so it was verified explicitly rather than assumed.

**Test-script bug found and fixed during this pass:** the first concurrent run used
`agent archive <id>`, which is not the right CLI verb, so cleanup never fired and two sessions survived.
Correct form is top-level `archive --force <id>`. This was a bug in the test, **not** in the plugin; the
plugin's `agent.archived` kill path worked on the first correct call.

Still not verified after this pass: the client panel/UI was never rendered (no Paseo app was opened), the
6 RPC handlers were never exercised from a real client, `agent.closed` (as opposed to `agent.archived`)
was never observed firing, and `resume`/`refresh`/`import` remain unit-tested only.
