/**
 * tmux command builders, output parsers and env construction.
 *
 * Deliberately free of any `@getpaseo/*` or `zod` import so the pure parts can
 * be unit-tested with plain `node --test` (Node type-stripping) without the
 * Paseo SDK on the module path.
 *
 * Injection guard: every value that reaches a tmux `-t`/`-P -F` argv slot is
 * validated here. Session names are always derived from a configured prefix
 * plus a Paseo agent id — never supplied by the plugin client.
 */

export const TMUX_BIN = "tmux";

/**
 * A Paseo desktop daemon inherits the desktop session's environment, which
 * frequently does **not** contain the directory tmux lives in (the user's real
 * daemon logged `tmux is not on PATH` for every agent). Looking tmux up by name
 * is therefore only the first attempt: the plugin resolves an absolute path and
 * uses it for every call, and hands the directory to the agent through `PATH`
 * because Amos itself runs `command -v tmux` inside the agent process.
 */
export const TMUX_CANDIDATE_PATHS: readonly string[] = [
  "/usr/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/local/sbin/tmux",
  "/opt/homebrew/bin/tmux",
  "/opt/local/bin/tmux",
  "/snap/bin/tmux",
  "$HOME/.local/bin/tmux",
  "/run/current-system/sw/bin/tmux",
];

/** Candidate list with `$HOME` substituted; order is the documented probe order. */
export function tmuxCandidatePaths(home?: string): string[] {
  const resolvedHome = typeof home === "string" && home.length > 0 ? home.replace(/\/+$/, "") : "";
  const out: string[] = [];
  for (const candidate of TMUX_CANDIDATE_PATHS) {
    if (candidate.startsWith("$HOME")) {
      if (!resolvedHome) continue;
      out.push(`${resolvedHome}${candidate.slice("$HOME".length)}`);
      continue;
    }
    out.push(candidate);
  }
  return out;
}

/**
 * argv for resolving tmux through the login shell: `command -v tmux` → path or
 * nothing. The login shell is deliberate here: a desktop daemon inherits a PATH
 * with no tmux directory, and only the login profile reveals where it lives.
 */
export const TMUX_WHICH_ARGS: readonly string[] = ["-lc", "command -v tmux"];

/**
 * argv for asking whether tmux is reachable in the environment the **agent**
 * will actually get: no login shell, so nothing is added to PATH.
 *
 * These two probes must stay separate. Using the login shell for both was a
 * real regression: the daemon found `/usr/bin/tmux` through the profile, the
 * agent PATH still had no tmux, Amos' own `command -v tmux` failed, and no
 * subagent pane was ever created.
 */
export const TMUX_REACHABLE_ARGS: readonly string[] = ["-c", "command -v tmux"];

export function parsePathLookup(stdout: string): string | null {
  const first = (stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first || !first.startsWith("/") || first.length > 512) return null;
  return first;
}

export interface TmuxResolution {
  path: string | null;
  /** every location that was tried, in order, for the operator-facing message */
  tried: string[];
}

/**
 * Pure resolver. `exists` is supplied by the caller (the server proves a
 * candidate by running `<candidate> -V`), so this stays testable without a
 * filesystem.
 *
 * An explicit `tmuxPath` setting is authoritative: when it is set but not
 * usable the result is a hard failure rather than a silent fallback to some
 * other tmux, because a wrong override must surface as a visible diagnostic.
 */
export function resolveTmuxPath(
  input: { configured: string; pathLookup: string | null; candidates: readonly string[] },
  exists: (candidate: string) => boolean,
): TmuxResolution {
  const configured = typeof input.configured === "string" ? input.configured.trim() : "";
  if (configured.length > 0) {
    return exists(configured)
      ? { path: configured, tried: [`tmuxPath=${configured}`] }
      : { path: null, tried: [`tmuxPath=${configured} (not executable)`] };
  }

  const tried: string[] = [];
  if (input.pathLookup) {
    tried.push(`PATH (${input.pathLookup})`);
    if (exists(input.pathLookup)) return { path: input.pathLookup, tried };
  } else {
    tried.push("PATH (command -v tmux: not found)");
  }

  for (const candidate of input.candidates) {
    tried.push(candidate);
    if (exists(candidate)) return { path: candidate, tried };
  }
  return { path: null, tried };
}

/** Directory holding an absolute binary path, or null when it has none. */
export function binaryDirOf(absolutePath: string | null): string | null {
  if (!absolutePath) return null;
  const index = absolutePath.lastIndexOf("/");
  if (index <= 0) return null;
  return absolutePath.slice(0, index);
}

