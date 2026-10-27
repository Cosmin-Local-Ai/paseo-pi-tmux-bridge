#!/usr/bin/env node
/**
 * Phase A — mechanism proof for `pi-tmux-bridge`.
 *
 * Proves, with no Paseo involved, that:
 *   1. a fabricated `TMUX='<socket>,<pid>,0'` + `TMUX_PANE='%N'` pointing at a
 *      long-lived placeholder pane is enough for the Amos extension
 *      (`amosblomqvist/pi-interactive-subagents`) to treat a `pi --mode rpc`
 *      child process as "running inside tmux"; and
 *   2. calling its `subagent` tool from that child really does create a SECOND
 *      pane in our own session, running a real `pi` process.
 *
 * Also runs the NEGATIVE control: identical run with `TMUX` removed from the
 * child env -> Amos refuses and no second pane appears. This proves the
 * injected env is what makes it work (and that the spike is not just
 * "tmux happens to be reachable").
 *
 * Usage:  node tests/mechanism-spike.mjs [positive|negative|both]
 *
 * Only creates tmux sessions named `paseo-spike-<pid>` and always kills them.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AMOS =
  "/home/agent/.pi/agent/git/github.com/amosblomqvist/pi-interactive-subagents/pi-extension/subagents/index.ts";
const PREFIX = "paseo-spike-";
const SESSION = `${PREFIX}${process.pid}`;
const SHELL_READY_MS = 2000;
const PANE_WAIT_MS = 150_000;
const RUN_WAIT_MS = 240_000;

const log = (...a) => console.log(`[spike ${process.pid}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmux(args, opts = {}) {
  return execFileSync("tmux", args, { encoding: "utf8", ...opts }).trim();
}

/** Every pane in our session, as structured rows. */
function panes() {
  try {
    return tmux([
      "list-panes",
      "-t",
      SESSION,
      "-F",
      "#{pane_id}|#{pane_index}|#{pane_current_command}|#{pane_pid}|#{pane_title}",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pane_id, pane_index, pane_current_command, pane_pid, pane_title] = line.split("|");
        return { pane_id, pane_index, pane_current_command, pane_pid, pane_title };
      });
  } catch {
    return [];
  }
}

function capture(paneId, lines = 20) {
  try {
    return tmux(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
  } catch (e) {
    return `<capture failed: ${e.message}>`;
  }
}

/**
 * Processes below a pane's shell, by walking `ps` parent->child links.
 * We cannot use tmux's `pane_current_command` to detect pi here: Amos launches
 * the child through a non-interactive bash script (`sendLongCommand`), so the
 * foreground process group leader is that script's bash and tmux reports
 * "bash" even while pi owns the tty. So we inspect the real process tree.
 */
function paneProcessTree(panePid) {
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const rows = out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const seen = [];
  const stack = [Number(panePid)];
  while (stack.length) {
    const cur = stack.shift();
    for (const c of kids.get(cur) ?? []) {
      seen.push(c);
      stack.push(c.pid);
    }
  }
  return seen;
}

function paneHasPiProcess(panePid) {
  const tree = paneProcessTree(panePid);
  const hit = tree.find((p) => /(^|[\s/])pi(\s|$)/.test(p.args) || /pi-coding-agent|npm-global\/bin\/pi/.test(p.args));
  return { found: !!hit, tree: tree.map((p) => `${p.pid} ${p.args}`.slice(0, 160)), hit: hit?.args ?? null };
}

/**
 * Strict JSONL reader for pi's stdout. Splits only on LF, per docs/rpc.md
 * (readline would also split on U+2028/U+2029).
 */
function attachJsonl(stream, onRecord) {
  let buf = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const i = buf.indexOf(0x0a);
      if (i === -1) break;
      const line = buf.subarray(0, i).toString("utf8").replace(/\r$/, "");
      buf = buf.subarray(i + 1);
      if (!line) continue;
      try {
        onRecord(JSON.parse(line));
      } catch {
        /* not a protocol record */
      }
    }
  });
}

