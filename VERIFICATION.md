
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

---

# 2026-10-27 (second pass) — "it doesn't do anything": reproduced, root-caused, fixed, proven in the rendered UI

Everything in this section was run against a scratch home (`/tmp/paseo-verify-home`), never
`/home/cosmin/.paseo`. The Paseo checkout stayed untouched (verified at the end). The client UI was
rendered for real: the daemon served the browser app and the browser tools drove it. Screenshots are
under `evidence/` (each verified with `details.artifactVerification` before being trusted).

Environment: daemon from the clean `v0.13.2` checkout (`npx tsx packages/cli/src/index.ts daemon start
--home /tmp/paseo-verify-home`), web UI built once into a **copy** of the repo at `/tmp/paseo-build`
(the read-only checkout was never built in) and served through
`features.webUi.distDir = /tmp/paseo-build/packages/server/dist/server/web-ui`.

## 1. The user's install was already healthy — the plugin was running and doing nothing

Read-only inspection of the real `~/.paseo` (config + log only; nothing was written, no CLI call was
made against that home):

- `config.json` already has `"pluginsEnabled": true` and
  `"pi-tmux-bridge": { "source": "directory", "path": ".../pi-tmux-bridge/<uuid>/checkout", "enabled": true }`.
- `daemon.log` shows the plugin loaded fine:

  ```text
  ... "pluginId":"pi-tmux-bridge" ... "message":"[pi-tmux-bridge] ready (prefix=\"paseo-\" ...)"
  ... "pluginId":"pi-tmux-bridge","methods":["capture-pane","kill-pane","list-panes",
      "open-attach-terminal","select-pane","session-status","settings.pi-tmux-bridge.*"],"providers":[]
  ```

- **Zero** `[pi-tmux-bridge] agent <id> -> tmux ...` lines exist in the whole log, while the same log
  contains 73 records with `"provider":"pi-recovery"`:

  ```text
  $ grep -o '"provider":"[a-z0-9-]*"' ~/.paseo/daemon.log | sort | uniq -c
       110 "provider":"local"
        73 "provider":"pi-recovery"
  ```

So: installed, trusted, enabled, running — and never acted. "Doesn't do anything" is accurate.

Also in that log, an earlier install attempt failed because a bare repo slug is not a valid source:

```text
Error: Plugin source is neither an existing directory nor a Git URL: Cosmin-Local-Ai/paseo-pi-tmux-bridge
```

Use a directory path or a full `https://github.com/<owner>/<repo>.git` URL.

## 2. Root cause A (server) — the provider guard rejected the user's provider

`shouldHandleSessionOpen()` required `provider === "pi"` exactly. Paseo sends the **derived** provider
id: `agent-manager.ts` builds the hook request with `provider: client.provider`, and a provider
declared `extends: "pi"` (`provider-registry.ts`) registers under its own id. The user's only enabled
Pi provider is `pi-recovery`.

Reproduced side by side in the scratch daemon (`/tmp/paseo-verify-home`), same plugin build:

```text
pi agent:          89041405-582b-4690-9ee3-219c3634bc30
pi-recovery agent: b224bb60-ea6d-41c0-9bbf-fc954b6063de

$ paseo plugin logs pi-tmux-bridge
[pi-tmux-bridge] agent 89041405-… (create) -> tmux paseo-89041405-… pane %2 (created)
[pi-tmux-bridge] opened attach terminal 94c212d3-… for agent 89041405-…
(no line at all for b224bb60-…)

$ tmux ls
paseo-89041405-582b-4690-9ee3-219c3634bc30: 1 windows ... (attached)     # pi agent
                                                                          # pi-recovery agent: none
$ tr '\0' '\n' < /proc/1474/environ | grep -E '^(TMUX|TMUX_PANE|PASEO_TMUX_SESSION|…)'
TMUX=/tmp/tmux-1000/default,1185,0
TMUX_PANE=%2
PASEO_TMUX_SESSION=paseo-89041405-…
PI_SUBAGENT_SHELL_READY_DELAY_MS=2000

$ tr '\0' '\n' < /proc/1626/environ | grep -E '^(TMUX|PASEO_TMUX_SESSION)='
(no match — the pi-recovery agent got no tmux env at all)
```