export const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

/**
 * Paseo composes the launch env as `{ ...daemonEnv, ...hookEnv }
 * (provider-launch-config.ts:createExternalProcessEnv)`, so a `PATH` returned by
 * the hook **replaces** the daemon PATH rather than extending it. `agent.session_open`
 * hands the hook a sparse env that usually has no PATH at all, so the base for
 * the injection has to be the daemon's own PATH; inventing a PATH that contains
 * only the tmux directory would break `spawn pi` with ENOENT.
 */
export function pathBaseFor(
  requestPath: string | undefined,
  daemonPath: string | undefined,
): string | undefined {
  if (typeof requestPath === "string" && requestPath.length > 0) return requestPath;
  if (typeof daemonPath === "string" && daemonPath.length > 0) return daemonPath;
  return undefined;
}

/**
 * Prepend the tmux directory to PATH without dropping anything the agent
 * already had, and without duplicating the directory on resume/refresh. An
 * absent PATH stays absent: a lone tmux directory would shadow the rest of the
 * environment the daemon is about to spawn.
 */
export function prependToPath(
  existingPath: string | undefined,
  dir: string | null,
  delimiter: string = PATH_DELIMITER,
): string | undefined {
  if (!dir || existingPath === undefined) return existingPath;
  const parts = (existingPath ?? "")
    .split(delimiter)
    .filter((part) => part.length > 0 && part !== dir);
  return [dir, ...parts].join(delimiter);
}

/** What the panel and the log say when nothing resolved. Never a silent blank UI. */
export const TMUX_MISSING_DETAIL =
  "tmux not found in the agent's namespace — install tmux there or set tmuxPath";

// ── namespace prefixes ──────────────────────────────────────────────────────

/**
 * A provider may run Pi somewhere the daemon cannot reach by exec'ing `tmux`
 * directly: a container (`sbx exec … -- tmux`), a VM (`ssh host tmux`), a
 * mount namespace (`nsenter … tmux`). The prefix is argv that must appear
 * **before** the tmux binary, so every tmux operation - probe, new-session,
 * display-message, capture, kill - lands in the same place the agent runs.
 */
export type ExecPrefix = readonly string[];

export const PLACEHOLDER_CWD = "{cwd}";
export const PLACEHOLDER_AGENT_ID = "{agentId}";

export interface PrefixValues {
  cwd: string;
  agentId: string;
}

/** Substitute `{cwd}` / `{agentId}` in every prefix element. */
export function applyExecPlaceholders(
  prefix: readonly string[],
  values: PrefixValues,
): string[] {
  return prefix.map((element) =>
    element
      .split(PLACEHOLDER_CWD)
      .join(values.cwd)
      .split(PLACEHOLDER_AGENT_ID)
      .join(values.agentId),
  );
}

/**
 * Prefix precedence: an entry for this exact provider wins - including an
 * explicit empty entry, which means "this provider runs tmux on the host" -
 * otherwise the global `tmuxExec`, otherwise the host.
 */
export function resolveExecPrefix(input: {
  provider: string;
  providerTmuxExec?: Record<string, ExecPrefix | undefined>;
  tmuxExec?: ExecPrefix;
}): string[] {
  const map = input.providerTmuxExec ?? {};
  if (Object.prototype.hasOwnProperty.call(map, input.provider)) {
    return [...(map[input.provider] ?? [])];
  }
  return [...(input.tmuxExec ?? [])];
}

/**
 * Full argv for one tmux call: `[command, ...args]`. With an empty prefix this
 * is exactly the pre-namespacing behaviour (`tmux <args>`), which keeps the
 * host path byte-compatible.
 */
export function tmuxInvocation(
  tmuxPath: string,
  prefix: readonly string[],
  args: readonly string[],
): { command: string; args: string[] } {
  if (prefix.length === 0) return { command: tmuxPath, args: [...args] };
  return { command: prefix[0] as string, args: [...prefix.slice(1), tmuxPath, ...args] };
}

/** argv for the Paseo attach terminal (prefix + tmux + `attach -t <session>`). */
export function attachInvocation(
  tmuxPath: string,
  prefix: readonly string[],
  sessionName: string,
): { command: string; args: string[] } {
  return tmuxInvocation(tmuxPath, prefix, attachArgs(sessionName));
}