async function runOnce(mode) {
  const label = mode === "positive" ? "POSITIVE (TMUX injected)" : "NEGATIVE (TMUX unset)";
  console.log("\n" + "=".repeat(78));
  console.log(`MODE: ${label}`);
  console.log("=".repeat(78));

  const workDir = mkdtempSync(join(tmpdir(), "pi-tmux-bridge-spike-"));
  const sessionDir = join(workDir, "sessions");
  const evidence = { mode, session: SESSION, panesAfterSplit: [], subagentPane: null, records: [] };
  let pi = null;
  let pass = false;
  const reasons = [];

  try {
    // ── 1. our own session with a long-lived placeholder pane ──────────────
    const placeholder = process.env.SHELL || "/bin/sh";
    tmux([
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-c",
      workDir,
      "-x",
      "220",
      "-y",
      "60",
      placeholder,
      "-l",
    ]);
    const paneId = tmux(["display-message", "-p", "-t", SESSION, "#{pane_id}"]);
    const socket = tmux(["display-message", "-p", "#{socket_path}"]);
    const hostPid = Number(tmux(["display-message", "-p", "-t", SESSION, "#{pane_pid}"]));
    log(`session=${SESSION} placeholderPane=${paneId} hostPanePid=${hostPid} socket=${socket}`);
    evidence.placeholderPane = { paneId, hostPid, socket };

    // ── 2. spawn `pi --mode rpc` with the env the plugin will inject ───────
    // NOTE: the SPEC suggested `--no-session`, but Amos's `subagent` tool
    // hard-requires a session file (index.ts:1795 -> "no session file"), so we
    // use an ephemeral --session-dir under /tmp instead. Documented deviation.
    const childEnv = { ...process.env };
    delete childEnv.PI_SUBAGENT_AGENT;
    delete childEnv.PI_SUBAGENT_ALLOWED;
    childEnv.PI_SUBAGENT_SHELL_READY_DELAY_MS = String(SHELL_READY_MS);
    if (mode === "positive") {
      childEnv.TMUX = `${socket},${process.pid},0`; // fabricated pid == our own process
      childEnv.TMUX_PANE = paneId;
    } else {
      delete childEnv.TMUX;
      delete childEnv.TMUX_PANE;
    }

    pi = spawn(
      "pi",
      ["--mode", "rpc", "--session-dir", sessionDir, "--extension", AMOS],
      { cwd: workDir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    log(`spawned pi pid=${pi.pid} TMUX=${childEnv.TMUX ?? "<unset>"} TMUX_PANE=${childEnv.TMUX_PANE ?? "<unset>"}`);
    evidence.piPid = pi.pid;
    evidence.argv = ["pi", "--mode", "rpc", "--session-dir", "<tmp>", "--extension", AMOS];

    const stderrLines = [];
    pi.stderr.on("data", (d) => stderrLines.push(String(d)));

    // Parent-side protocol evidence. pi emits `tool_execution_start` /
    // `tool_execution_end` with an explicit `toolName` (docs/json.md:105-114),
    // so we key on those instead of substring-matching the system prompt.
    const toolExec = [];
    const tmuxErrors = [];
    attachJsonl(pi.stdout, (rec) => {
      if (rec.type === "response") evidence.records.push(rec);
      if (rec.type === "tool_execution_start" || rec.type === "tool_execution_end") {
        toolExec.push(rec);
        log(`protocol: ${rec.type} toolName=${rec.toolName}`);
      }
      const s = JSON.stringify(rec);
      if (s.includes("tmux is required") || s.includes("Subagents require tmux")) tmuxErrors.push(rec);
    });

    // ── 3. prompt that asks pi to use the subagent tool ────────────────────
    const prompt = [
      "Use the `subagent` tool exactly once, with agent=\"worker\" and task set to:",
      "\"Run the shell command `echo SPIKE_OK` using the bash tool, then stop.\"",
      "Do not do the work yourself. After the tool call returns its acknowledgement, stop and say DONE.",
    ].join(" ");
    pi.stdin.write(JSON.stringify({ id: "spike-1", type: "prompt", message: prompt }) + "\n");
    log("sent prompt asking pi to call the subagent tool");

    // ── 4. wait for a SECOND pane to appear ───────────────────────────────
    const deadline = Date.now() + (mode === "positive" ? PANE_WAIT_MS : 60_000);
    let second = null;
    while (Date.now() < deadline) {
      const rows = panes();
      evidence.panesAfterSplit = rows;
      const extra = rows.filter((r) => r.pane_id !== paneId);
      if (extra.length > 0) {
        second = extra[0];
        break;
      }
      if (pi.exitCode !== null) break;
      await sleep(1000);
    }

    // ── 5. verdicts ───────────────────────────────────────────────────────
    console.log("\n--- tmux evidence: list-panes -F ---");
    console.log(tmux(["list-panes", "-t", SESSION, "-F", "#{pane_id} #{pane_index} #{pane_current_command} #{pane_pid} #{pane_title}"]));

    if (mode === "positive") {
      if (!second) {
        reasons.push("no second pane appeared");
      } else {
        evidence.subagentPane = second;
        log(`second pane: ${second.pane_id} cmd=${second.pane_current_command} pid=${second.pane_pid}`);
        // give the child pi time to start and run the task
        const childDeadline = Date.now() + RUN_WAIT_MS;
        let sawPi = second.pane_current_command === "pi";
        while (Date.now() < childDeadline) {
          const rows = panes();
          evidence.panesAfterSplit = rows;
          const row = rows.find((r) => r.pane_id === second.pane_id);
          if (row && row.pane_current_command === "pi") sawPi = true;
          if (row && row.pane_current_command !== "pi" && sawPi) break;
          const cap = capture(second.pane_id, 40);
          if (cap.includes("SPIKE_OK") || cap.includes("__SUBAGENT_DONE_")) break;
          if (!rows.some((r) => r.pane_id === second.pane_id)) break;
          await sleep(2000);
        }
        const cap = capture(second.pane_id, 40);
        console.log(`\n--- capture-pane -p -S -40 (subagent pane ${second.pane_id}) ---`);
        console.log(cap);
        const fresh = panes().find((r) => r.pane_id === second.pane_id);
        const proc = paneHasPiProcess(fresh?.pane_pid ?? second.pane_pid);
        const piInPane = proc.found;
        const didWork = cap.includes("SPIKE_OK");
        const done = cap.includes("__SUBAGENT_DONE_");
        const piUiVisible = /\bpi\b.*/i.test(cap) && /Working|\[worker\]|pi-coding-agent|tools\s+\(Ctrl/i.test(cap);
        log(
          `paneStillThere=${!!fresh} pane_current_command=${fresh?.pane_current_command ?? "<gone>"} `
            + `piProcessInPaneTree=${piInPane} piTuiVisibleInCapture=${piUiVisible} `
            + `sawSPIKE_OK=${didWork} sentinel=${done}`,
        );
        console.log("\n--- process tree under the subagent pane ---");
        for (const line of proc.tree) console.log(`  ${line}`);
        if (proc.hit) console.log(`  matched: ${proc.hit.slice(0, 200)}`);

        // parent-side evidence: did the `subagent` tool actually execute, and
        // did the parent receive a result record for it?
        const subagentStarts = toolExec.filter((r) => r.type === "tool_execution_start" && r.toolName === "subagent");
        const subagentEnds = toolExec.filter((r) => r.type === "tool_execution_end" && r.toolName === "subagent");
        evidence.subagentToolExec = { starts: subagentStarts.length, ends: subagentEnds.length };
        log(`parent tool_execution events for toolName=subagent: start=${subagentStarts.length} end=${subagentEnds.length}`);
        if (subagentEnds[0]) {
          console.log("\n--- parent tool_execution_end for the subagent tool (truncated) ---");
          console.log(JSON.stringify(subagentEnds[0]).slice(0, 1500));
        }
        if (subagentStarts.length === 0) reasons.push("parent never executed the `subagent` tool");

        if (!piInPane) reasons.push("no `pi` process found in the second pane's process tree");
        if (!didWork && !done) reasons.push("subagent pane never showed SPIKE_OK or the done sentinel");
        if (!fresh) reasons.push("second pane disappeared before we could read it");
        pass = reasons.length === 0;
      }
    } else {
      const cap = capture(paneId, 60);
      console.log(`\n--- capture-pane (placeholder pane, no split expected) ---`);
      console.log(cap);
      const refused = tmuxErrors.length > 0;
      if (tmuxErrors[0]) {
        console.log("\n--- Amos tmux refusal, as seen on the parent protocol stream (truncated) ---");
        console.log(JSON.stringify(tmuxErrors[0]).slice(0, 1200));
      }
      const noSplit = panes().length === 1;
      log(`amos refused tmux=${refused} paneCount=${panes().length}`);
      if (!refused) reasons.push("Amos did not report a tmux-required error");
      if (!noSplit) reasons.push("a second pane appeared even with TMUX unset (control is invalid)");
      pass = reasons.length === 0;
    }
  } catch (e) {
    reasons.push(`error: ${e.message}`);
    console.error(e);
  } finally {
    // ── 6. cleanup: only our own session + our own pi child ───────────────
    try {
      if (pi && pi.exitCode === null) {
        try {
          pi.stdin.end();
        } catch {}
        pi.kill("SIGTERM");
        const t = Date.now();
        while (pi.exitCode === null && Date.now() - t < 5000) await sleep(100);
        if (pi.exitCode === null) pi.kill("SIGKILL");
      }
    } catch {}
    // tmux owns the pane process groups; kill-session terminates the pane shell
    // and everything running in it (including the subagent pi). We never send
    // signals to panes we did not create ourselves.
    try {
      tmux(["kill-session", "-t", SESSION], { stdio: "ignore" });
    } catch {}
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    log("cleaned up session + pi child + tmp dir");
  }

  console.log("\n--- verdict ---");
  console.log(`${label}: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) for (const r of reasons) console.log(`  - ${r}`);
  return { mode, pass, reasons, evidence };
}

const which = process.argv[2] || "both";
const results = [];
if (which === "both" || which === "positive") results.push(await runOnce("positive"));
if (which === "both" || which === "negative") results.push(await runOnce("negative"));

console.log("\n" + "=".repeat(78));
console.log("PHASE A SUMMARY");
console.log("=".repeat(78));
for (const r of results) console.log(`${r.mode.padEnd(9)} ${r.pass ? "PASS" : "FAIL"}${r.pass ? "" : " :: " + r.reasons.join("; ")}`);
const allPass = results.length > 0 && results.every((r) => r.pass);
console.log(`overall: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
