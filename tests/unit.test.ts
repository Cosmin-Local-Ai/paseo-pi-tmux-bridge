import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AMOS_IDENTITY_ENV_KEYS,
  AMOS_LAYOUT,
  DEFAULT_LAYOUT,
  DEFAULT_PLACEHOLDER_CMD,
  DEFAULT_SESSION_PREFIX,
  DEFAULT_SHELL_READY_DELAY_MS,
  FALLBACK_PLACEHOLDER_CMD,
  SESSION_ENV_KEY,
  SHELL_READY_ENV_KEY,
  TmuxClient,
  applyExecPlaceholders,
  attachArgs,
  attachInvocation,
  attachTerminalName,
  buildInjectedEnv,
  buildTmuxUnavailableEnv,
  capturePaneCmd,
  displayPaneIdCmd,
  displayServerPidCmd,
  displaySocketPathCmd,
  execLabel,
  hasSessionCmd,
  isOwnSessionName,
  isSafeAgentId,
  isSafeLayout,
  isSafePaneId,
  isSafeSessionName,
  killPaneCmd,
  killSessionCmd,
  listPanesCmd,
  newSessionCmd,
  parsePaneId,
  parsePaneRows,
  parsePathLookup,
  parseServerPid,
  parseSocketPath,
  pathBaseFor,
  prependToPath,
  binaryDirOf,
  resolveExecPrefix,
  resolvePlaceholderCommand,
  resolveTmuxPath,
  shellProbeInvocation,
  selectLayoutCmd,
  selectPaneCmd,
  sessionNameFor,
  shouldHandleSessionOpen,
  tmuxCandidatePaths,
  TMUX_REACHABLE_ARGS,
  TMUX_WHICH_ARGS,
  tmuxDirToInject,
  tmuxInvocation,
  TMUX_CANDIDATE_PATHS,
  TMUX_MISSING_DETAIL,
} from "../server/tmux.ts";
import type { TmuxRun, TmuxRunResult } from "../server/tmux.ts";
import { BridgeBookkeeping } from "../server/bookkeeping.ts";

// ── session naming ─────────────────────────────────────────────────────────

test("default prefix and layout match the spec", () => {
  assert.equal(DEFAULT_SESSION_PREFIX, "paseo-");
  assert.equal(DEFAULT_LAYOUT, "even-horizontal");
  assert.equal(DEFAULT_LAYOUT, AMOS_LAYOUT, "layout must match Amos's own constant");
  assert.equal(DEFAULT_PLACEHOLDER_CMD, "$SHELL -l");
  assert.equal(FALLBACK_PLACEHOLDER_CMD, "tail -f /dev/null");
  assert.equal(DEFAULT_SHELL_READY_DELAY_MS, 2000);
});

test("sessionNameFor derives prefix + agentId", () => {
  assert.equal(sessionNameFor("paseo-", "01a17eaa-94d8"), "paseo-01a17eaa-94d8");
  assert.equal(sessionNameFor("px_", "agent.1:2"), "px_agent.1:2");
});

test("sessionNameFor refuses names that could not be a safe tmux target", () => {
  assert.equal(sessionNameFor("", "abc"), null, "empty prefix");
  assert.equal(sessionNameFor("a".repeat(33), "abc"), null, "prefix too long");
  assert.equal(sessionNameFor("paseo-", ""), null, "empty agent id");
  assert.equal(sessionNameFor("paseo-", "-flag"), null, "agent id starting with a dash");
  assert.equal(sessionNameFor("paseo-", "a b"), null, "space");
  assert.equal(sessionNameFor("paseo-", "a;b"), null, "shell metacharacter");
  assert.equal(sessionNameFor("paseo-", "a|b"), null, "format separator");
  assert.equal(sessionNameFor("paseo-", "$(id)"), null, "command substitution");
  assert.equal(isSafeSessionName("paseo-x"), true);
  assert.equal(isSafeSessionName("-paseo-x"), false, "leading dash is a flag");
  assert.equal(isSafeAgentId("01a17eaa-94d8-7011"), true);
});

test("isOwnSessionName is the kill guard", () => {
  assert.equal(isOwnSessionName("paseo-agent1", "paseo-", "agent1"), true);
  assert.equal(isOwnSessionName("paseo-agent2", "paseo-", "agent1"), false, "other agent");
  assert.equal(isOwnSessionName("pi-recovery", "paseo-", "recovery"), false, "foreign session");
  assert.equal(isOwnSessionName("paseo-", "paseo-", ""), false, "no agent part");
  assert.equal(isOwnSessionName("paseo-agent1", "", "agent1"), false, "no prefix configured");
  assert.equal(isOwnSessionName("paseo-agent1", "px-", "agent1"), false, "prefix changed");
});

// ── provider / purpose guard ───────────────────────────────────────────────

test("only interactive pi sessions are handled", () => {
  assert.equal(shouldHandleSessionOpen({ provider: "pi", purpose: "interactive" }), true);
  assert.equal(shouldHandleSessionOpen({ provider: "pi", purpose: "history" }), false);
  assert.equal(shouldHandleSessionOpen({ provider: "claude", purpose: "interactive" }), false);
  assert.equal(shouldHandleSessionOpen({ provider: "codex", purpose: "history" }), false);
  assert.equal(shouldHandleSessionOpen({ provider: "Pi", purpose: "interactive" }), false);
});