/** argv for `command -v tmux` and `<candidate> -V` inside the namespace. */
export function shellProbeInvocation(
  prefix: readonly string[],
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (prefix.length === 0) return { command, args: [...args] };
  return { command: prefix[0] as string, args: [...prefix.slice(1), command, ...args] };
}

/**
 * Short human label for the panel/log: `sbx:pi-recovery-test` for
 * `sbx exec -i -w {cwd} pi-recovery-test --`, `host` for no prefix.
 */
export function execLabel(prefix: readonly string[]): string {
  if (prefix.length === 0) return "host";
  const base = (element: string) => element.split("/").pop() ?? "";
  const head = base(prefix[0] ?? "");
  const tail =
    prefix
      .slice(1)
      .filter((element) => !element.startsWith("-") && !element.includes("{") && base(element) !== head)
      .pop() ?? "";
  return tail ? `${head}:${tail}` : head || prefix.join(" ");
}

/**
 * The tmux directory to prepend to the agent `PATH`, or null.
 *
 * Only when tmux is NOT already reachable inside the namespace: rewriting PATH
 * for a container that already has tmux on its PATH is how the previous design
 * broke agents, and inside a container the host directory would be nonsense
 * anyway.
 */
export function tmuxDirToInject(resolution: {
  path: string | null;
  reachableInPath?: boolean;
}): string | null {
  if (resolution.reachableInPath !== false) return null;
  return binaryDirOf(resolution.path);
}

export const DEFAULT_SESSION_PREFIX = "paseo-";
export const DEFAULT_LAYOUT = "even-horizontal";
export const DEFAULT_PLACEHOLDER_CMD = "$SHELL -l";
export const FALLBACK_PLACEHOLDER_CMD = "tail -f /dev/null";
export const DEFAULT_SHELL_READY_DELAY_MS = 2000;
export const DEFAULT_PANE_CAPTURE_LINES = 15;
/** Mirrors Amos's own SUBAGENT_TMUX_LAYOUT constant (pi-extension/subagents/tmux.ts:74). */
export const AMOS_LAYOUT = "even-horizontal";

/** Placeholder session geometry; the attach terminal re-fits it on attach. */
export const SESSION_COLS = 220;
export const SESSION_ROWS = 60;
export const ATTACH_TERMINAL_ROWS = 50;
export const ATTACH_TERMINAL_COLS = 220;

/** Env key the bridge sets so other tooling can find the session for an agent. */
export const SESSION_ENV_KEY = "PASEO_TMUX_SESSION";
/** Amos reads this to wait for a fresh pane's shell before typing into it. */
export const SHELL_READY_ENV_KEY = "PI_SUBAGENT_SHELL_READY_DELAY_MS";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PANE_ID = /^%[0-9]{1,9}$/;
const SAFE_LAYOUT = /^[a-z][a-z0-9-]{0,31}$/;

export function isSafeSessionName(value: string): boolean {
  return typeof value === "string" && SAFE_NAME.test(value);
}

export function isSafeAgentId(value: string): boolean {
  return typeof value === "string" && SAFE_AGENT_ID.test(value);
}

export function isSafePaneId(value: string): boolean {
  return typeof value === "string" && SAFE_PANE_ID.test(value);
}

export function isSafeLayout(value: string): boolean {
  return typeof value === "string" && SAFE_LAYOUT.test(value);
}

/**
 * `paseo-` + agentId. Returns null when the result would not be a safe tmux
 * target, which lets callers fall soft instead of handing a hostile name to
 * `tmux -t`.
 */
export function sessionNameFor(prefix: string, agentId: string): string | null {
  if (typeof prefix !== "string" || typeof agentId !== "string") return null;
  if (prefix.length === 0 || prefix.length > 32) return null;
  if (!isSafeAgentId(agentId)) return null;
  const name = `${prefix}${agentId}`;
  return isSafeSessionName(name) ? name : null;
}

/**
 * Cleanup guard: a session may only be killed when its name is exactly this
 * plugin's prefix plus this agent's id. That makes it impossible to kill a
 * session the bridge did not create.
 */
export function isOwnSessionName(name: string, prefix: string, agentId: string): boolean {
  if (typeof name !== "string" || typeof prefix !== "string") return false;
  if (prefix.length === 0) return false;
  if (!name.startsWith(prefix)) return false;
  return name === `${prefix}${agentId}` && isOwnSessionNameShape(name, prefix);
}

function isOwnSessionNameShape(name: string, prefix: string): boolean {
  if (!isSafeSessionName(name)) return false;
  const rest = name.slice(prefix.length);
  return isSafeAgentId(rest);
}