`/proc/<pid>/environ` is the strongest available proof: the hook never ran for that provider, so Amos
falls back to its own "Subagents require tmux" error.

**Fix** (`server/tmux.ts`): `isPiProviderId()` matches `pi`, any id with a delimited `pi` token
(`pi-recovery`, `recovery-pi`, `local_pi`, `pi.local`) — deliberately not `pilot`/`openapi` — plus an
explicit `piProviders` setting and `autoDetectPiProviders` switch. The hook now also logs the first
skip of an unmatched provider so the situation is visible in `paseo plugin logs`.

After the fix, the same `pi-recovery` agent:

```text
$ paseo agent reload b224bb60-…
AGENT ID                              STATUS    TIMELINE
b224bb60-ea6d-41c0-9bbf-fc954b6063de  reloaded  3
$ paseo plugin logs pi-tmux-bridge
[pi-tmux-bridge] agent b224bb60-… (refresh) -> tmux paseo-b224bb60-… pane %4 (created)
[pi-tmux-bridge] opened attach terminal 23d50c7b-… for agent b224bb60-…
$ tmux ls
paseo-b224bb60-ea6d-41c0-9bbf-fc954b6063de: 1 windows ... (attached)
```

Note `reason: "refresh"` — this also proves the hook fires on refresh, which was previously only
unit-tested.

## 3. Root cause B (client) — one invalid id killed the whole client bundle

The host validates every client contribution id against
`CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/` (`packages/app/src/plugins/evaluate.ts`). The plugin used
dotted ids (`pi-tmux-bridge.open`, `pi-tmux-bridge.settings`). `requireId` throws inside
`contribute()`, and the host then discards the **entire** client bundle. Captured from the live app
console (buffer cleared, then the page reloaded, so this is the current load):

```text
[Plugins] Failed to evaluate srv_1dof_l9RQW90/pi-tmux-bridge
Error: Invalid Command Center item id: pi-tmux-bridge.open
    at Object.addCommandCenterItem
    at contribute (eval at _e.runPluginClientBundle (…/index-825db5a3e4b11dd912af9a672e652558.js:16910:7750), <anonymous>:581:31)
    at _e.runPluginClientBundle (…)
```

Consequences, all confirmed in the UI before the fix: the panel did not exist, the settings screen did
not exist, and the Command Center said **"No matches"** for `tmux`. `tsc` and `compilePlugin()` could
not see this — it is a runtime host-validation failure.

**Fix:** ids are now `tmux`, `tmux-workspace`, `pi-tmux-bridge`, `open-panel`,
`open-attach-terminal`, `configure`, and slash command `tmux`. `tests/compile-check.mjs` now extracts
every contribution id (inline and constant) from `index.client.tsx` and fails the build if one does
not match the host rule, so this cannot regress. After reload + reload, the console error is gone:

```text
$ agent-browser console errors     # buffer cleared, page reloaded
1. [warning] Animated: `useNativeDriver` is not supported …   # only the benign RN warning
```

## 4. Root cause C (client) — an agent panel has no discoverability at all

Paseo's `+` launcher lists plugin panels only when `panel.context === "workspace"`
(`packages/app/src/workspace-tabs/launcher/index.tsx`: `if (panel.context !== "workspace") continue;`).
`addAgentPanel` registers context `agent`, and the only way to open an agent panel is a plugin's own
`openPanel()` call (`packages/app/src/plugins/navigation.ts` — `openAgentPanel` has no other callers).
The old client registered a panel and command items that never opened it, so even with the id bug
fixed there was **no way to reach the panel**.

