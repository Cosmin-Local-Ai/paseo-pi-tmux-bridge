# SPEC — `pi-tmux-bridge`: a Paseo plugin that makes Pi-in-Paseo behave like Pi-in-tmux

## 0. Mission

Make the third-party Pi extension **`amosblomqvist/pi-interactive-subagents`** (the "Amos" tmux subagent
extension) work when Pi is launched by **Paseo**, so multiple Paseo agents can each run their own
subagent panes **side by side**. Deliver it as a **Paseo plugin only**.

## 1. HARD CONSTRAINTS (violating any of these fails the task)

1. **Write files ONLY inside `<plugin-dir>/`.**
2. `<paseo-checkout>` is the Paseo checkout. Treat it as **READ-ONLY**. It is a clean upstream `v0.13.2` checkout (detached HEAD `d294115`) and a
   previous attempt is preserved in `git stash@{0}`. **Do not** edit, add, delete, `git stash pop`,
   `git checkout`, or otherwise mutate it or its git state. Reading files and running read-only git
   commands is fine.
3. **READ-ONLY** references: `/home/agent/.pi/**` (Pi config) and especially
   `/home/agent/.pi/agent/git/github.com/amosblomqvist/pi-interactive-subagents/**` (the Amos extension).
   We must not change Amos or Pi — the fix lives entirely on the Paseo side.
4. **Never touch `~/.paseo`** — that is the user's real Paseo home. Any test must use
   `PASEO_HOME=/tmp/paseo-plugin-test-home`.
5. No `paseo daemon start/stop/restart` against the user's real daemon or real home.
6. Do not use tmux sessions you did not create. Prefix every session you create with the configured
   prefix (default `paseo-`). Clean up any session you create during testing.

## 2. Verified root cause (already established — do not re-derive, do not "fix" it elsewhere)

- Amos gates every pane operation on tmux: `isTmuxAvailable()` = `!!process.env.TMUX && hasCommand("tmux")`,
  and it **always splits off `process.env.TMUX_PANE`**
  (`pi-extension/subagents/tmux.ts:47-60`, `:117-160`, `rebalanceSurfaces` `:88-104`).
- Paseo launches Pi as a **stdio RPC child, not a PTY**: `buildPiLaunch` appends `--mode rpc`
  (`packages/server/src/server/agent/providers/pi/runtime.ts`), spawned in
  `packages/server/src/server/agent/providers/pi/cli-runtime.ts:60-66`.
- The child env is `createExternalProcessEnv(process.env, launch.env)`
  (`packages/server/src/server/paseo-env.ts:21-34, 40-45`). It strips only
  `PASEO_NODE_ENV`, `PASEO_DESKTOP_MANAGED`, `PASEO_SUPERVISED`, `ELECTRON_RUN_AS_NODE`,
  `ELECTRON_NO_ATTACH_CONSOLE`, `ESBUILD_BINARY_PATH`.
  **`TMUX` / `TMUX_PANE` are NOT stripped.**
- Consequence: every Pi agent inherits the *same* `TMUX`/`TMUX_PANE` (the pane the daemon was started
  from). All agents split from one shared — often dead — pane → collisions, wrong window, or
  `split-window -t %N` failure. If the daemon was not started inside tmux, `TMUX` is absent and Amos
  throws `tmux is required for subagents`.
- Paseo has **no** tmux integration at all (`grep -rn tmux packages/*/src` → only
  `packages/server/src/terminal/terminal.ts` key-input handling + one test).
- Research confirmed **no existing Paseo plugin** (of 399 in the official registry, nor the community
  catalog) integrates tmux/multiplexers. Green field — build it.

## 3. The seam to use (verified, with evidence)

Use **`agent.session_open`**, not `agent.create`, for env injection.

- `PluginBeforeRequests["agent.session_open"]` =
  `{ agentId, workspaceId: string|null, provider, cwd, reason: "create"|"resume"|"refresh"|"import",
  purpose: "interactive"|"history", env: Record<string,string> }`
  (`packages/plugin/src/server/lifecycle.ts:26-35, 72-76`).