/** Provider id of the built-in Pi provider. */
export const PI_PROVIDER_ID = "pi";

/**
 * Paseo lets a user declare a custom agent provider with `extends: "pi"`, for
 * example `pi-recovery`. `agent.session_open` reports the *derived* provider id
 * (`packages/server/src/server/agent/agent-manager.ts` sends `client.provider`),
 * never `pi`, so an exact `provider === "pi"` match silently disables the bridge
 * for every agent of such a provider. A `pi` token in the id recognises them.
 * The token is delimited, so `pilot` and `openapi` do not match.
 */
const PI_PROVIDER_TOKEN = /(?:^|[-_.])pi(?:[-_.]|$)/;

export interface PiProviderMatchOptions {
  /** Exact provider ids to treat as Pi regardless of the heuristic. */
  extraProviderIds?: readonly string[];
  /** Default true: recognise `pi`-derived provider ids such as `pi-recovery`. */
  autoDetect?: boolean;
}

export function isPiProviderId(
  provider: string,
  options: PiProviderMatchOptions = {},
): boolean {
  if (typeof provider !== "string" || provider.length === 0) return false;
  if (provider === PI_PROVIDER_ID) return true;
  if ((options.extraProviderIds ?? []).includes(provider)) return true;
  return (options.autoDetect ?? true) && PI_PROVIDER_TOKEN.test(provider);
}

/** Only interactive Pi sessions get a tmux bridge. */
export function shouldHandleSessionOpen(
  request: { provider: string; purpose: string },
  options: PiProviderMatchOptions = {},
): boolean {
  return request.purpose === "interactive" && isPiProviderId(request.provider, options);
}

/**
 * Amos identity variables. A Paseo agent is always a top-level Pi session, but
 * Paseo passes the daemon's environment down, so a daemon started from inside
 * an Amos subagent pane hands its identity to every agent. Amos's self-spawn
 * guard then refuses `subagent({ agent: "worker" })` with "You are the worker
 * agent", which looks exactly like the bridge doing nothing.
 */
export const AMOS_IDENTITY_ENV_KEYS: readonly string[] = [
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_ALLOWED",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_SURFACE",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
];

export function stripAmosIdentity(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (AMOS_IDENTITY_ENV_KEYS.includes(key)) continue;
    next[key] = value;
  }
  return next;
}

/**
 * Replace `$SHELL` with a concrete shell path. tmux runs the placeholder
 * through the default shell, but resolving it here keeps the argv element
 * predictable and lets us fall back to a command that cannot exit.
 */
export function resolvePlaceholderCommand(
  configured: string,
  env: Record<string, string | undefined>,
): string {
  const raw = typeof configured === "string" ? configured.trim() : "";
  if (raw.length === 0) return FALLBACK_PLACEHOLDER_CMD;
  const shell = typeof env.SHELL === "string" && env.SHELL.length > 0 ? env.SHELL : "/bin/sh";
  const resolved = raw.replaceAll("$SHELL", shell).replaceAll("${SHELL}", shell).trim();
  return resolved.length > 0 ? resolved : FALLBACK_PLACEHOLDER_CMD;
}

// ── argv builders (everything after the `tmux` binary) ──────────────────────

export function hasSessionCmd(name: string): string[] {
  return ["has-session", "-t", name];
}

export function newSessionCmd(options: {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  placeholder: string;
}): string[] {
  return [
    "new-session",
    "-d",
    "-s",
    options.name,
    "-c",
    options.cwd,
    "-x",
    String(options.cols),
    "-y",
    String(options.rows),
    options.placeholder,
  ];
}

export function selectLayoutCmd(name: string, layout: string): string[] {
  return ["select-layout", "-t", name, layout];
}

export function displayPaneIdCmd(name: string): string[] {
  return ["display-message", "-p", "-t", name, "#{pane_id}"];
}

export function displaySocketPathCmd(): string[] {
  return ["display-message", "-p", "#{socket_path}"];
}

/**
 * The tmux **server** pid as the namespace sees it. Inside a container the
 * daemon's own pid is meaningless, and `TMUX` is parsed as
 * `<socket>,<server pid>,<pane index>`, so ask the server where it runs.
 */
export function displayServerPidCmd(): string[] {
  return ["display-message", "-p", "#{pid}"];
}

export const PANE_FORMAT =
  "#{pane_id}|#{pane_index}|#{pane_current_command}|#{pane_pid}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}";

export function listPanesCmd(name: string): string[] {
  return ["list-panes", "-t", name, "-F", PANE_FORMAT];
}

