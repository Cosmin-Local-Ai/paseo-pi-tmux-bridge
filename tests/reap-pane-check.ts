/**
 * Live check for finished-pane transcripts — the part the unit tests cannot reach.
 *
 * The wiring lives inside the plugin activation closure in `index.server.ts`,
 * which this repo cannot unit-test, and it needs a real daemon to fire. What this
 * script proves without Paseo is that the pieces that wiring calls behave as
 * claimed against a **real tmux**, in both regimes:
 *
 *   scenario 1 — `remain-on-exit on` (what `keepFinishedPanes` opts into):
 *       the finished pane stays visible as `pane_dead=1`, the reap picks it and
 *       not the placeholder, the transcript is still readable, and the order is
 *       capture → kill.
 *   scenario 2 — the tmux default, `remain-on-exit off` (what this box actually
 *       runs, and why the reap above never fires there): the finished pane is
 *       **removed** from `list-panes`, and the vanished check promotes the capture
 *       the plugin still holds into the finished list.
 *   scenario 3 — the false-positive guard: a listing that failed is not a listing
 *       of nothing, and must not put every pane into the finished list.
 *
 * Run it with any Paseo checkout's tsx (the plugin is TypeScript and has no
 * package.json of its own):
 *
 *   CHECKOUT=$HOME/src/paseo npx --prefix "$CHECKOUT" tsx tests/reap-pane-check.ts
 *
 * Only ever creates and kills its own sessions, named
 * `pi-tmux-bridge-reap-check-<pid>[-b]`. It never touches another session.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

import {
  TmuxClient,
  finishedCaptureLines,
  finishedEntry,
  pushFinishedPane,
  selectReapablePanes,
  selectVanishedPanes,
  trackPane,
  type FinishedPane,
  type TmuxPane,
} from "../server/tmux.ts";

const SESSION = `pi-tmux-bridge-reap-check-${process.pid}`;
const MARKER_LINES = 30;
const TMUX = process.env.TMUX_PATH ?? "tmux";

const exec = promisify(execFile);
const calls: string[] = [];

/** The same `TmuxRun` shape `TmuxClient` takes in production. */
async function run(args: string[]) {
  calls.push(args.join(" "));
  try {
    const { stdout, stderr } = await exec(TMUX, args, {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? "",
      stderr: (failure.stderr ?? failure.message ?? "tmux failed").trim(),
    };
  }
}

function step(message: string): void {
  console.log(`  ${message}`);
}

function describe(panes: TmuxPane[]): string {
  return panes.map((pane) => `${pane.paneId}(idx ${pane.paneIndex}, dead=${pane.dead})`).join(" ");
}

/** Placeholder plus a subagent pane that prints markers and then exits. */
async function createSession(name: string): Promise<void> {
  await run(["kill-session", "-t", name]);
  const created = await run([
    "new-session", "-d", "-s", name, "-x", "100", "-y", "20", "-c", "/tmp", "bash",
  ]);
  assert.ok(created.ok, `new-session failed: ${created.stderr}`);
  const split = await run([
    "split-window", "-h", "-t", name, "-p", "30",
    `for i in $(seq 1 ${MARKER_LINES}); do echo LINE-$i; done; sleep 2`,
  ]);
  assert.ok(split.ok, `split-window failed: ${split.stderr}`);
}

/**
 * Scenario 1: `remain-on-exit on`, so the finished pane is still there to reap.
 * Proves the dead detection, the placeholder exemption, the readable transcript,
 * and capture-before-kill ordering.
 */
async function scenarioReap(tmux: TmuxClient, name: string): Promise<void> {
  await createSession(name);
  // The plugin's own opt-in: keepFinishedPanes sets this in ensureSession.
  assert.ok((await run(["set-option", "-t", name, "remain-on-exit", "on"])).ok);
  await new Promise((resolve) => setTimeout(resolve, 2600));

  const listed = await tmux.tryListPanes(name);
  assert.ok(listed.ok, `list-panes failed: ${listed.stderr}`);
  step(`list-panes: ${describe(listed.panes)}`);
  assert.ok(listed.panes.some((pane) => pane.dead), "tmux kept no dead pane — no pane_dead support?");

  const reapable = selectReapablePanes(listed.panes, { reapDeadPanes: true });
  assert.equal(reapable.length, 1, `expected one reap candidate, got ${reapable.length}`);
  assert.notEqual(reapable[0].paneIndex, "0", "the placeholder pane was selected for reaping");
  step(`reap candidate: ${reapable[0].paneId} (index ${reapable[0].paneIndex})`);

  let finished: FinishedPane[] = [];
  for (const pane of reapable) {
    const captured = await tmux.capturePane(pane.paneId, finishedCaptureLines(15));
    assert.ok(captured.ok, `capture-pane failed: ${captured.stderr}`);
    const history = captured.stdout.split("\n").filter((line) => line.startsWith("LINE-"));
    assert.equal(history.length, MARKER_LINES, `transcript lost history: ${history.length}`);
    step(`captured ${history.length} history lines at depth ${finishedCaptureLines(15)}`);
    const killed = await tmux.killPane(pane.paneId);
    assert.ok(killed.ok, `kill-pane failed: ${killed.stderr}`);
    finished = pushFinishedPane(
      finished,
      finishedEntry(trackPane(pane), captured.stdout.trim(), "reaped", Date.now()),
      6,
    );
  }

  // Order is the invariant: capture first, kill second, per pane.
  const reaperCalls = calls.filter(
    (line) => line.startsWith("capture-pane") || line.startsWith("kill-pane"),
  );
  assert.deepEqual(
    reaperCalls.map((line) => line.split(" ")[0]),
    ["capture-pane", "kill-pane"],
    `reap order wrong: ${reaperCalls.join(" | ")}`,
  );

  const after = await tmux.listPanes(name);
  assert.equal(after.length, 1, "the reaped pane is still listed");
  assert.equal(after[0].paneIndex, "0", "the pane that survived is not the placeholder");
  assert.ok((await run(["has-session", "-t", name])).ok, "the session died with its pane");
  assert.equal(finished[0].reason, "reaped");
  step(`after kill: only ${after[0].paneId} (index 0, alive) remains; reason=${finished[0].reason}`);

  // Why the tick must skip panes it reaped itself: the *next* tick's vanished check
  // sees the reaped pane as gone, and because the FIFO dedupes by pane id, a newer
  // `vanished` entry built from the short live capture would overwrite the accurate
  // `reaped` one built from the 200-line capture. The handler suppresses it via the
  // reap set; this pins that the hazard is real.
  const remembered = listed.panes.map(trackPane);
  assert.deepEqual(
    selectVanishedPanes(remembered, after).map((pane) => pane.paneId),
    [reapable[0].paneId],
    "the reaped pane is invisible to the vanished check, so the guard is unnecessary",
  );
  step("the next tick would also call it vanished; the reap guard suppresses that");
}

/**
 * Scenario 2: the default tmux regime. This is the measurement that decides the
 * design — a pane whose command exits is simply *gone*, so nothing can be captured
 * after the fact and the only honest transcript is the one already held.
 */
async function scenarioVanish(tmux: TmuxClient, name: string): Promise<void> {
  await createSession(name);
  // Deliberately NOT setting remain-on-exit: this is the box's default regime.
  const whileAlive = await tmux.tryListPanes(name);
  assert.ok(whileAlive.ok, `list-panes failed: ${whileAlive.stderr}`);
  assert.equal(whileAlive.panes.length, 2, "expected the placeholder plus a live subagent pane");
  assert.ok(
    whileAlive.panes.every((pane) => !pane.dead),
    "the subagent pane is already reported dead; the regime is not the default one",
  );

  // What a tick holds while the pane is alive: its shape, and its screen.
  const subagent = whileAlive.panes.find((pane) => pane.paneIndex !== "0");
  assert.ok(subagent, "no subagent pane to track");
  const captured = await tmux.capturePane(subagent.paneId, 15);
  assert.ok(captured.ok, `capture-pane failed: ${captured.stderr}`);
  const tracked = whileAlive.panes.map(trackPane);
  const held: Record<string, string> = { [subagent.paneId]: captured.stdout.trim() };
  step(`while alive: ${describe(whileAlive.panes)}; held ${held[subagent.paneId].length} chars`);

  // Let the command exit. tmux then removes the pane.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const after = await tmux.tryListPanes(name);
  assert.ok(after.ok, `list-panes failed: ${after.stderr}`);
  step(`after the command exited: ${describe(after.panes)} — the pane is gone, not dead`);
  assert.equal(after.panes.length, 1, "tmux kept the pane; this box is not on remain-on-exit off");
  assert.equal(after.panes[0].paneIndex, "0", "what survived is not the placeholder");
  assert.equal(after.panes[0].dead, false, "the surviving pane is reported dead");

  // The vanished check, exactly as the tick runs it.
  const vanished = selectVanishedPanes(tracked, after.panes);
  assert.deepEqual(
    vanished.map((pane) => pane.paneId),
    [subagent.paneId],
    "the disappeared subagent pane was not detected",
  );
  let finished: FinishedPane[] = [];
  for (const pane of vanished) {
    finished = pushFinishedPane(
      finished,
      finishedEntry(pane, held[pane.paneId] ?? "", "vanished", Date.now()),
      6,
    );
  }
  assert.equal(finished.length, 1, "the held capture did not reach the finished list");
  assert.equal(finished[0].reason, "vanished");
  assert.equal(
    finished[0].text.split("\n").filter((line) => line.startsWith("LINE-")).length,
    MARKER_LINES,
    "the promoted transcript lost lines",
  );
  step(
    `promoted: reason=${finished[0].reason} lines=${finished[0].lines} ` +
      `size=${finished[0].width}x${finished[0].height} title=${finished[0].title}`,
  );
  assert.ok((await run(["has-session", "-t", name])).ok, "the session died with its subagent pane");
}

/**
 * Scenario 3: the guard that keeps a transient failure from inventing finished
 * panes. A failed listing must never be compared against the previous tick.
 */
async function scenarioGuard(tmux: TmuxClient, missing: string): Promise<void> {
  const tracked = [
    { paneId: "%0", paneIndex: "0", title: "", command: "bash", width: "100", height: "20" },
    { paneId: "%9", paneIndex: "1", title: "", command: "bash", width: "100", height: "20" },
  ];
  // A session that is not there: `tryListPanes` says the listing failed, while the
  // fail-closed `listPanes` would have returned [] — which is exactly what, taken
  // at face value, reads as "every pane vanished at once".
  const listed = await tmux.tryListPanes(missing);
  assert.equal(listed.ok, false, "a missing session must be reported as a failed listing");
  assert.deepEqual(listed.panes, []);
  step(`failed listing: ok=false stderr=${JSON.stringify(listed.stderr)}`);
  assert.deepEqual(selectVanishedPanes(tracked, null), [], "a failed listing promoted panes");
  assert.deepEqual(
    selectVanishedPanes(tracked, []).map((pane) => pane.paneId),
    ["%9"],
    "an empty but successful listing must still promote the subagent pane");
  assert.deepEqual(
    selectVanishedPanes([{ paneId: "%0", paneIndex: "0" }], []),
    [],
    "the placeholder was promoted as a finished subagent",
  );
}

async function main(): Promise<number> {
  const tmux = new TmuxClient(run);
  try {
    console.log("scenario 1 — remain-on-exit on (keepFinishedPanes): reap");
    await scenarioReap(tmux, SESSION);
    console.log("scenario 2 — remain-on-exit off (this box's default): vanished");
    await scenarioVanish(tmux, `${SESSION}b`);
    console.log("scenario 3 — failed listing must promote nothing");
    await scenarioGuard(tmux, `${SESSION}-missing`);
    console.log("reap-pane-check: PASS");
    return 0;
  } finally {
    await run(["kill-session", "-t", SESSION]);
    await run(["kill-session", "-t", `${SESSION}b`]);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`reap-pane-check: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