**Fix:** the same view is registered as an agent panel (`tmux`) and a workspace panel
(`tmux-workspace`, appears in the `+` menu and picks the agent from the workspace), plus a Command
Center item and a `/tmux` slash command that call `openPanel("tmux", { location: "explorer" })`.
`explorer` docks the panel in the explorer pane, **side by side with the agent chat**, and Paseo
persists that pane per workspace — which is what the user asked for ("see them side by side to the
main session, spawning on the right, not having to click anything to see the sessions somewhere
else"). Pane cards in the panel now also lay out left→right in tmux index order.

## 5. Root cause D (client, found only by rendering) — `SidebarRow` is not a general-purpose row

With ids fixed and the panel reachable, the panel rendered as:

```text
Plugin failed: SidebarRow must render inside a sidebar item
```

(`packages/app/src/plugins/sidebar-items/frame.ts` — `SidebarRow` requires a sidebar-item frame.)
Both pane rows and the new agent picker used it. Replaced with plain `Pressable` + `Icon` + `Text`.
No static check could have found this.

## 6. Visual proof, in order

| file | what it shows |
| --- | --- |
| `evidence/01-daemon-web-ui-home.png` | daemon serving the real Paseo web app, connected to the scratch daemon |
| `evidence/02-agent-view-pi-recovery.png` | the `bridge-recovery` (provider `pi-recovery`) agent; no plugin UI anywhere |
| `evidence/03-new-tab-menu-no-plugin-panel.png` | **before**: `+` menu = Agent, Terminal, Claude Code, Codex, OpenCode, Pi — no plugin panel |
| `evidence/04-command-center-tmux-items.png` | **before**: Command Center search `tmux` → **"No matches"** |
| `evidence/05-new-tab-menu-with-tmux-panes.png` | **after**: `+` menu now lists **tmux panes** |
| `evidence/06-tmux-panel-open-pi-recovery-agent.png` | panel renders for the `pi-recovery` agent: session name, 0 panes, "No tmux session for this agent yet" (pre-fix state) |
| `evidence/07-tmux-panel-rendered-workspace.png` | panel body renders (agent picker, buttons, warning) — proves the RPC round-trip |
| `evidence/08-tmux-panel-pi-recovery-session-with-pane.png` | after `agent reload`: 1 pane `%4 · bash · 220x49` with real captured shell text, and a `tmux attach -t paseo-…` tab appeared on its own |
| `evidence/09-attach-terminal-tab.png` | the auto attach terminal really runs `tmux attach` — prompt plus the green tmux status bar `[paseo-b224bb60(bash)]` |
| `evidence/10-attach-terminal-two-panes-side-by-side.png` | **the feature**: real Amos `subagent` call → two panes side by side, right pane is the worker's Pi TUI showing the task text |
| `evidence/11-tmux-panel-two-panes-captured.png` | panel lists both panes with real captured content (`%4 … pi-recovery-test`, `%5 … pi-bridge-ws` worker text) |
| `evidence/12-panel-panes-side-by-side.png` | panel now renders panes left→right: main session left, worker subagent right |
| `evidence/13-slash-command-tmux-autocomplete.png` | agent chat with the `worker` subagent turn visible; `/tmux` typed in the composer |
| `evidence/14-command-center-plugin-items.png` | Command Center `tmux` → `pi-tmux-bridge` section: Open tmux panel / Configure / Open attach terminal |
| `evidence/15-panel-explorer-side-by-side-with-chat.png` | **the answer to the request**: tmux panel docked in the explorer pane beside the chat, showing both panes with live content |

## 7. Amos identity variables

The first e2e run of the previous pass hit Amos's self-spawn guard because the daemon leaked
`PI_SUBAGENT_AGENT=worker` into the agent. `buildInjectedEnv`/`buildTmuxUnavailableEnv` now strip
`PI_SUBAGENT_AGENT|NAME|ID|ALLOWED|AUTO_EXIT|SURFACE|SESSION|ACTIVITY_FILE` by default
(`stripAmosIdentity: true`), since a Paseo agent is always a top-level Pi session. Unit-tested,
including that `PI_SESSION_FILE` and unrelated vars survive and the caller's object is not mutated.

## 8. Also fixed

- `autoAttachTerminal` was declared as a setting but never honoured — the attach terminal was created
  unconditionally. Now gated.

## 9. Tests / compile status after the changes

```text
$ node --test tests/unit.test.ts
ℹ tests 28
ℹ pass 28
ℹ fail 0

$ CHECKOUT=/home/cosmin/paseo-pi-subagent-fix npx --prefix "$CHECKOUT" tsx tests/compile-check.mjs
{
  "contributionIdsChecked": 7,
  "badContributionIds": [],
  "serverBundleBytes": 30641,
  "clientBundleBytes": 31028,
  "serverHasContribute": true,
  "serverRegistersSessionOpen": true,
  "serverHasKillGuard": true,
  "clientHasAgentPanel": true,
  "clientHasRpcNames": [ … 6 ],
  "serverHasRpcNames": [ … 6 ]
}
compile-check: PASS
```

`npx tsc --noEmit -p tsconfig.json` → exit 0.

## 9b. Bug found while cleaning up: orphaned tmux sessions after `plugin reload`

Archiving the two test agents did **not** kill their sessions. Cause: `BridgeBookkeeping` lives in the
plugin instance, so after `paseo plugin reload` (or a daemon restart) the map is empty and
`handleAgentGone` returned at `if (!record) return;`. Every session created before a reload leaked.

Fix: cleanup no longer depends on the map. It re-derives the session name from the settings prefix
plus the agent id, finds the attach terminal by its deterministic name through an unscoped
`paseo.terminals.list()`, and keeps the `isOwnSessionName` guard so only a name this plugin could have
produced is ever killed. Proven by creating a session, reloading the plugin (map emptied), then
archiving:

```text
$ paseo plugin reload pi-tmux-bridge          # bookkeeping map is now empty
$ paseo archive --force 0015e0bb-83e2-4e23-9861-8acd584a5de7
[pi-tmux-bridge] killed attach terminal f7fa7591-2714-4647-a130-601d20956483 for agent 0015e0bb-…
[pi-tmux-bridge] killed tmux session paseo-0015e0bb-83e2-4e23-9861-8acd584a5de7 (archived)
```

Sessions created by the **unfixed** build stayed orphaned (no further event fires for an archived
agent), so they were removed by hand: `tmux kill-session -t paseo-<agentId>` for the two ids this pass
created. Cosmetic note: `agent.closed` and `agent.archived` can both land in the same tick, so the
second handler pass logs `tmux kill-session … failed: can't find session` after the first succeeded.

## 10. Checkout integrity and cleanup

```text
$ cd /home/cosmin/paseo-pi-subagent-fix && git status --short | head -5; git stash list; git log --oneline -1
stash@{0}: On (no branch): chatgpt-attempt: in-daemon pi-interactive-subagents adapter + registry registration
d294115 chore(release): cut 0.13.2
```

`git status --short` printed nothing. The web UI was built in a copy (`/tmp/paseo-build`), not in the
checkout. `~/.paseo` was never written to and no command was run against it.

Cleanup: every scratch agent was archived, sessions created under the fixed build were killed by the
plugin itself, and the two sessions orphaned by the pre-fix build were killed by hand. No `paseo-*`
session created during this pass remains:

```text
$ tmux ls | grep -c '^paseo-'
0
```

## 11. Still not proven after this pass

- `agent.closed` (only `agent.archived` and the reload/refresh path were observed firing).
- `reason: "resume"` / `"import"` against a live daemon (`create` and `refresh` were both observed).
- Submitting `/tmux` by hand: the composer is a React-controlled input and the automation `fill` did
  not commit app state, so the slash command was typed but not submitted. The Command Center item
  calls the identical `openPanel("tmux", { location: "explorer" })` and is proven end to end.
- The desktop app itself (Electron) — verification used the daemon-served web client at
  `http://127.0.0.1:6767`, i.e. the same React Native/Expo client code and the same plugin client
  bundle path.
- Two concurrent agents **after** this pass's changes (proven in the previous pass, unchanged code
  paths).