export function capturePaneCmd(paneId: string, lines: number): string[] {
  const bounded = Math.max(1, Math.min(2000, Math.trunc(lines) || 1));
  // `-e` keeps the SGR sequences tmux holds in its pane history, which is what
  // lets the panel render colours instead of grey text. Everything that is not
  // SGR is stripped server-side by `sanitizeCapture` before it crosses the wire.
  return ["capture-pane", "-p", "-e", "-t", paneId, "-S", `-${bounded}`];
}

// ── pipe-pane change signal ────────────────────────────────────────────────

/**
 * `capture-pane -p -e` is the only correct way to **read** a pane: the raw
 * pipe-pane byte stream carries keystroke echo, CRs and full-screen redraws, so
 * replaying it would need a terminal emulator. But capture is also the expensive
 * call, and paying it for every pane on every tick is what makes the panel look
 * like a 2-second slideshow.
 *
 * `pipe-pane` supplies the cheap half: tmux appends every byte a pane produces
 * to a file, so the file's byte size is a change signal, and ONE listing of the
 * log directory says which panes are worth capturing.
 *
 * Why not a tmux format instead? `pane_last_output`, `pane_changed`,
 * `pane_history_lines` and `pane_output_size` all expand to the empty string in
 * the tmux 3.6 build inside the sandbox namespace (measured on this machine), so
 * nothing on the pane itself can be polled.
 */
export const PANE_LOG_ROOT = "/tmp/pi-tmux-bridge";

/**
 * Where the pipe logs live — **inside the namespace tmux runs in**, because the
 * daemon cannot read a file the container created, so listing them goes through
 * the same exec prefix as every other tmux call.
 *
 * Flat on purpose: the file name already carries the session name, so a
 * per-session subdirectory would add a path segment without adding isolation,
 * and one `wc -c` listing still covers it. Returns "" for a name that must not
 * be turned into a path — the validator is the guard, not the caller's intent.
 */
export function paneLogDir(sessionPrefix: string): string {
  return isSafeSessionName(sessionPrefix) ? PANE_LOG_ROOT : "";
}

/**
 * `/tmp/pi-tmux-bridge/<sessionName>.<paneId without %>.log`, or "" when either
 * name is unsafe. `/` is not in the safe-name character class and a safe name
 * cannot start with a dot, so no path traversal is reachable from here.
 */
export function paneLogPath(sessionName: string, paneId: string): string {
  if (!isSafeSessionName(sessionName) || !isSafePaneId(paneId)) return "";
  return `${PANE_LOG_ROOT}/${sessionName}.${paneId.slice(1)}.log`;
}

const SAFE_PANE_LOG_PATH = /^\/[A-Za-z0-9._/-]{0,511}$/;

export function isSafePaneLogPath(value: string): boolean {
  return (
    typeof value === "string" && SAFE_PANE_LOG_PATH.test(value) && !value.split("/").includes("..")
  );
}

/** Single-quote for `/bin/sh`; tmux hands a pipe command to a shell. */
function quoteForSh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Arm the change signal. `-o` replaces the pipe if one is already running
 * instead of failing, and the `mkdir -p` runs inside the namespace so the log
 * directory never has to be created from outside (which is impossible anyway).
 */
export function pipePaneCmd(paneId: string, path: string): string[] {
  const slash = path.lastIndexOf("/");
  const dir = slash > 0 ? path.slice(0, slash) : "/";
  return ["pipe-pane", "-t", paneId, "-o", `mkdir -p ${quoteForSh(dir)} && cat >> ${quoteForSh(path)}`];
}

/** No command: tmux closes the pane's pipe. */
export function pipePaneStopCmd(paneId: string): string[] {
  return ["pipe-pane", "-t", paneId];
}

/**
 * One `/bin/sh -c` body printing `<name> <bytes>` for every log in the
 * directory. It has to be a single command: the namespace exec round-trip, not
 * `wc`, is what a poll costs, so a per-pane listing would multiply the very
 * thing the change signal exists to avoid. A missing directory prints nothing
 * rather than failing — the first tick arms the pipes and has no logs yet.
 */
export function paneLogSizesScript(dir: string): string {
  return (
    `cd ${quoteForSh(dir)} 2>/dev/null || exit 0\n` +
    `for f in *.log; do [ -f "$f" ] || continue; ` +
    `printf '%s %s\\n' "$f" "$(wc -c < "$f" | tr -d ' ')"; done`
  );
}