test("providers derived from pi are handled, unrelated ones are not", () => {
  // Paseo reports a custom provider's own id, never "pi".
  for (const provider of ["pi-recovery", "recovery-pi", "local_pi", "pi.local", "pi"]) {
    assert.equal(
      shouldHandleSessionOpen({ provider, purpose: "interactive" }),
      true,
      `${provider} must be treated as pi`,
    );
  }
  for (const provider of ["pilot", "openapi", "claude", "codex", "copilot", "opencode", "muse"]) {
    assert.equal(
      shouldHandleSessionOpen({ provider, purpose: "interactive" }),
      false,
      `${provider} must not be treated as pi`,
    );
  }
  // An explicit id wins even when the heuristic is off; an unlisted one is skipped.
  assert.equal(
    shouldHandleSessionOpen(
      { provider: "pilot", purpose: "interactive" },
      { extraProviderIds: ["pilot"], autoDetect: false },
    ),
    true,
  );
  assert.equal(
    shouldHandleSessionOpen(
      { provider: "pi-recovery", purpose: "interactive" },
      { autoDetect: false },
    ),
    false,
  );
  assert.equal(
    shouldHandleSessionOpen({ provider: "pi-recovery", purpose: "history" }),
    false,
    "purpose still gates the hook",
  );
});

