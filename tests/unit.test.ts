import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AMOS_LAYOUT,
  DEFAULT_LAYOUT,
  DEFAULT_PLACEHOLDER_CMD,
  DEFAULT_SESSION_PREFIX,
  DEFAULT_SHELL_READY_DELAY_MS,
  FALLBACK_PLACEHOLDER_CMD,
  SESSION_ENV_KEY,
  SHELL_READY_ENV_KEY,
  TmuxClient,
  attachArgs,
  attachTerminalName,
  buildInjectedEnv,
  buildTmuxUnavailableEnv,
  capturePaneCmd,
  displayPaneIdCmd,
  displaySocketPathCmd,
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
  parseSocketPath,
  resolvePlaceholderCommand,
  selectLayoutCmd,
  selectPaneCmd,
  sessionNameFor,
  shouldHandleSessionOpen,
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