/** Non-greedy name: `wc` pads the count, and the padding must not end up in the name. */
const PANE_LOG_SIZE_LINE = /^(.+?)\s+([0-9]{1,18})$/;

/**
 * `<sessionName>.<pane>.log 4096` → `{ "%<pane>": 4096 }`.
 *
 * Keyed by pane id alone: pane ids are unique inside a tmux server, and the
 * sizes are only ever compared against the panes of the one session the caller
 * listed. Two sessions on two *different* servers in one namespace could share
 * an id, and then the worst case is a spurious extra capture — never a missed
 * one, because a pane with no entry counts as changed. Unparseable lines are
 * dropped and nothing throws: a poll that cannot read the directory must still
 * return the screens it can capture.
 */
export function parsePaneLogSizes(stdout: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  if (typeof stdout !== "string") return sizes;
  for (const line of stdout.split("\n")) {
    const match = PANE_LOG_SIZE_LINE.exec(line.trim());
    if (!match) continue;
    const name = (match[1] ?? "").trim().replace(/\.log$/, "");
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const pane = name.slice(dot + 1);
    if (!/^[0-9]{1,9}$/.test(pane)) continue;
    const size = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isSafeInteger(size)) continue;
    sizes[`%${pane}`] = size;
  }
  return sizes;
}

/**
 * Which panes are worth a capture. Pure, so the three rules that matter are
 * testable without a tmux server:
 *
 * - size differs from the previous tick → the pane produced output;
 * - no previous entry → first tick, the panel must fill immediately rather than
 *   wait for the next change;
 * - no size at all → the log is missing (pipe just armed, /tmp cleaned, pane
 *   recreated), so the pane is unknown and must be re-read.
 */
export function selectChangedPanes(
  panes: readonly { paneId: string }[],
  sizes: Record<string, number>,
  previous: Record<string, number>,
): string[] {
  const changed: string[] = [];
  for (const pane of panes ?? []) {
    const paneId = pane?.paneId;
    if (typeof paneId !== "string" || !isSafePaneId(paneId)) continue;
    const current = sizes?.[paneId];
    const before = previous?.[paneId];
    if (current === undefined || before === undefined || current !== before) changed.push(paneId);
  }
  return changed;
}

/**
 * Literal text: `-l` stops tmux from interpreting the payload as key names, so
 * shell metacharacters reach the pane as characters.
 */
export function sendKeysLiteralCmd(paneId: string, text: string): string[] {
  return ["send-keys", "-t", paneId, "-l", text];
}

/** Named key only. Free text must never reach this - use `sendKeysLiteralCmd`. */
export function sendKeyCmd(paneId: string, key: string): string[] {
  return ["send-keys", "-t", paneId, key];
}

/**
 * Defense in depth: the RPC schema (`TMUX_KEY_NAMES` in shared/contracts.ts)
 * already rejects anything else, but `TmuxClient` is also reachable from tests
 * and future call sites.
 */
const TMUX_KEY_NAMES: readonly string[] = [
  "Enter",
  "C-c",
  "C-d",
  "C-l",
  "Escape",
  "Tab",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
];

export function selectPaneCmd(paneId: string): string[] {
  return ["select-pane", "-t", paneId];
}

export function killPaneCmd(paneId: string): string[] {
  return ["kill-pane", "-t", paneId];
}

export function killSessionCmd(name: string): string[] {
  return ["kill-session", "-t", name];
}

export function attachArgs(name: string): string[] {
  return ["attach", "-t", name];
}

export function attachTerminalName(agentId: string): string {
  return `pi-tmux:${agentId}`;
}

// ── output parsers ─────────────────────────────────────────────────────────

export interface TmuxPane {
  paneId: string;
  paneIndex: string;
  paneCurrentCommand: string;
  panePid: string;
  paneTitle: string;
  paneWidth: string;
  paneHeight: string;
  active: boolean;
}

export function parsePaneRows(stdout: string): TmuxPane[] {
  return stdout.split("\n").flatMap((line) => {
    const cells = line.trim().split("|");
    if (cells.length < 8 || !isSafePaneId(cells[0] ?? "")) return [];
    return [
      {
        paneId: cells[0] as string,
        paneIndex: cells[1] as string,
        paneCurrentCommand: cells[2] as string,
        panePid: cells[3] as string,
        paneTitle: cells[4] as string,
        paneWidth: cells[5] as string,
        paneHeight: cells[6] as string,
        active: cells[7] === "1",
      },
    ];
  });
}