---

# 2026-10-27 (third pass) — `tmux is not on PATH`: absolute resolution, PATH injection, loud failure

Everything below ran against scratch homes (`/tmp/paseo-verify-home`, `/tmp/paseo-notmux-home`), never
`/home/cosmin/.paseo` (read-only `grep` only). The Paseo checkout was not built in or modified. No web
app rebuild: the previously built bundle at `/tmp/paseo-build/.../web-ui` was reused. Screenshots are
in `evidence/`, each verified with `details.artifactVerification` and inspected.

## 1. The user's evidence (their own `~/.paseo/daemon.log`, read-only)

The fixed build is installed and the provider fix works, but every agent hits the fail-soft path:

```text
$ grep -c "tmux is not on PATH" ~/.paseo/daemon.log
15
$ grep -o "terminal list failed for [a-z0-9-]*: Daemon client closed" ~/.paseo/daemon.log
terminal list failed for e30928dc-091c-4671-a5d8-9c333ff69f4f: Daemon client closed
```

`tmux is not on PATH` was, at that point, a one-line log entry and an empty panel: nothing told the
user what was tried or what to do, and Amos inside the agent had no tmux either.

## 2. Absolute tmux resolution (server)

`server/tmux.ts` gained `TMUX_CANDIDATE_PATHS`, `tmuxCandidatePaths()`, `TMUX_WHICH_ARGS`,
`parsePathLookup()`, `resolveTmuxPath()` and `binaryDirOf()`. `index.server.ts` resolves once per
plugin instance and caches, re-resolving when `tmuxPath` changes. Probe order:

1. `tmuxPath` setting (new, absolute path, default `""`). It is **authoritative**: a set-but-bad
   override fails visibly instead of silently falling back to another tmux.
2. `command -v tmux` via `/bin/sh -lc`.
3. `/usr/bin`, `/usr/local/bin`, `/usr/local/sbin`, `/opt/homebrew/bin`, `/opt/local/bin`,
   `/snap/bin`, `$HOME/.local/bin`, `/run/current-system/sw/bin`.

Every candidate is proven by executing `<candidate> -V`, so a stale symlink or non-executable file
cannot win. The resolved path is used for every tmux call and as the attach terminal's `command`
(the terminal also inherits the daemon environment, so `tmux` by name would have failed there too).

## 3. `PATH` injection — and the trap that came with it

Amos gates on `command -v tmux` **inside the agent process**, so the agent needs the resolved
directory on its `PATH`. `buildInjectedEnv`/`buildTmuxUnavailableEnv` now take `tmuxPath` and prepend
`binaryDirOf(tmuxPath)` using `path.delimiter`-style joining (`PATH_DELIMITER`, `prependToPath`),
de-duplicating on resume/refresh.

The first implementation wrote `PATH = tmuxDir` when the hook env had no `PATH`, and the live run
caught the consequence:

```text
$ paseo agent reload 661d0635-…
Error: spawn pi ENOENT requestType=refresh_agent_request code=agent_refresh_failed
```

because Paseo composes the launch env as `{ ...daemonEnv, ...hookEnv }`
(`packages/server/src/server/agent/provider-launch-config.ts:252`,
`createExternalProcessEnv(spec.baseEnv ?? process.env, spec.envOverlay)`), so a hook `PATH`
**replaces** the daemon `PATH`. `agent.session_open` hands the hook a sparse env with no `PATH` key,
so the injection now bases itself on the daemon `PATH` (`pathBaseFor`) and never emits a lone
directory. Unit-tested.

## 4. The failure is now loud

- `session-status` and `list-panes` return `tmuxAvailable`, `tmuxPath` and `tmuxTried`; when
  unavailable they return `detail: TMUX_MISSING_DETAIL`.
- Panel header: **`tmux not found on daemon host`** + `install tmux or set tmuxPath`, the attach
  button becomes `tmux unavailable` (disabled), and a red block repeats the sentence with the full
  tried list. When tmux *is* resolved, the header shows it: `2 panes · /usr/bin/tmux`.
- Log line names every probe:

  ```text
  [pi-tmux-bridge] tmux not found on daemon host — install tmux or set tmuxPath; tried: PATH (command -v tmux: not found), /usr/bin/tmux, /usr/local/bin/tmux, /usr/local/sbin/tmux, /opt/homebrew/bin/tmux, /opt/local/bin/tmux, /snap/bin/tmux, /home/agent/.local/bin/tmux, /run/current-system/sw/bin/tmux
  ```

## 5. `Daemon client closed` noise