- Daemon enforces that this hook **may only change `env`**
  (`packages/server/src/server/plugins/lifecycle/index.ts:133-149`).
- Result becomes the launch env: `env = transformed.env` → `AgentLaunchContext.env`
  (+ `PASEO_AGENT_ID`, `PASEO_AGENT_CWD`) at `packages/server/src/server/agent/agent-manager.ts:5339-5357`
  → Pi `runtime.startSession({ cwd, env })` (`providers/pi/agent.ts:2801`) → spawn.
- It re-runs on **create, resume, refresh, import**, which is exactly what sidesteps the documented
  caveat that creation-time env is not persisted across daemon restarts
  (getpaseo/paseo Discussion #5741).
- Official contract + example: https://paseo.sh/docs/plugins/reference and
  `plugin-examples/lifecycle-actions/index.server.ts`. **`env` does not deep-merge** — always return
  `{ ...request, env: { ...request.env, ... } }`.
- Other plugin capabilities you will use: `paseo.terminals.create({workspaceId, cwd, name, command, args, size})`,
  `.list()`, `.ref()` with `sendTerminalInput/captureTerminal/killTerminal`
  (`packages/client/src/terminals/index.ts:13-30, 58-118`); free functions `execCommand`, `spawnProcess`,
  `terminateProcess` exported from `@getpaseo/plugin/server`; `paseo: PaseoApi` on `PluginHookContext`;
  `handle(rpcContract, handler)`; `registerSettings`; client `addAgentPanel`, `addTimelineTransformer`,
  `addTimelineRenderer`, host UI kit in `@getpaseo/plugin/client/ui`.

## 4. Spike already run for you (PASSED — assume this works, re-verify only if you change it)

A process with a **fabricated** `TMUX='<socket_path>,<bogus pid>,0'` plus `TMUX_PANE='%5'` successfully
ran Amos's entire command set: `split-window -d -h -t $TMUX_PANE -P -F '#{pane_id}'`, `send-keys -l` +
`Enter`, `capture-pane -p`, `select-layout -t $TMUX_PANE even-horizontal`, `list-panes`, `kill-pane`.
`isTmuxAvailable()` returned true. Only nested `tmux attach` refuses — irrelevant, because tmux sets
correct `TMUX`/`TMUX_PANE` inside panes it creates, so child `pi` processes are fine.

Environment facts: `tmux 3.6`, default socket `/tmp/tmux-1000/default`, uid `1000`, node `v24.21.0`,
`npm` (no pnpm), `pi` at `/usr/local/share/npm-global/bin/pi`, checkout `node_modules` already installed,
no Paseo daemon currently running (port 6767 dead).

## 5. Deliverable layout

Entry files **must** be named `index.server.ts` and `index.client.tsx` — the loader rejects a legacy
`index.ts` (`packages/server/src/server/plugins/runtime.ts:40-41, 286-289`).

```
<plugin-dir>/
├── paseo-plugin.json      # {"id":"pi-tmux-bridge","name":...,"description":...,"requirements":{"paseo":">=0.13.0"}}
├── index.server.ts        # hooks + RPC handlers + settings
├── index.client.tsx       # agent panel
├── shared/contracts.ts    # zod RPC contracts shared by server+client
├── server/tmux.ts         # tmux command builders + runners (pure where possible)
├── server/bookkeeping.ts  # agentId -> {sessionName, terminalId} map
├── tests/                 # node --test or vitest, run from THIS folder only
├── README.md              # install + usage + how it works
└── VERIFICATION.md        # exactly what you ran, with real output
```

Manifest fields are only `id, name, description, icon(png), media, requirements.paseo, build`
(`packages/server/src/server/plugins/manifest.ts:25-38`). No entrypoint/settings fields.

## 6. Required behaviour (each item must be testable)

1. **`before("agent.session_open")`**
   - Act only when `request.provider === "pi"` **and** `request.purpose === "interactive"`.
     Leave `history`/`import` and all other providers completely untouched.
   - Ensure tmux session named `` `${sessionPrefix}${agentId}` `` (default prefix `paseo-`):
     - `tmux has-session -t NAME` → if missing:
       `tmux new-session -d -s NAME -c <cwd> -x 220 -y 60 '<placeholder>'`
       placeholder default `$SHELL -l`, fallback `tail -f /dev/null` (must stay alive; a dead host pane
       kills Amos's split target).
     - `tmux select-layout -t NAME <layout>` (default `even-horizontal`, matches Amos's own constant).
     - `paneId` = `tmux display-message -p -t NAME '#{pane_id}'`;
       `socket` = `tmux display-message -p '#{socket_path}'`.
   - Return `{ ...request, env: { ...request.env,
       TMUX: `${socket},${process.pid},0`,
       TMUX_PANE: paneId,
       PASEO_TMUX_SESSION: NAME,
       PI_SUBAGENT_SHELL_READY_DELAY_MS: String(shellReadyDelayMs)   // default 2000; Amos default is 500
     } }`.
   - **Idempotent on resume/refresh**: reuse the existing session and re-read its pane id (never
     `kill-session` on refresh).
   - **Fail-soft**: if `tmux` is not on PATH, log to stdout and set `TMUX: ""` (empty string is falsy in
     JS, so Amos reports its own clear error instead of splitting a stale inherited pane). Never throw
     from a hook — a hook error must not break agent launch.
2. **Auto-open an attach terminal** (setting `autoAttachTerminal`, default **true**)
   - Only when `request.workspaceId !== null`.
   - Dedupe first: `paseo.terminals.list({ workspaceId })` **plus** the in-plugin bookkeeping map
     (do not rely on `name` round-tripping — verify it does, and keep the map as source of truth).
   - `paseo.terminals.create({ workspaceId, cwd, name: \`pi-tmux:${agentId}\`, command: "tmux",
     args: ["attach", "-t", NAME], size: { rows: 50, cols: 220 } })`.
   - Do the terminal creation **outside** the hook body (fire-and-forget after the hook returns, or in
     `on("agent.created")`) — never block or fail the launch path.
3. **Cleanup** on `on("agent.closed")` and `on("agent.archived")`
   - `tmux kill-session -t NAME` when setting `killOnClose` (default **true**) and the session name came
     from our own prefix+agentId; also kill the terminal we created.
   - Guard: never kill a session whose name was not created by this plugin.
4. **Client agent panel** (`addAgentPanel`)
   - Shows, for the current agent's tmux session: pane id, index, `pane_current_command`, `pane_title`,
     and last ~15 captured lines per pane; a header with session name + pane count; buttons for
     focus (`select-pane`), kill (`kill-pane`), and "open attach terminal".
   - Poll every ~2s while mounted via `paseo.rpc(...)`; tolerate "no session" gracefully.
   - Use host components from `@getpaseo/plugin/client/ui` (`Modal`, `useToast`, `Icon`, `SidebarRow`),
     React Native `View`/`Text`, theme from props. Follow `plugin-examples/markdown-panel` and
     `plugin-examples/timeline-items` for style.
5. **RPC handlers** (`handle(contract, handler)` with zod contracts in `shared/contracts.ts`):
   `listPanes`, `capturePane`, `selectPane`, `killPane`, `openAttachTerminal`, `sessionStatus`.
   Validate `agentId` and derive the session name server-side — never accept a raw session name from the
   client (path/command injection guard).
6. **Settings** (`registerSettings`): `enabled`, `sessionPrefix`, `layout`, `placeholderCmd`,
   `shellReadyDelayMs`, `autoAttachTerminal`, `killOnClose`, `paneCaptureLines`. All with the defaults
   above.
7. **Phase 3 (optional, only if 1-6 are done and verified):** client-side
   `addTimelineTransformer` + `addTimelineRenderer` that render Amos's `subagent` / `subagent_message` /
   `subagents_list` tool calls as a native card. This replaces the reverted in-daemon adapter (see §8).
   Keep it strictly client-side.

## 7. Verification you must actually run (report real output, never claim unverified success)

**Phase A — mechanism proof, no Paseo required (do this first).**
Write `tests/mechanism-spike.sh` (or `.mjs`) that:
1. creates a session `paseo-spike-<pid>` with a live placeholder pane, reads `pane_id` + `socket_path`;
2. spawns `pi --mode rpc --no-session --extension
   /home/agent/.pi/agent/git/github.com/amosblomqvist/pi-interactive-subagents/pi-extension/subagents/index.ts`
   with env `TMUX`/`TMUX_PANE` set exactly as §4 and `PI_SUBAGENT_SHELL_READY_DELAY_MS=2000`;
3. writes a JSONL `prompt` command on stdin asking Pi to call the `subagent` tool with agent `worker`
   and a trivial task (e.g. "print OK and exit");
4. asserts a **second pane appears** in the session, that a `pi` process runs in it, and (best effort)
   that the parent receives a `subagent_result`;
5. kills the session and the pi process; prints PASS/FAIL with the tmux evidence
   (`list-panes -F`, `capture-pane`).
Also assert the **negative** control: same run with `TMUX` unset → Amos fails with
"tmux is required for subagents" (proves the mechanism is what fixes it).

**Phase B — plugin static validation.**
- `npx tsc --noEmit` with a local `tsconfig.json` that maps `@getpaseo/plugin*`, `@getpaseo/client`,
  `@getpaseo/protocol/*` to the checkout's `packages/*/src` **read-only** (do not add the plugin to the
  checkout's workspace).
- Unit-test the pure parts (command builders, env builder, session-name derivation, provider/purpose
  guard, fail-soft path) with `node --test` from this folder.
- Respect the compiler's SDK import boundaries (`packages/server/src/server/plugins/compiler.ts:386-440`):
  import only from `@getpaseo/plugin`, `@getpaseo/plugin/server`, `@getpaseo/plugin/client`,
  `@getpaseo/plugin/client/ui`, `@getpaseo/client`, `@getpaseo/protocol/*`, `zod`, and node builtins
  that the examples use. Mirror the import style of `plugin-examples/*`.

**Phase C — real load (attempt; if blocked, document precisely and stop).**
Build/run the daemon from the checkout **without modifying the checkout**:
`cd <paseo-checkout> && PASEO_HOME=/tmp/paseo-plugin-test-home
npx tsx packages/cli/src/index.ts daemon start` (find the correct invocation; `node_modules` is already
installed). Then install the plugin as a **directory source** — `paseo plugin install --path
<plugin-dir>`, and/or set in `/tmp/paseo-plugin-test-home/config.json`:
`"pluginsEnabled": true` and `"plugins": { "pi-tmux-bridge": { "source": "directory",
"path": "<plugin-dir>" } }` (`packages/protocol/src/plugin-config.ts:8-16`,
`packages/server/src/server/plugins/index.ts:180-215`). Then create a Pi agent and confirm the session,
the injected env, and the attach terminal. There is **no** plugin watch mode — the dev loop is
`paseo plugin reload pi-tmux-bridge`.

## 8. Context: the previous attempt (reverted, kept in `git stash@{0}`)

ChatGPT previously added an **in-daemon** Pi extension adapter
`packages/server/src/server/agent/providers/pi/extensions/pi-interactive-subagents/index.ts` (171 lines)
plus 2 lines in `extensions/registry.ts`. It only *rendered* Amos tool calls as Paseo `sub_agent`
timeline detail + a subagent list + attached child Pi session files. **It never made tmux work.** The
user chose to revert it (now `stash@{0}`, recoverable) and re-evaluate later. Do not pop it. Its
`mapToolCall`/`mapCustomMessage` shapes are still useful reference for Phase 3 field names
(`subagent_result` custom message, `details.sessionFile`, `exitCode`, `errorMessage`).

## 9. Report format (put it in VERIFICATION.md and summarise back)

- Files created (paths).
- Phase A/B/C: for each, the exact commands run and **real captured output**; explicit PASS/FAIL.
- Anything you could NOT verify, stated plainly as unverified.
- Known gaps / risks (e.g. pane capture of a TUI, terminal dedupe, macOS `sleep infinity` portability).
- Install instructions the user must run against their real Paseo.