export function parsePaneId(stdout: string): string | null {
  const value = (stdout ?? "").trim();
  return isSafePaneId(value) ? value : null;
}

export function parseServerPid(stdout: string): number | null {
  const value = (stdout ?? "").trim();
  return /^[0-9]{1,9}$/.test(value) ? Number(value) : null;
}

export function parseSocketPath(stdout: string): string | null {
  const value = (stdout ?? "").trim();
  if (value.length === 0 || value.length > 512) return null;
  if (/[\r\n]/.test(value)) return null;
  return value;
}

// ── env construction ───────────────────────────────────────────────────────

export interface InjectedEnvOptions {
  socketPath: string;
  /** pid field of TMUX; Amos never validates it, tmux clients only re-parse the socket. */
  pid: number;
  paneId: string;
  sessionName: string;
  shellReadyDelayMs: number;
  /** Default true: never let the daemon's Amos identity reach a top-level agent. */
  stripAmosIdentity?: boolean;
  /** Absolute path of the tmux the plugin resolved, so Amos can find `tmux`. */
  tmuxPath?: string | null;
  pathDelimiter?: string;
  /**
   * Prepend the tmux directory to PATH. Callers set this only when tmux is not
   * already reachable inside the agent's namespace.
   */
  injectTmuxDir?: boolean;
}

/**
 * `env` from `agent.session_open` is NOT deep-merged by Paseo, so the existing
 * env must always be spread first.
 */
export function buildInjectedEnv(
  base: Record<string, string>,
  options: InjectedEnvOptions,
): Record<string, string> {
  // Amos runs `command -v tmux` inside the agent, so the agent must be able to
  // find the same tmux the plugin resolved - but only when it cannot already
  // find it, which is the normal case inside a container that ships tmux.
  const dir = options.injectTmuxDir === false ? null : binaryDirOf(options.tmuxPath ?? null);
  const path = prependToPath(base.PATH, dir, options.pathDelimiter);
  return {
    ...(options.stripAmosIdentity === false ? base : stripAmosIdentity(base)),
    ...(path === undefined ? {} : { PATH: path }),
    TMUX: `${options.socketPath},${options.pid},0`,
    TMUX_PANE: options.paneId,
    [SESSION_ENV_KEY]: options.sessionName,
    [SHELL_READY_ENV_KEY]: String(options.shellReadyDelayMs),
  };
}

/**
 * Fail-soft env. `TMUX` becomes an empty string, which is falsy in JS, so Amos
 * reports its own "tmux is required for subagents" message instead of
 * splitting from a stale pane the daemon happened to inherit. `TMUX_PANE` is
 * cleared for the same reason.
 */
export function buildTmuxUnavailableEnv(
  base: Record<string, string>,
  options: {
    shellReadyDelayMs: number;
    stripAmosIdentity?: boolean;
    tmuxPath?: string | null;
    pathDelimiter?: string;
    injectTmuxDir?: boolean;
  },
): Record<string, string> {
  const dir = options.injectTmuxDir === false ? null : binaryDirOf(options.tmuxPath ?? null);
  const path = prependToPath(base.PATH, dir, options.pathDelimiter);
  return {
    ...(options.stripAmosIdentity === false ? base : stripAmosIdentity(base)),
    ...(path === undefined ? {} : { PATH: path }),
    TMUX: "",
    TMUX_PANE: "",
    [SESSION_ENV_KEY]: "",
    [SHELL_READY_ENV_KEY]: String(options.shellReadyDelayMs),
  };
}

// ── runner ─────────────────────────────────────────────────────────────────

export interface TmuxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable so the client below is testable without spawning tmux. */
export type TmuxRun = (args: string[]) => Promise<TmuxRunResult>;

export interface EnsureSessionOptions {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  placeholder: string;
  layout: string;
}

export interface SessionHandle {
  paneId: string;
  socketPath: string;
  /** tmux server pid as reported inside the namespace; null when unknown. */
  serverPid: number | null;
  created: boolean;
}

export interface TmuxFailure {
  ok: false;
  stage: "probe" | "has-session" | "new-session" | "pane-id" | "socket" | "name";
  message: string;
}

export type EnsureSessionResult = { ok: true; handle: SessionHandle } | TmuxFailure;

export class TmuxClient {
  private readonly run: TmuxRun;

  constructor(run: TmuxRun) {
    this.run = run;
  }

  /** Cheap availability probe; Amos gates on `!!TMUX && command -v tmux`. */
  async probe(): Promise<boolean> {
    const res = await this.run(["-V"]);
    return res.ok;
  }