test("Amos identity variables are stripped from the injected env by default", () => {
  const base = {
    PATH: "/usr/bin",
    PI_SUBAGENT_AGENT: "worker",
    PI_SUBAGENT_NAME: "worker-fix",
    PI_SUBAGENT_ID: "e6ff031e",
    PI_SUBAGENT_ALLOWED: "scout,researcher",
    PI_SUBAGENT_AUTO_EXIT: "1",
    PI_SUBAGENT_SURFACE: "%1",
    PI_SUBAGENT_SESSION: "/tmp/s.jsonl",
    PI_SUBAGENT_ACTIVITY_FILE: "/tmp/a.json",
    PI_SESSION_FILE: "/tmp/p.jsonl",
  };
  const env = buildInjectedEnv(base, {
    socketPath: "/tmp/tmux-1000/default",
    pid: 1,
    paneId: "%3",
    sessionName: "paseo-a",
    shellReadyDelayMs: 2000,
  });
  for (const key of AMOS_IDENTITY_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must not reach a top-level agent`);
  }
  assert.equal(env.PI_SESSION_FILE, "/tmp/p.jsonl", "unrelated Pi vars survive");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(base.PI_SUBAGENT_AGENT, "worker", "the caller's object is not mutated");

  const kept = buildInjectedEnv(base, {
    socketPath: "/tmp/tmux-1000/default",
    pid: 1,
    paneId: "%3",
    sessionName: "paseo-a",
    shellReadyDelayMs: 2000,
    stripAmosIdentity: false,
  });
  assert.equal(kept.PI_SUBAGENT_AGENT, "worker");

  const soft = buildTmuxUnavailableEnv(base, { shellReadyDelayMs: 2000 });
  assert.equal(soft.PI_SUBAGENT_AGENT, undefined);
  assert.equal(soft.TMUX, "");
});

// ── env construction ───────────────────────────────────────────────────────

test("buildInjectedEnv spreads the base env and sets exactly the bridge keys", () => {
  const base = { PATH: "/usr/bin", TMUX: "/tmp/tmux-1000/default,265,0", TMUX_PANE: "%7", KEEP: "1" };
  const env = buildInjectedEnv(base, {
    socketPath: "/tmp/tmux-1000/default",
    pid: 4242,
    paneId: "%12",
    sessionName: "paseo-agent1",
    shellReadyDelayMs: 2000,
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.KEEP, "1");
  assert.equal(env.TMUX, "/tmp/tmux-1000/default,4242,0");
  assert.equal(env.TMUX_PANE, "%12");
  assert.equal(env[SESSION_ENV_KEY], "paseo-agent1");
  assert.equal(env[SHELL_READY_ENV_KEY], "2000");
  assert.notEqual(env.TMUX, base.TMUX, "the inherited daemon pane must be replaced");
  // 4 base keys survive; TMUX/TMUX_PANE are overwritten, 2 bridge keys added.
  assert.equal(Object.keys(env).length, 6);
});

test("buildInjectedEnv does not mutate the request env", () => {
  const base = { PATH: "/usr/bin" };
  buildInjectedEnv(base, {
    socketPath: "/s",
    pid: 1,
    paneId: "%1",
    sessionName: "paseo-a",
    shellReadyDelayMs: 0,
  });
  assert.deepEqual(base, { PATH: "/usr/bin" });
});

test("buildInjectedEnv prepends the resolved tmux directory to the agent PATH", () => {
  // Amos runs `command -v tmux` inside the agent, so the agent must be able to
  // find tmux even when the daemon's PATH has no directory for it.
  const base = { PATH: "/usr/local/bin:/home/cosmin/.local/bin", KEEP: "1" };
  const env = buildInjectedEnv(base, {
    socketPath: "/s",
    pid: 1,
    paneId: "%1",
    sessionName: "paseo-a",
    shellReadyDelayMs: 0,
    tmuxPath: "/usr/bin/tmux",
  });
  assert.equal(env.PATH, "/usr/bin:/usr/local/bin:/home/cosmin/.local/bin");
  assert.equal(env.KEEP, "1");
  assert.ok(env.PATH.split(":").includes("/usr/bin"));
});

test("buildInjectedEnv leaves PATH alone when nothing resolved and does not duplicate it", () => {
  const noTmux = buildInjectedEnv({ PATH: "/usr/bin" }, {
    socketPath: "/s",
    pid: 1,
    paneId: "%1",
    sessionName: "paseo-a",
    shellReadyDelayMs: 0,
    tmuxPath: null,
  });
  assert.equal(noTmux.PATH, "/usr/bin");

  const already = buildInjectedEnv({ PATH: "/usr/bin:/bin" }, {
    socketPath: "/s",
    pid: 1,
    paneId: "%1",
    sessionName: "paseo-a",
    shellReadyDelayMs: 0,
    tmuxPath: "/usr/bin/tmux",
  });
  assert.equal(already.PATH, "/usr/bin:/bin", "resume/refresh must not duplicate the directory");
});

test("buildInjectedEnv never emits a PATH that holds only the tmux directory", () => {
  // Paseo replaces the daemon PATH with the hook PATH, so a lone directory would
  // break `spawn pi` with ENOENT.
  const env = buildInjectedEnv({ HOME: "/home/cosmin" }, {
    socketPath: "/s",
    pid: 1,
    paneId: "%1",
    sessionName: "paseo-a",
    shellReadyDelayMs: 0,
    tmuxPath: "/snap/bin/tmux",
  });
  assert.equal(env.PATH, undefined, "no base PATH means leave PATH to the daemon");
  assert.equal(env.TMUX, "/s,1,0", "the bridge keys are still injected");
});

test("pathBaseFor falls back to the daemon PATH, which is what the hook replaces", () => {
  assert.equal(pathBaseFor("/a:/b", "/c:/d"), "/a:/b");
  assert.equal(pathBaseFor(undefined, "/c:/d"), "/c:/d");
  assert.equal(pathBaseFor("", "/c:/d"), "/c:/d");
  assert.equal(pathBaseFor(undefined, undefined), undefined);
});

test("the hook env keeps the daemon PATH and gains the tmux directory", () => {
  // Mirrors what index.server.ts does: request.env is usually sparse.
  const requestEnv: Record<string, string> = { KEEP: "1" };
  const daemonPath = "/tmp/no-tmux-bin:/usr/local/bin:/usr/local/share/npm-global/bin";
  const pathBase = pathBaseFor(requestEnv.PATH, daemonPath);
  const base: Record<string, string> = pathBase ? { ...requestEnv, PATH: pathBase } : requestEnv;
  const env = buildInjectedEnv(base, {
    socketPath: "/s",
    pid: 1,
    paneId: "%1",
    sessionName: "paseo-a",
    shellReadyDelayMs: 0,
    tmuxPath: "/usr/bin/tmux",
  });
  assert.equal(
    env.PATH,
    `/usr/bin:${daemonPath}`,
    "tmux first, every daemon directory preserved so pi still resolves",
  );
  assert.equal(env.KEEP, "1");
});

test("fail-soft env clears TMUX so Amos reports its own error", () => {
  const base = { PATH: "/usr/bin", TMUX: "/tmp/tmux-1000/default,265,0", TMUX_PANE: "%7" };
  const env = buildTmuxUnavailableEnv(base, { shellReadyDelayMs: 2000 });
  assert.equal(env.TMUX, "");
  assert.equal(env.TMUX_PANE, "");
  assert.equal(env[SESSION_ENV_KEY], "");
  assert.equal(env[SHELL_READY_ENV_KEY], "2000");
  assert.equal(env.PATH, "/usr/bin");
  assert.ok(!env.TMUX, "empty string must be falsy so isTmuxAvailable() is false");
});

// ── placeholder ────────────────────────────────────────────────────────────

test("resolvePlaceholderCommand substitutes SHELL and falls back", () => {
  assert.equal(resolvePlaceholderCommand("$SHELL -l", { SHELL: "/bin/bash" }), "/bin/bash -l");
  assert.equal(resolvePlaceholderCommand("${SHELL} -l", { SHELL: "/bin/zsh" }), "/bin/zsh -l");
  assert.equal(resolvePlaceholderCommand("$SHELL -l", {}), "/bin/sh -l");
  assert.equal(resolvePlaceholderCommand("", { SHELL: "/bin/bash" }), FALLBACK_PLACEHOLDER_CMD);
  assert.equal(resolvePlaceholderCommand("   ", {}), FALLBACK_PLACEHOLDER_CMD);
  assert.equal(resolvePlaceholderCommand("tail -f /dev/null", {}), "tail -f /dev/null");
});

// ── argv builders ──────────────────────────────────────────────────────────

test("command builders produce the spec'd argv", () => {
  assert.deepEqual(hasSessionCmd("paseo-a"), ["has-session", "-t", "paseo-a"]);
  assert.deepEqual(
    newSessionCmd({ name: "paseo-a", cwd: "/w", cols: 220, rows: 60, placeholder: "/bin/bash -l" }),
    ["new-session", "-d", "-s", "paseo-a", "-c", "/w", "-x", "220", "-y", "60", "/bin/bash -l"],
  );
  assert.deepEqual(selectLayoutCmd("paseo-a", "even-horizontal"), [
    "select-layout",
    "-t",
    "paseo-a",
    "even-horizontal",
  ]);
  assert.deepEqual(displayPaneIdCmd("paseo-a"), [
    "display-message",
    "-p",
    "-t",
    "paseo-a",
    "#{pane_id}",
  ]);
  assert.deepEqual(displaySocketPathCmd(), ["display-message", "-p", "#{socket_path}"]);
  assert.deepEqual(killSessionCmd("paseo-a"), ["kill-session", "-t", "paseo-a"]);
  assert.deepEqual(selectPaneCmd("%12"), ["select-pane", "-t", "%12"]);
  assert.deepEqual(killPaneCmd("%12"), ["kill-pane", "-t", "%12"]);
  assert.deepEqual(attachArgs("paseo-a"), ["attach", "-t", "paseo-a"]);
  assert.equal(attachTerminalName("agent1"), "pi-tmux:agent1");
  assert.deepEqual(listPanesCmd("paseo-a"), [
    "list-panes",
    "-t",
    "paseo-a",
    "-F",
    "#{pane_id}|#{pane_index}|#{pane_current_command}|#{pane_pid}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}",
  ]);
});

test("capturePaneCmd clamps the history window", () => {
  assert.deepEqual(capturePaneCmd("%3", 15), ["capture-pane", "-p", "-t", "%3", "-S", "-15"]);
  assert.deepEqual(capturePaneCmd("%3", 0), ["capture-pane", "-p", "-t", "%3", "-S", "-1"]);
  assert.deepEqual(capturePaneCmd("%3", -7), ["capture-pane", "-p", "-t", "%3", "-S", "-1"]);
  assert.deepEqual(capturePaneCmd("%3", 9999), ["capture-pane", "-p", "-t", "%3", "-S", "-2000"]);
});

test("safety validators", () => {
  assert.equal(isSafePaneId("%12"), true);
  assert.equal(isSafePaneId("12"), false);
  assert.equal(isSafePaneId("%1;kill-server"), false);
  assert.equal(isSafeLayout("even-horizontal"), true);
  assert.equal(isSafeLayout("main-vertical"), true);
  assert.equal(isSafeLayout("-x"), false);
  assert.equal(isSafeLayout("a;b"), false);
});

// ── parsers ────────────────────────────────────────────────────────────────

test("parsePaneRows reads the formatted listing", () => {
  const out =
    "%10|0|bash|7041|pi-recovery-test|220|60|1\n%11|1|node|7106|pi|109|59|0\nnot-a-pane\n";
  const rows = parsePaneRows(out);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.paneId),
    ["%10", "%11"],
  );
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].active, false);
  assert.equal(rows[1].paneCurrentCommand, "node");
  assert.equal(rows[1].paneWidth, "109");
});

test("parsers reject malformed output", () => {
  assert.equal(parsePaneId("%12\n"), "%12");
  assert.equal(parsePaneId("garage"), null);
  assert.equal(parsePaneId(""), null);
  assert.equal(parseSocketPath("/tmp/tmux-1000/default"), "/tmp/tmux-1000/default");
  assert.equal(parseSocketPath(""), null);
  assert.equal(parseSocketPath("a\nb"), null);
});

// ── TmuxClient.ensureSession ───────────────────────────────────────────────

/**
 * Scripted tmux runner. Each entry is consumed once, in order, so a later call
 * with the same argv prefix falls through to the default success. That is how
 * the placeholder-fallback path is exercised.
 */
function fakeTmux(script: Array<{ match: string[]; result: TmuxRunResult }>) {
  const calls: string[][] = [];
  const remaining = [...script];
  const run: TmuxRun = async (args) => {
    calls.push(args);
    const index = remaining.findIndex((entry) =>
      entry.match.every((token, i) => args[i] === token),
    );
    if (index !== -1) {
      const [step] = remaining.splice(index, 1);
      return step!.result;
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const ok = (stdout = ""): TmuxRunResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr = "no session"): TmuxRunResult => ({ ok: false, stdout: "", stderr });

test("ensureSession creates the session when it is missing", async () => {
  const { run, calls } = fakeTmux([
    { match: ["has-session"], result: fail() },
    { match: ["display-message", "-p", "-t", "paseo-a", "#{pane_id}"], result: ok("%42\n") },
    { match: ["display-message", "-p", "#{socket_path}"], result: ok("/tmp/tmux-1000/default\n") },
  ]);
  const client = new TmuxClient(run);
  const result = await client.ensureSession({
    name: "paseo-a",
    cwd: "/w",
    cols: 220,
    rows: 60,
    placeholder: "/bin/bash -l",
    layout: "even-horizontal",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.handle.paneId, "%42");
  assert.equal(result.handle.socketPath, "/tmp/tmux-1000/default");
  assert.equal(result.handle.created, true);
  assert.deepEqual(calls[0], ["has-session", "-t", "paseo-a"]);
  assert.deepEqual(calls[1], [
    "new-session",
    "-d",
    "-s",
    "paseo-a",
    "-c",
    "/w",
    "-x",
    "220",
    "-y",
    "60",
    "/bin/bash -l",
  ]);
  assert.deepEqual(calls[2], ["select-layout", "-t", "paseo-a", "even-horizontal"]);
});

test("ensureSession reuses an existing session and never kills it", async () => {
  const { run, calls } = fakeTmux([
    { match: ["has-session"], result: ok() },
    { match: ["display-message", "-p", "-t", "paseo-a", "#{pane_id}"], result: ok("%77\n") },
    { match: ["display-message", "-p", "#{socket_path}"], result: ok("/sock\n") },
  ]);
  const result = await new TmuxClient(run).ensureSession({
    name: "paseo-a",
    cwd: "/w",
    cols: 220,
    rows: 60,
    placeholder: "/bin/bash -l",
    layout: "even-horizontal",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.handle.created, false, "resume/refresh must reuse");
  assert.equal(result.handle.paneId, "%77", "pane id must be re-read");
  assert.equal(calls.some((args) => args[0] === "new-session"), false, "must not re-create");
  assert.equal(calls.some((args) => args[0] === "kill-session"), false, "must never kill");
});

test("ensureSession falls back to a command that cannot exit", async () => {
  const { run, calls } = fakeTmux([
    { match: ["has-session"], result: fail() },
    { match: ["new-session"], result: fail("bad placeholder: no such file") },
    { match: ["display-message", "-p", "-t", "paseo-a", "#{pane_id}"], result: ok("%9\n") },
    { match: ["display-message", "-p", "#{socket_path}"], result: ok("/sock\n") },
  ]);
  const result = await new TmuxClient(run).ensureSession({
    name: "paseo-a",
    cwd: "/w",
    cols: 220,
    rows: 60,
    placeholder: "/definitely/not/a/shell",
    layout: "even-horizontal",
  });
  assert.equal(result.ok, true);
  const second = calls.filter((args) => args[0] === "new-session");
  assert.equal(second.length, 2);
  assert.equal(second[1][second[1].length - 1], FALLBACK_PLACEHOLDER_CMD);
});

test("ensureSession fails soft when tmux refuses to create the session", async () => {
  const { run } = fakeTmux([
    { match: ["has-session"], result: fail() },
    { match: ["new-session"], result: fail("boom: cannot create session") },
    { match: ["new-session"], result: fail("boom again") },
  ]);
  const result = await new TmuxClient(run).ensureSession({
    name: "paseo-a",
    cwd: "/w",
    cols: 220,
    rows: 60,
    placeholder: "/bin/sh",
    layout: "even-horizontal",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "new-session");
  assert.match(result.message, /boom/);
});

test("ensureSession rejects an unsafe session name before touching tmux", async () => {
  let touched = false;
  const result = await new TmuxClient(async (args) => {
    touched = true;
    return { ok: true, stdout: args.join(" "), stderr: "" };
  }).ensureSession({
    name: "-x; rm -rf /",
    cwd: "/w",
    cols: 220,
    rows: 60,
    placeholder: "/bin/sh",
    layout: "even-horizontal",
  });
  assert.equal(touched, false);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "name");
});

test("ensureSession reports missing pane id / socket as failures", async () => {
  const noPane = fakeTmux([
    { match: ["has-session"], result: ok() },
    { match: ["display-message", "-p", "-t", "paseo-a", "#{pane_id}"], result: fail("no such") },
  ]);
  const a = await new TmuxClient(noPane.run).ensureSession({
    name: "paseo-a",
    cwd: "/w",
    cols: 220,
    rows: 60,
    placeholder: "/bin/sh",
    layout: "even-horizontal",
  });
  assert.equal(a.ok, false);
  if (a.ok) return;
  assert.equal(a.stage, "pane-id");

  const noSocket = fakeTmux([
    { match: ["has-session"], result: ok() },
    { match: ["display-message", "-p", "-t", "paseo-a", "#{pane_id}"], result: ok("%3\n") },
    { match: ["display-message", "-p", "#{socket_path}"], result: fail() },
  ]);
  const b = await new TmuxClient(noSocket.run).ensureSession({
    name: "paseo-a",
    cwd: "/w",
    cols: 220,
    rows: 60,
    placeholder: "/bin/sh",
    layout: "even-horizontal",
  });
  assert.equal(b.ok, false);
  if (b.ok) return;
  assert.equal(b.stage, "socket");
});

test("probe reflects tmux availability", async () => {
  assert.equal(await new TmuxClient(async () => ok("tmux 3.6")).probe(), true);
  assert.equal(await new TmuxClient(async () => fail("spawn tmux ENOENT")).probe(), false);
});

test("pane operations refuse unsafe pane ids", async () => {
  const client = new TmuxClient(async () => ok());
  assert.equal((await client.capturePane("%1;kill-server", 15)).ok, false);
  assert.equal((await client.selectPane("nope")).ok, false);
  assert.equal((await client.killPane("%")).ok, false);
  assert.equal((await client.killSession("-x")).ok, false);
  assert.equal(await client.sessionExists("bad name"), false);
  assert.deepEqual(await client.listPanes("bad name"), []);
});

// ── bookkeeping ────────────────────────────────────────────────────────────

test("bookkeeping keeps the terminal id across resume/refresh", () => {
  const map = new BridgeBookkeeping();
  map.rememberOpened({ agentId: "a1", sessionName: "paseo-a1", workspaceId: "w1", cwd: "/w" });
  map.rememberTerminal("a1", "t1", "pi-tmux:a1");
  map.rememberOpened({ agentId: "a1", sessionName: "paseo-a1", workspaceId: "w1", cwd: "/w" });
  const record = map.get("a1");
  assert.equal(record?.terminalId, "t1");
  assert.equal(record?.terminalName, "pi-tmux:a1");
  assert.equal(map.size, 1);
});

test("beginTerminal dedupes concurrent terminal creation", () => {
  const map = new BridgeBookkeeping();
  assert.equal(map.beginTerminal("a1"), true);
  assert.equal(map.beginTerminal("a1"), false);
  map.endTerminal("a1");
  assert.equal(map.beginTerminal("a1"), true);
});

test("forget clears the record and any in-flight flag", () => {
  const map = new BridgeBookkeeping();
  map.rememberOpened({ agentId: "a1", sessionName: "paseo-a1", workspaceId: null, cwd: "/w" });
  map.beginTerminal("a1");
  const removed = map.forget("a1");
  assert.equal(removed?.sessionName, "paseo-a1");
  assert.equal(map.has("a1"), false);
  assert.equal(map.size, 0);
  assert.equal(map.beginTerminal("a1"), true, "in-flight flag cleared with the record");
});

test("orphan terminal still records a session-less entry", () => {
  const map = new BridgeBookkeeping();
  map.rememberTerminal("a9", "t9", "pi-tmux:a9");
  assert.equal(map.get("a9")?.terminalId, "t9");
  assert.equal(map.get("a9")?.sessionName, "");
});

// ── tmux resolution (the "tmux is not on PATH" failure mode) ───────────────

test("candidate list probes the documented paths in order", () => {
  const paths = tmuxCandidatePaths("/home/cosmin");
  assert.deepEqual(paths.slice(0, 6), [
    "/usr/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/local/sbin/tmux",
    "/opt/homebrew/bin/tmux",
    "/opt/local/bin/tmux",
    "/snap/bin/tmux",
  ]);
  assert.equal(paths[6], "/home/cosmin/.local/bin/tmux");
  assert.equal(paths[7], "/run/current-system/sw/bin/tmux");
  assert.equal(paths.length, TMUX_CANDIDATE_PATHS.length);
  assert.ok(!paths.some((candidate) => candidate.includes("$HOME")));
  assert.ok(
    !tmuxCandidatePaths(undefined).some((candidate) => candidate.includes(".local/bin")),
    "no HOME must skip the $HOME candidate rather than probe a literal $HOME path",
  );
});

test("an explicit tmuxPath is authoritative: a bad override fails instead of falling back", () => {
  const res = resolveTmuxPath(
    {
      configured: "/opt/tools/tmux",
      pathLookup: "/usr/bin/tmux",
      candidates: tmuxCandidatePaths("/home/u"),
    },
    (candidate) => candidate === "/usr/bin/tmux",
  );
  assert.equal(res.path, null);
  assert.deepEqual(res.tried, ["tmuxPath=/opt/tools/tmux (not executable)"]);
});

test("an explicit tmuxPath wins when it is usable", () => {
  const res = resolveTmuxPath(
    { configured: "/opt/tools/tmux", pathLookup: "/usr/bin/tmux", candidates: [] },
    (candidate) => candidate === "/opt/tools/tmux",
  );
  assert.equal(res.path, "/opt/tools/tmux");
});

test("PATH lookup wins over candidates, then candidates are probed in order", () => {
  const candidates = tmuxCandidatePaths("/home/u");
  const viaPath = resolveTmuxPath(
    { configured: "", pathLookup: "/home/u/tools/tmux", candidates },
    (candidate) => candidate === "/home/u/tools/tmux" || candidate === "/usr/bin/tmux",
  );
  assert.equal(viaPath.path, "/home/u/tools/tmux");
  assert.deepEqual(viaPath.tried, ["PATH (/home/u/tools/tmux)"]);

  const firstCandidate = resolveTmuxPath(
    { configured: "", pathLookup: null, candidates },
    (candidate) => candidate === "/usr/bin/tmux" || candidate === "/snap/bin/tmux",
  );
  assert.equal(firstCandidate.path, "/usr/bin/tmux", "earliest usable candidate wins");

  const onlySnap = resolveTmuxPath(
    { configured: "", pathLookup: "", candidates },
    (candidate) => candidate === "/snap/bin/tmux",
  );
  assert.equal(onlySnap.path, "/snap/bin/tmux");
});

test("an unresolvable tmux reports every location it tried", () => {
  const res = resolveTmuxPath(
    { configured: "", pathLookup: null, candidates: tmuxCandidatePaths("/home/u") },
    () => false,
  );
  assert.equal(res.path, null);
  assert.equal(res.tried[0], "PATH (command -v tmux: not found)");
  assert.equal(res.tried.length, 1 + TMUX_CANDIDATE_PATHS.length);
  assert.ok(res.tried.includes("/usr/bin/tmux"));
  assert.match(TMUX_MISSING_DETAIL, /tmuxPath/);
});

test("parsePathLookup takes the shell answer and rejects junk", () => {
  assert.equal(parsePathLookup("/usr/bin/tmux\n"), "/usr/bin/tmux");
  assert.equal(parsePathLookup("\n/usr/local/bin/tmux\nignored"), "/usr/local/bin/tmux");
  assert.equal(parsePathLookup("tmux not found"), null);
  assert.equal(parsePathLookup("./tmux"), null);
  assert.equal(parsePathLookup(""), null);
});

test("prependToPath keeps the existing PATH intact and honours the delimiter", () => {
  assert.equal(prependToPath("/usr/bin:/bin", "/usr/local/bin"), "/usr/local/bin:/usr/bin:/bin");
  assert.equal(prependToPath("/usr/bin", "/usr/bin"), "/usr/bin", "no duplicate on resume/refresh");
  assert.equal(prependToPath(undefined, "/usr/bin"), undefined, "never invent a PATH");
  assert.equal(prependToPath("", "/usr/bin"), "/usr/bin");
  assert.equal(prependToPath("C:\\a;C:\\b", "C:\\tmux", ";"), "C:\\tmux;C:\\a;C:\\b");
  assert.equal(prependToPath("/usr/bin", null), "/usr/bin", "nothing resolved means PATH untouched");
});

test("binaryDirOf yields the directory that must go on PATH", () => {
  assert.equal(binaryDirOf("/usr/bin/tmux"), "/usr/bin");
  assert.equal(binaryDirOf("/snap/bin/tmux"), "/snap/bin");
  assert.equal(binaryDirOf("tmux"), null);
  assert.equal(binaryDirOf(null), null);
});

test("fail-soft env still exposes a resolved tmux directory to the agent", () => {
  const env = buildTmuxUnavailableEnv({ PATH: "/usr/local/bin" }, {
    shellReadyDelayMs: 0,
    tmuxPath: "/usr/bin/tmux",
  });
  assert.equal(env.PATH, "/usr/bin:/usr/local/bin");
  assert.equal(env.TMUX, "");
});

// ── namespace prefixes (sandboxed / containerised providers) ────────────────

const SBX_PREFIX = ["sbx", "exec", "-i", "-w", "{cwd}", "pi-recovery-test", "--"];

test("prefix placeholders are substituted in every element", () => {
  const values = { cwd: "/home/cosmin/work", agentId: "a1b2" };
  assert.deepEqual(applyExecPlaceholders(SBX_PREFIX, values), [
    "sbx",
    "exec",
    "-i",
    "-w",
    "/home/cosmin/work",
    "pi-recovery-test",
    "--",
  ]);
  assert.deepEqual(applyExecPlaceholders(["echo", "{agentId}", "{agentId}/{cwd}"], values), [
    "echo",
    "a1b2",
    "a1b2//home/cosmin/work",
  ]);
  assert.deepEqual(applyExecPlaceholders([], values), []);
});

test("provider prefix wins, an explicit empty entry means the host, else the global prefix", () => {
  const map = { "pi-recovery": SBX_PREFIX, pi: [] };
  assert.deepEqual(resolveExecPrefix({ provider: "pi-recovery", providerTmuxExec: map, tmuxExec: ["ssh", "box"] }), SBX_PREFIX);
  assert.deepEqual(resolveExecPrefix({ provider: "pi", providerTmuxExec: map, tmuxExec: ["ssh", "box"] }), []);
  assert.deepEqual(resolveExecPrefix({ provider: "pi-other", providerTmuxExec: map, tmuxExec: ["ssh", "box"] }), [
    "ssh",
    "box",
  ]);
  assert.deepEqual(resolveExecPrefix({ provider: "pi-other", providerTmuxExec: map }), []);
  assert.deepEqual(resolveExecPrefix({ provider: "pi" }), []);
});

test("an empty prefix keeps the host invocation byte-compatible", () => {
  assert.deepEqual(tmuxInvocation("/usr/bin/tmux", [], ["new-session", "-d"]), {
    command: "/usr/bin/tmux",
    args: ["new-session", "-d"],
  });
});

test("a prefix wraps tmux: the wrapper runs, tmux follows its own argv", () => {
  const values = { cwd: "/srv/app", agentId: "ag1" };
  const prefix = applyExecPlaceholders(SBX_PREFIX, values);
  assert.deepEqual(tmuxInvocation("/usr/bin/tmux", prefix, ["ls", "-t", "paseo-ag1"]), {
    command: "sbx",
    args: ["exec", "-i", "-w", "/srv/app", "pi-recovery-test", "--", "/usr/bin/tmux", "ls", "-t", "paseo-ag1"],
  });
  assert.deepEqual(attachInvocation("/usr/bin/tmux", prefix, "paseo-ag1").args, [
    "exec",
    "-i",
    "-w",
    "/srv/app",
    "pi-recovery-test",
    "--",
    "/usr/bin/tmux",
    "attach",
    "-t",
    "paseo-ag1",
  ]);
});

test("probes run inside the namespace too", () => {
  const prefix = applyExecPlaceholders(SBX_PREFIX, { cwd: "/srv/app", agentId: "ag1" });
  assert.deepEqual(shellProbeInvocation(prefix, "/bin/sh", ["-lc", "command -v tmux"]), {
    command: "sbx",
    args: ["exec", "-i", "-w", "/srv/app", "pi-recovery-test", "--", "/bin/sh", "-lc", "command -v tmux"],
  });
  assert.deepEqual(shellProbeInvocation([], "/usr/bin/tmux", ["-V"]), {
    command: "/usr/bin/tmux",
    args: ["-V"],
  });
});

test("the namespace label is short and stable", () => {
  assert.equal(execLabel(SBX_PREFIX), "sbx:pi-recovery-test");
  assert.equal(execLabel([]), "host");
  assert.equal(execLabel(["/usr/local/bin/nsenter", "--mount=/x.mntns", "--"]), "nsenter");
  assert.equal(execLabel(["ssh", "box"]), "ssh:box");
});

test("PATH is only rewritten when tmux is not reachable inside the namespace", () => {
  // Their container ships tmux on its own PATH: rewriting would inject a host
  // directory that does not exist there.
  assert.equal(tmuxDirToInject({ path: "/usr/bin/tmux", reachableInPath: true }), null);
  assert.equal(tmuxDirToInject({ path: "/usr/bin/tmux", reachableInPath: false }), "/usr/bin");
  assert.equal(tmuxDirToInject({ path: null, reachableInPath: false }), null);

  const env = buildInjectedEnv({ PATH: "/usr/local/bin:/bin" }, {
    socketPath: "/tmp/tmux-1000/default",
    pid: 4242,
    paneId: "%9",
    sessionName: "paseo-a",
    shellReadyDelayMs: 0,
    tmuxPath: "/usr/bin/tmux",
    injectTmuxDir: false,
  });
  assert.equal(env.PATH, "/usr/local/bin:/bin", "container already has tmux: leave PATH alone");
  assert.equal(env.TMUX, "/tmp/tmux-1000/default,4242,0");
});

test("the TMUX pid is the server pid inside the namespace, not the daemon's", async () => {
  assert.deepEqual(displayServerPidCmd(), ["display-message", "-p", "#{pid}"]);
  assert.equal(parseServerPid("24601\n"), 24601);
  assert.equal(parseServerPid("not-a-pid"), null);
  assert.equal(parseServerPid(""), null);

  const seen: string[][] = [];
  const client = new TmuxClient(async (args) => {
    seen.push(args);
    if (args[0] === "has-session") return { ok: true, stdout: "", stderr: "" };
    if (args[0] === "display-message" && args[args.length - 1] === "#{pane_id}") {
      return { ok: true, stdout: "%7\n", stderr: "" };
    }
    if (args[0] === "display-message" && args[args.length - 1] === "#{socket_path}") {
      return { ok: true, stdout: "/tmp/tmux-1000/default\n", stderr: "" };
    }
    if (args[0] === "display-message" && args[args.length - 1] === "#{pid}") {
      return { ok: true, stdout: "24601\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  });
  const result = await client.ensureSession({
    name: "paseo-a",
    cwd: "/srv/app",
    cols: 220,
    rows: 60,
    placeholder: "$SHELL -l",
    layout: AMOS_LAYOUT,
  });
  assert.ok(result.ok);
  assert.equal(result.handle.socketPath, "/tmp/tmux-1000/default");
  assert.equal(result.handle.serverPid, 24601, "the pid inside the namespace, not the daemon's");
  assert.ok(
    seen.some((args) => args[0] === "display-message" && args[args.length - 1] === "#{pid}"),
    "the server pid must be asked for inside the namespace",
  );
});

test("bookkeeping pins the namespace the session was created in", () => {
  const map = new BridgeBookkeeping();
  map.rememberOpened({
    agentId: "a7",
    sessionName: "paseo-a7",
    workspaceId: "w1",
    cwd: "/srv/app",
    provider: "pi-recovery",
    tmuxPath: "/usr/bin/tmux",
    tmuxPrefix: [...SBX_PREFIX],
    tmuxLabel: "sbx:pi-recovery-test",
  });
  const record = map.get("a7");
  assert.equal(record?.provider, "pi-recovery");
  assert.equal(record?.tmuxPath, "/usr/bin/tmux");
  assert.deepEqual(record?.tmuxPrefix, SBX_PREFIX);
  assert.equal(record?.tmuxLabel, "sbx:pi-recovery-test");
  // A later resume without namespace info must not lose what was recorded.
  map.rememberOpened({ agentId: "a7", sessionName: "paseo-a7", workspaceId: "w1", cwd: "/srv/app" });
  assert.equal(map.get("a7")?.tmuxLabel, "sbx:pi-recovery-test");
});

test("the resolution probe and the agent-PATH probe are different on purpose", () => {
  // The login shell may find tmux where the agent PATH cannot; if the same argv
  // were used for both, no PATH would be injected and Amos would fail.
  assert.deepEqual(TMUX_WHICH_ARGS, ["-lc", "command -v tmux"]);
  assert.deepEqual(TMUX_REACHABLE_ARGS, ["-c", "command -v tmux"]);
  assert.notDeepEqual(TMUX_REACHABLE_ARGS, TMUX_WHICH_ARGS);
  assert.equal(tmuxDirToInject({ path: "/usr/bin/tmux", reachableInPath: undefined }), null);
});