`contribute()`'s teardown now sets `stopped = true`; `handleAgentGone`, `ensureAttachTerminal`,
`scheduleAttachTerminal` and their catches skip work / suppress logging through `channelGone()`, and
the cleanup path re-derives names instead of touching a dead channel. After a plugin reload with a
live agent, both scratch logs contain zero `Daemon client closed` and zero `terminal list failed`
lines (the user's log has one of each from the unfixed build).

## 6. Another real defect found while testing: saved settings were never read

`settingsCache` was initialised to the declared defaults and `currentSettings()` returned it
unconditionally, while the host only *pushes settings on change*
(`packages/server/src/server/plugins/settings/index.ts` — `subscribe` never delivers an initial
state). So a `tmuxPath` saved in the app was ignored after every restart/reload. `currentSettings()`
now performs exactly one host read on first use.

Settings live at `<home>/plugin-settings/<pluginId>/<settingsId>.json` as an **envelope**,
`{"version": 1, "values": {...}}`; a bare values object is rejected (`Invalid input; using defaults`).

## 7. Scenario A — daemon whose `PATH` cannot resolve tmux (the user's condition)

Built a faithful reproduction without touching the system: `/tmp/no-tmux-bin` holds symlinks to every
`/usr/bin` binary **except tmux**, and the daemon was started with
`PATH=/tmp/no-tmux-bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/share/npm-global/bin`
(no `/usr/bin`) and `TMUX`/`TMUX_PANE` unset.

```text
control:  env -i PATH=<daemon PATH> sh -c 'command -v tmux'   → (nothing; daemon PATH alone cannot resolve tmux)

plugin log:
  [pi-tmux-bridge] tmux resolved to /usr/bin/tmux
  [pi-tmux-bridge] agent df3d3456-… (create) -> tmux paseo-df3d3456-… pane %12 (created)
  [pi-tmux-bridge] opened attach terminal 5fbaceda-… for agent df3d3456-…

/proc/19702/environ (the pi process Paseo spawned):
  TMUX=/tmp/tmux-1000/default,19594,0
  TMUX_PANE=%12
  PASEO_TMUX_SESSION=paseo-df3d3456-…
  PATH=/usr/bin:/home/cosmin/paseo-pi-subagent-fix/node_modules/.bin:…:/tmp/no-tmux-bin:…
  env -i PATH=<that PATH> sh -c 'command -v tmux' → /usr/bin/tmux (tmux 3.6)
```

The `/usr/bin` entry only exists because the plugin injected it: the daemon's own `PATH` has no
directory that contains tmux (control above). A real Amos `subagent` call then split the session:

```text
%12 idx=0 active=1 w=110 h=49 cmd=bash     (placeholder / main)
%13 idx=1 active=0 w=109 h=49 cmd=bash     (worker)
```

* `evidence/16-attach-terminal-two-panes-no-tmux-on-daemon-path.png` — the auto `tmux attach` tab with
  two panes side by side: main shell left, the `[worker]` Pi TUI on the right running
  `$ sleep 180 && echo BRIDGE_UI_OK (timeout 300s)`, green tmux status bar at the bottom.
* `evidence/17-panel-two-panes-resolved-tmux-path.png` — panel header `tmux · paseo-df3d3456-…` with
  **`2 panes · /usr/bin/tmux`**, both pane cards side by side with live captures (worker text visible).

## 8. Scenario B — tmux genuinely absent on the daemon host

Ran the daemon in a private mount namespace with tmux hidden, then dropped to uid 1000 so nothing on
the host is owned by root:

```text
$ sudo -n unshare -m /tmp/start-notmux-daemon.sh
in-namespace tmux: NONE
Started: PID 23084, listening on 127.0.0.1:6768
$ ls -l /proc/23084/root/usr/bin/tmux
crw-rw-rw- 1 root root 1, 3 … /proc/23084/root/usr/bin/tmux     # /dev/null over the real binary
```

Separate home (`/tmp/paseo-notmux-home`, port 6768, same web UI dist), plugin installed as a directory
source, agent via provider `pi-recovery`:

```text
[pi-tmux-bridge] tmux not found on daemon host — install tmux or set tmuxPath; tried: PATH (command -v tmux: not found), /usr/bin/tmux, /usr/local/bin/tmux, /usr/local/sbin/tmux, /opt/homebrew/bin/tmux, /opt/local/bin/tmux, /snap/bin/tmux, /home/agent/.local/bin/tmux, /run/current-system/sw/bin/tmux
[pi-tmux-bridge] tmux not found on daemon host — install tmux or set tmuxPath; agent 9b2f7b7b-… gets an empty TMUX. … Set tmuxPath to the absolute path if tmux lives somewhere else on this host.

/proc/22033/environ:  TMUX=   TMUX_PANE=   PASEO_TMUX_SESSION=
```

* `evidence/18-panel-tmux-not-found-diagnostic.png` — the panel with **no** blank state: red header
  `tmux not found on daemon host` + `install tmux or set tmuxPath`, disabled `tmux unavailable`
  button, and the full `Tried: …` list rendered in the UI.
* `evidence/19-chat-amos-tmux-error-no-tmux-host.png` — what the user actually sees in chat when the
  agent tries a subagent: *"Subagents require tmux. Start pi inside tmux (`tmux new -A -s pi 'pi'`)"*,
  with no subagent spawned. This is the "doesn't do anything" symptom, now paired with an explicit
  panel diagnosis instead of an empty pane list.

## 9. Scenario C — `tmuxPath` rescues a host where tmux is nowhere on `PATH`

Inside the same tmux-less namespace, tmux was copied to a location that is neither on `PATH` nor in
the candidate list, and declared in the settings document:

```text
$ cp /usr/bin/tmux /tmp/opt-tmux/tmux
$ cat /tmp/paseo-notmux-home/plugin-settings/pi-tmux-bridge/pi-tmux-bridge.json
{ "version": 1, "values": { "tmuxPath": "/tmp/opt-tmux/tmux" } }

[pi-tmux-bridge] tmux resolved to /tmp/opt-tmux/tmux
[pi-tmux-bridge] agent a6f78c55-… (create) -> tmux paseo-a6f78c55-… pane %14 (created)
[pi-tmux-bridge] opened attach terminal 7b23917e-… for agent a6f78c55-…

/proc environ: TMUX=/tmp/tmux-1000/default,23641,0  TMUX_PANE=%14  PASEO_TMUX_SESSION=paseo-a6f78c55-…
               PATH=/tmp/opt-tmux:/home/cosmin/…     command -v tmux → /tmp/opt-tmux/tmux
```

* `evidence/20-panel-tmuxpath-override-session.png` — panel header
  `tmux · paseo-a6f78c55-…` with **`1 pane · /tmp/opt-tmux/tmux`** and a live captured pane; the
  `tmux attach -t paseo-a6f78c55…` tab also opened on its own.

## 10. Tests / compile status

```text
$ node --test tests/unit.test.ts
ℹ tests 42
ℹ pass 42
ℹ fail 0

$ CHECKOUT=/home/cosmin/paseo-pi-subagent-fix npx --prefix "$CHECKOUT" tsx tests/compile-check.mjs
compile-check: PASS   (contributionIdsChecked: 7, badContributionIds: [])

$ npx tsc --noEmit -p tsconfig.json      # exit 0
```

New unit tests cover: candidate order and `$HOME` substitution (and that a missing `HOME` skips the
`$HOME` candidate rather than probing a literal `$HOME`), the authoritative `tmuxPath` override with
no silent fallback, PATH-lookup-before-candidates ordering, the full `tried` list on failure,
`parsePathLookup` junk rejection, `prependToPath` (prepend, de-dupe, empty, `;` delimiter, never
inventing a PATH), `binaryDirOf`, `pathBaseFor`, PATH injection through `buildInjectedEnv` including
"keeps every daemon directory so `pi` still resolves", and the fail-soft env.

## 11. Cleanup and checkout integrity

Both scratch daemons stopped (`daemon stop`), the namespaced daemon's tmux sessions killed,
`/tmp/no-tmux-bin`, `/tmp/opt-tmux`, `/tmp/start-notmux-daemon.sh` and the scratch homes removed.
`tmux ls` shows no `paseo-*` session. The checkout is untouched:

```text
$ cd /home/cosmin/paseo-pi-subagent-fix && git status --short | head -3; git stash list; git log --oneline -1
stash@{0}: On (no branch): chatgpt-attempt: in-daemon pi-interactive-subagents adapter + registry registration
d294115 chore(release): cut 0.13.2
```

`/home/cosmin/.paseo` was only ever read with `grep`.

## 12. Still not proven

- The user's exact desktop environment (AppImage daemon, their `PATH`, their tmux location). Scenario
  A reproduces the failure mode and the fix, not their machine.
- Windows (`PATH_DELIMITER` is chosen from `process.platform`, and the candidate list is POSIX-only).
- Editing settings through the app UI: the settings *document* was written directly at
  `<home>/plugin-settings/pi-tmux-bridge/pi-tmux-bridge.json`, which is the same store the UI writes;
  the in-UI round-trip itself was not exercised.
- A macOS/Homebrew tmux install (`/opt/homebrew/bin/tmux` is in the list but was not exercised).
- Concurrent agents under the new resolution code (unchanged naming/locking paths, proven earlier).