  /**
   * Create-or-reuse the per-agent session and return the pane id to advertise.
   * Idempotent: on resume/refresh the existing session is reused and its
   * current pane id re-read. It never kills the session.
   */
  async ensureSession(options: EnsureSessionOptions): Promise<EnsureSessionResult> {
    if (!isSafeSessionName(options.name)) {
      return { ok: false, stage: "name", message: `unsafe session name: ${options.name}` };
    }
    let created = false;
    const existing = await this.run(hasSessionCmd(options.name));
    if (!existing.ok) {
      const primary = await this.run(
        newSessionCmd({
          name: options.name,
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          placeholder: options.placeholder,
        }),
      );
      if (!primary.ok) {
        const fallback = await this.run(
          newSessionCmd({
            name: options.name,
            cwd: options.cwd,
            cols: options.cols,
            rows: options.rows,
            placeholder: FALLBACK_PLACEHOLDER_CMD,
          }),
        );
        if (!fallback.ok) {
          return {
            ok: false,
            stage: "new-session",
            message: `${primary.stderr || primary.stdout || fallback.stderr || "new-session failed"}`,
          };
        }
      }
      created = true;
    }

    if (isSafeLayout(options.layout)) {
      // Cosmetic; a layout failure must not block the launch.
      await this.run(selectLayoutCmd(options.name, options.layout));
    }

    const paneRes = await this.run(displayPaneIdCmd(options.name));
    const paneId = parsePaneId(paneRes.stdout);
    if (!paneId) {
      return { ok: false, stage: "pane-id", message: paneRes.stderr || "no pane id for session" };
    }

    const socketRes = await this.run(displaySocketPathCmd());
    const socketPath = parseSocketPath(socketRes.stdout);
    if (!socketPath) {
      return { ok: false, stage: "socket", message: socketRes.stderr || "no tmux socket path" };
    }

    // Best effort: a namespace may hide the pid, and Amos does not validate it.
    const pidRes = await this.run(displayServerPidCmd());
    const serverPid = parseServerPid(pidRes.stdout);

    return { ok: true, handle: { paneId, socketPath, serverPid, created } };
  }

  async sessionExists(name: string): Promise<boolean> {
    if (!isSafeSessionName(name)) return false;
    return (await this.run(hasSessionCmd(name))).ok;
  }

  async listPanes(name: string): Promise<TmuxPane[]> {
    if (!isSafeSessionName(name)) return [];
    const res = await this.run(listPanesCmd(name));
    return res.ok ? parsePaneRows(res.stdout) : [];
  }

  async capturePane(paneId: string, lines: number): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    return this.run(capturePaneCmd(paneId, lines));
  }

  /**
   * Arm `pipe-pane` for one pane. tmux keeps the pipe on the pane rather than in
   * this process, so the caller arms once per pane and only re-arms when the log
   * disappears.
   */
  async pipePane(paneId: string, path: string): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    if (!isSafePaneLogPath(path)) {
      return { ok: false, stdout: "", stderr: `unsafe pipe log path: ${path}` };
    }
    return this.run(pipePaneCmd(paneId, path));
  }

  async stopPipePane(paneId: string): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    return this.run(pipePaneStopCmd(paneId));
  }

  async selectPane(paneId: string): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    return this.run(selectPaneCmd(paneId));
  }

  async killPane(paneId: string): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    return this.run(killPaneCmd(paneId));
  }

  /**
   * Type into a pane. The literal payload and the optional Enter are two calls:
   * folding Enter into the `-l` call would type the letters "Enter".
   */
  async sendText(paneId: string, text: string, enter: boolean): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    if (text.length === 0) {
      return { ok: false, stdout: "", stderr: "empty text" };
    }
    const typed = await this.run(sendKeysLiteralCmd(paneId, text));
    if (!typed.ok) return typed;
    if (!enter) return typed;
    return this.run(sendKeyCmd(paneId, "Enter"));
  }

  async sendKey(paneId: string, key: string): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    if (!TMUX_KEY_NAMES.includes(key)) {
      return { ok: false, stdout: "", stderr: `key not allowed: ${key}` };
    }
    return this.run(sendKeyCmd(paneId, key));
  }

  /** Only ever called with a name produced by `sessionNameFor`. */
  async killSession(name: string): Promise<TmuxRunResult> {
    if (!isSafeSessionName(name)) {
      return { ok: false, stdout: "", stderr: `unsafe session name: ${name}` };
    }
    return this.run(killSessionCmd(name));
  }
}
